const { app, BrowserWindow, ipcMain, shell } = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { startLocalApi } = require("./local-api.cjs");

const STARTUP_TIMEOUT_MS = 180000;
const isMcpProcess = process.argv.includes("--mcp");

if (isMcpProcess) app.disableHardwareAcceleration();

let mainWindow;
let startupPromise;
let localApiRuntime;
let webProcess;
let webBaseUrl = "";

function webRuntimeDirectory() {
  return app.isPackaged
    ? path.join(process.resourcesPath, "kcc-web")
    : path.resolve(__dirname, "..");
}

/** Sample cards, shipped inside the app and only loaded when asked for. */
function seedPath() {
  return path.join(__dirname, "seed.json");
}

/**
 * Where the cabinet's cards live.
 *
 * Documents rather than the hidden AppData folder: this is the user's own
 * content, they should be able to find it, back it up, or drop it in a synced
 * folder without hunting through %APPDATA%. Model files stay in AppData because
 * they are a re-downloadable cache, not something worth backing up.
 */
function dataDirectory() {
  if (process.env.KCC_DATA_DIR) return process.env.KCC_DATA_DIR;
  return path.join(app.getPath("documents"), "知識卡冊");
}

/** The pre-Documents location, kept only so existing cabinets can be found. */
function legacyDataDirectory() {
  return path.join(app.getPath("userData"), "data");
}

/**
 * Move an existing cabinet to the Documents folder the first time the app runs
 * after the default changed. The old copy is left where it was: if anything
 * about this is wrong, the data is still sitting there.
 */
function adoptLegacyData(target) {
  const legacy = legacyDataDirectory();
  if (!fs.existsSync(legacy) || fs.existsSync(path.join(target, "cards.db"))) return;

  const carried = ["cards.db", "cards.db-wal", "cards.db-shm", "cards.json"]
    .filter((name) => fs.existsSync(path.join(legacy, name)));
  if (carried.length === 0) return;

  fs.mkdirSync(target, { recursive: true });
  for (const name of carried) fs.copyFileSync(path.join(legacy, name), path.join(target, name));
  fs.writeFileSync(
    path.join(legacy, "MOVED.txt"),
    `這個資料夾的卡片已於 ${new Date().toISOString()} 複製到：\n${target}\n\n`
    + "程式現在讀取上面那個位置。這裡的檔案保留作為備份，確認新位置沒問題後即可刪除。\n",
    "utf8",
  );
}

function runtimeManifestPath() {
  return path.join(app.getPath("appData"), "Knowledge Card Cabinet", "runtime.json");
}

function writeRuntimeManifest(runtime) {
  const manifestPath = runtimeManifestPath();
  const temporaryPath = `${manifestPath}.tmp`;
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(temporaryPath, `${JSON.stringify({
    version: 1,
    base_url: runtime.baseUrl,
    api_base_url: `${runtime.baseUrl}/api/v1`,
    token: runtime.authToken,
    pid: process.pid,
    started_at: new Date().toISOString(),
  }, null, 2)}\n`, "utf8");
  fs.renameSync(temporaryPath, manifestPath);
}

function removeRuntimeManifest() {
  try {
    fs.unlinkSync(runtimeManifestPath());
  } catch (error) {
    if (error?.code !== "ENOENT") console.warn("無法清理本機 AI runtime manifest：", error);
  }
}

function sendStatus(status, detail = "") {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("desktop:status", { status, detail });
  }
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

async function waitForHealth(healthUrl) {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(healthUrl, { cache: "no-store" });
      if (response.ok) return;
    } catch {
      // The embedded standalone server may still be starting; keep polling.
    }

    await new Promise((resolve) => setTimeout(resolve, 1500));
  }

  throw new Error("等待本機前端服務逾時，請重新啟動應用程式。");
}

async function startWebServer(apiBaseUrl) {
  const runtime = webRuntimeDirectory();
  const serverPath = path.join(runtime, "dist", "standalone", "server.js");
  if (!fs.existsSync(serverPath)) {
    throw new Error("找不到前端 runtime，請先重新建立或安裝桌面應用程式。");
  }

  const port = await getFreePort();
  webProcess = spawn(process.execPath, [serverPath], {
    cwd: runtime,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      NODE_ENV: "production",
      API_INTERNAL_URL: apiBaseUrl,
      API_INTERNAL_TOKEN: localApiRuntime.authToken,
      PORT: String(port),
      HOST: "127.0.0.1",
    },
  });

  let output = "";
  webProcess.stdout.on("data", (chunk) => {
    output = `${output}${chunk}`.slice(-3000);
  });
  webProcess.stderr.on("data", (chunk) => {
    output = `${output}${chunk}`.slice(-3000);
  });
  webProcess.once("error", (error) => {
    output = `${output}${error.message}`.slice(-3000);
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForHealth(`${baseUrl}/api/health`).catch((error) => {
    if (output.trim()) error.message = `${error.message}\n${output.trim()}`;
    throw error;
  });
  return baseUrl;
}

async function stopServices() {
  if (webProcess && !webProcess.killed) {
    webProcess.kill();
  }
  webProcess = undefined;
  if (localApiRuntime) {
    await localApiRuntime.close().catch(() => undefined);
  }
  localApiRuntime = undefined;
  webBaseUrl = "";
  removeRuntimeManifest();
}

async function startServices() {
  if (startupPromise) return startupPromise;

  startupPromise = (async () => {
    sendStatus("checking", "正在準備本機資料空間…");
    removeRuntimeManifest();
    const dataDir = dataDirectory();
    // Only the default location inherits the old cabinet. Someone who names a
    // directory explicitly is asking for that directory, not for a copy of
    // whatever happened to be in AppData.
    if (!process.env.KCC_DATA_DIR) adoptLegacyData(dataDir);
    localApiRuntime = await startLocalApi({
      dataFile: path.join(dataDir, "cards.json"),
      // Models are a cache, so they stay out of the user's Documents folder.
      modelsDir: process.env.KCC_MODELS_DIR || path.join(app.getPath("userData"), "models"),
      seedPath: seedPath(),
      migrateFromUrl: process.env.KCC_LEGACY_API_URL || "",
      migrateFromToken: process.env.KCC_LEGACY_API_TOKEN || process.env.KCC_API_TOKEN || "",
    });
    writeRuntimeManifest(localApiRuntime);

    sendStatus("starting", "正在啟動本機前端服務…");
    webBaseUrl = await startWebServer(localApiRuntime.baseUrl);
    sendStatus("ready", "準備完成");
    await mainWindow.loadURL(`${webBaseUrl}/collection`);
  })();

  try {
    await startupPromise;
  } catch (error) {
    await stopServices();
    startupPromise = undefined;
    sendStatus("error", error instanceof Error ? error.message : String(error));
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1024,
    minHeight: 720,
    backgroundColor: "#f3f0e9",
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.cjs"),
    },
  });

  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.loadFile(path.join(__dirname, "splash.html"));
  mainWindow.on("closed", () => {
    mainWindow = undefined;
  });
}

ipcMain.handle("desktop:retry", () => startServices());
// The API's port is chosen at startup, so there is nothing sensible to open
// before it is running.
ipcMain.handle("desktop:open-docs", () => (localApiRuntime ? shell.openExternal(`${localApiRuntime.baseUrl}/docs`) : undefined));
ipcMain.handle("desktop:data-dir", () => dataDirectory());
ipcMain.handle("desktop:open-data-dir", () => shell.openPath(dataDirectory()));

if (isMcpProcess) {
  require("./mcp-server.cjs");
} else {
  app.whenReady().then(() => {
    createWindow();
    startServices();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  app.on("before-quit", () => {
    void stopServices();
  });
}
