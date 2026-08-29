const { app, BrowserWindow, globalShortcut, ipcMain, screen, shell } = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { startLocalApi } = require("./local-api.cjs");

const STARTUP_TIMEOUT_MS = 180000;
const isMcpProcess = process.argv.includes("--mcp");

if (isMcpProcess) app.disableHardwareAcceleration();

let mainWindow;
let quickWindow;
let quickAccelerator = null;
let startupPromise;
let localApiRuntime;
let webProcess;
let webBaseUrl = "";

function developmentIconPath() {
  const filename = process.platform === "win32"
    ? "icon.ico"
    : process.platform === "darwin" ? "icon.icns" : "icon.png";
  return path.join(__dirname, "..", "build", filename);
}

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
    void loadQuickWindow().catch(() => undefined);
  })();

  try {
    await startupPromise;
  } catch (error) {
    await stopServices();
    startupPromise = undefined;
    sendStatus("error", error instanceof Error ? error.message : String(error));
  }
}

/* ── Quick search ─────────────────────────────────────────────────────
   The overlay is the product's reason to exist: somebody in another
   application remembers they understood a thing once, and the cost of
   getting it back has to be a keystroke. Anything that makes them open the
   cabinet first has already lost — they will use a search engine instead.

   So the window is built once and then shown and hidden, never closed. A
   window created on demand takes long enough that the keystroke feels like
   it did nothing, and the target is 150ms. */

const QUICK_ACCELERATORS = ["CommandOrControl+Shift+K", "CommandOrControl+Alt+K"];

function createQuickWindow() {
  quickWindow = new BrowserWindow({
    width: 680,
    height: 460,
    show: false,
    frame: false,
    resizable: false,
    movable: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    backgroundColor: "#f3f0e9",
    ...(app.isPackaged ? {} : { icon: developmentIconPath() }),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.cjs"),
      // The overlay spends nearly all its life hidden, and Chromium throttles
      // timers in a window that is not on screen. That is normally the right
      // trade; here it is the one thing that would make the first keystroke
      // after the shortcut feel dead, which is the whole thing this window
      // exists to avoid.
      backgroundThrottling: false,
    },
  });

  // Losing focus is a dismissal. Somebody who clicked back into their editor
  // has already moved on, and an overlay left floating over their work is the
  // opposite of getting out of the way.
  quickWindow.on("blur", () => quickWindow?.hide());
  quickWindow.on("closed", () => {
    quickWindow = undefined;
  });
  return quickWindow;
}

/**
 * Load the overlay's page as soon as the frontend is up.
 *
 * Separate from creating the window because the window exists long before
 * there is a URL to put in it, and because a reader who presses the shortcut
 * during startup should get the overlay a moment later rather than an error.
 */
async function loadQuickWindow() {
  if (!webBaseUrl) return;
  if (!quickWindow || quickWindow.isDestroyed()) createQuickWindow();
  if (quickWindow.webContents.getURL().startsWith(`${webBaseUrl}/quick`)) return;
  await quickWindow.loadURL(`${webBaseUrl}/quick`);
}

async function toggleQuickWindow() {
  if (quickWindow && !quickWindow.isDestroyed() && quickWindow.isVisible()) {
    quickWindow.hide();
    return;
  }
  await loadQuickWindow();
  if (!quickWindow || quickWindow.isDestroyed()) return;
  // Follow the screen the cursor is on. A fixed position puts the overlay on
  // the wrong monitor for anyone with two of them.
  const cursor = screen.getCursorScreenPoint();
  const area = screen.getDisplayNearestPoint(cursor).workArea;
  const [width] = quickWindow.getSize();
  quickWindow.setPosition(
    Math.round(area.x + (area.width - width) / 2),
    Math.round(area.y + Math.min(area.height * 0.22, 180)),
  );
  quickWindow.show();
  quickWindow.focus();
}

/**
 * Claim the accelerator, and be honest when it cannot be claimed.
 *
 * A global shortcut is first-come-first-served across the whole machine, so
 * another application may already hold it. Electron reports that by returning
 * false rather than by throwing, which is easy to ignore — and ignoring it
 * ships an app whose headline feature silently does nothing. The fallback is
 * tried next, and what actually got registered is what the interface is told.
 */
function registerQuickShortcut() {
  for (const accelerator of QUICK_ACCELERATORS) {
    if (globalShortcut.isRegistered(accelerator)) continue;
    if (globalShortcut.register(accelerator, () => void toggleQuickWindow())) {
      quickAccelerator = accelerator;
      return accelerator;
    }
  }
  quickAccelerator = null;
  return null;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1024,
    minHeight: 720,
    backgroundColor: "#f3f0e9",
    show: false,
    // Packaged builds take the icon from their app bundle. This only matters
    // for `npm run desktop:dev`, which would otherwise show Electron's logo.
    ...(app.isPackaged ? {} : { icon: developmentIconPath() }),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.cjs"),
    },
  });

  // A card's source link points anywhere on the web. Opened in here it would
  // load inside a window that has the preload bridges attached and no address
  // bar to say where it went; opened in the browser it is just a link. Only
  // http(s) is followed — the runtime already refuses to store anything else,
  // and this is the second place that has to be true.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//iu.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.loadFile(path.join(__dirname, "splash.html"));
  mainWindow.on("closed", () => {
    mainWindow = undefined;
  });
}

ipcMain.handle("quick:close", () => quickWindow?.hide());
ipcMain.handle("quick:shortcut", () => quickAccelerator);
/**
 * Hand a card to the cabinet.
 *
 * The overlay deliberately cannot open a card by itself: one window that reads
 * and one that edits is the split, and duplicating the viewer here would mean
 * two of everything for the sake of a case the reader can already reach.
 */
ipcMain.handle("quick:open-card", async (_event, id) => {
  quickWindow?.hide();
  if (!webBaseUrl) return;
  if (!mainWindow || mainWindow.isDestroyed()) createWindow();
  await mainWindow.loadURL(`${webBaseUrl}/collection?card=${encodeURIComponent(id)}`);
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

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
    createQuickWindow();
    registerQuickShortcut();
    startServices();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("window-all-closed", () => {
    // The hidden overlay is a window, so this only fires once it is gone too.
    if (process.platform !== "darwin") app.quit();
  });

  app.on("before-quit", () => {
    globalShortcut.unregisterAll();
    void stopServices();
  });
}
