import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import test from "node:test";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));

function getFreePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

async function startStandaloneServer() {
  const port = await getFreePort();
  const child = spawn(process.execPath, ["dist/standalone/server.js"], {
    cwd: projectRoot,
    env: {
      ...process.env,
      API_INTERNAL_URL: "http://127.0.0.1:9",
      HOST: "127.0.0.1",
      NODE_ENV: "production",
      PORT: String(port),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });

  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) return { child, port };
    } catch {
      // The standalone server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  child.kill();
  throw new Error(`standalone server did not start: ${output}`);
}

test("standalone server renders the knowledge card pages", async (context) => {
  const runtime = await startStandaloneServer();
  context.after(() => runtime.child.kill());

  const health = await fetch(`http://127.0.0.1:${runtime.port}/api/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: "ok", service: "web" });

  const home = await fetch(`http://127.0.0.1:${runtime.port}/`);
  assert.equal(home.status, 200);
  assert.match(await home.text(), /知識卡冊/);

  const collection = await fetch(`http://127.0.0.1:${runtime.port}/collection`);
  assert.equal(collection.status, 200);
  const collectionHtml = await collection.text();
  assert.match(collectionHtml, /收藏瀏覽/);
  assert.match(collectionHtml, /卡片視圖/);
  assert.match(collectionHtml, /關聯圖視圖/);
  assert.match(collectionHtml, /資料表視圖/);
});

test("desktop packaging points to the local runtime", async () => {
  const main = await readFile(new URL("../desktop/main.cjs", import.meta.url), "utf8");
  const builder = await readFile(new URL("../desktop/electron-builder.yml", import.meta.url), "utf8");
  const localApi = new URL("../desktop/local-api.cjs", import.meta.url);

  await access(localApi);
  assert.match(main, /startLocalApi/);
  assert.match(main, /ELECTRON_RUN_AS_NODE/);
  assert.doesNotMatch(main, /docker compose|Docker Desktop/);
  assert.match(builder, /kcc-web\/dist/);
  assert.match(builder, /kcc-data\/seed\.json/);
  assert.doesNotMatch(builder, /kcc-runtime|docker-compose/);
});
