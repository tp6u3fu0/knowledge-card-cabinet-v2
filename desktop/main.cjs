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

function seedPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, "kcc-data", "seed.json")
    : path.join(__dirname, "..", "backend", "seed.json");
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
    const dataFile = path.join(app.getPath("userData"), "data", "cards.json");
    localApiRuntime = await startLocalApi({
      dataFile,
      modelsDir: path.join(app.getPath("userData"), "models"),
      seedPath: seedPath(),
      migrateFromUrl: process.env.KCC_LEGACY_API_URL || "http://127.0.0.1:8000",
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
ipcMain.handle("desktop:open-docs", () => shell.openExternal(`${localApiRuntime?.baseUrl || "http://127.0.0.1:8000"}/docs`));

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
