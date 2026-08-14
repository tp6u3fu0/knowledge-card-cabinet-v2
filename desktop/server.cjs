#!/usr/bin/env node
/**
 * Headless entry point — the same runtime the desktop app uses, without Electron.
 *
 * This is what runs on an always-on box (a Raspberry Pi, say) so a phone or a
 * second machine can reach the cabinet. Electron's main.cjs and this file start
 * exactly the same local API and the same frontend build; the only differences
 * are that nothing draws a window, and that the listening address is a
 * deliberate choice rather than always loopback.
 *
 *   node desktop/server.cjs
 *
 * Environment:
 *   KCC_DATA_DIR    where cards.db, backups and the audit log live
 *   KCC_MODELS_DIR  model cache (defaults to <data>/models)
 *   KCC_HOST        address to serve the UI on (default 127.0.0.1)
 *   KCC_PORT        port to serve the UI on (default 3000)
 *   KCC_API_TOKEN   stable API token; generated per launch when unset
 */

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { startLocalApi } = require("./local-api.cjs");

const DEFAULT_PORT = 3000;
const HEALTH_TIMEOUT_MS = 60_000;

const root = path.resolve(__dirname, "..");
const dataDir = process.env.KCC_DATA_DIR || path.join(root, "data");
const modelsDir = process.env.KCC_MODELS_DIR || path.join(dataDir, "models");
const host = process.env.KCC_HOST || "127.0.0.1";
const port = Number(process.env.KCC_PORT || DEFAULT_PORT);

const isLoopback = host === "127.0.0.1" || host === "localhost" || host === "::1";

function log(message) {
  process.stdout.write(`${new Date().toISOString()} ${message}\n`);
}

async function waitForHealth(url) {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  for (;;) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The frontend has not opened its socket yet.
    }
    if (Date.now() > deadline) throw new Error(`前端在 ${HEALTH_TIMEOUT_MS / 1000} 秒內沒有回應 ${url}`);
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}

function startWebServer(apiBaseUrl, apiToken) {
  const serverPath = path.join(root, "dist", "standalone", "server.js");
  if (!fs.existsSync(serverPath)) {
    throw new Error(`找不到前端 build：${serverPath}\n請先執行 npm run build。`);
  }

  const child = spawn(process.execPath, [serverPath], {
    cwd: root,
    stdio: ["ignore", "inherit", "inherit"],
    env: {
      ...process.env,
      NODE_ENV: "production",
      // The API stays on loopback and is reached server-side by the frontend,
      // so the token never has to travel over the network.
      API_INTERNAL_URL: apiBaseUrl,
      API_INTERNAL_TOKEN: apiToken,
      PORT: String(port),
      HOST: host,
    },
  });
  return child;
}

async function main() {
  fs.mkdirSync(dataDir, { recursive: true });

  const runtime = await startLocalApi({
    dataFile: path.join(dataDir, "cards.json"),
    modelsDir,
    seedPath: path.join(root, "backend", "seed.json"),
    migrateFromUrl: process.env.KCC_LEGACY_API_URL || "",
    migrateFromToken: process.env.KCC_LEGACY_API_TOKEN || "",
    authToken: process.env.KCC_API_TOKEN || "",
  });
  log(`資料庫 ${runtime.databaseFile}`);
  log(`本機 API ${runtime.baseUrl}`);

  const web = startWebServer(runtime.baseUrl, runtime.authToken);
  const url = `http://${isLoopback ? "127.0.0.1" : host}:${port}`;
  await waitForHealth(`${url}/api/health`);
  log(`知識卡冊已就緒 ${url}`);

  if (!isLoopback) {
    // Worth saying plainly: the UI itself has no login. Binding it to the
    // network makes the cabinet readable and writable by anyone who can reach
    // this port, so it belongs behind a private network, not a public one.
    log("警告：介面已對外開放且沒有登入機制，請只在私人網路（例如 VPN）中使用。");
  }

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`收到 ${signal}，正在關閉…`);
    web.kill();
    // Closing the runtime also closes SQLite, which checkpoints the WAL —
    // skipping it on a Pi that loses power is how a store gets left behind.
    await runtime.close();
    process.exit(0);
  };
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => void shutdown(signal));

  web.once("exit", (code) => {
    if (shuttingDown) return;
    log(`前端結束（code ${code}），正在關閉…`);
    void shutdown("web-exit");
  });
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});

module.exports = { waitForHealth };
