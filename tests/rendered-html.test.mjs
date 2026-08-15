import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

const { startLocalApi } = await import("../desktop/local-api.cjs");
const require = createRequire(import.meta.url);
const { createTaskManager } = require("../desktop/task-manager.cjs");

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
  assert.match(collectionHtml, /設定/);
  assert.match(collectionHtml, /卡片視圖/);
  assert.match(collectionHtml, /關聯圖視圖/);
  assert.match(collectionHtml, /資料表視圖/);
});

test("local API exposes separate summary and embedding model choices", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "kcc-model-api-test-"));
  const runtime = await startLocalApi({
    dataFile: join(root, "cards.json"),
    modelsDir: join(root, "models"),
    seedPath: join(projectRoot, "desktop", "seed.json"),
    migrateFromUrl: "",
  });
  context.after(async () => {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  });

  const auth = { Authorization: `Bearer ${runtime.authToken}` };

  const response = await fetch(`${runtime.baseUrl}/models`, { headers: auth });
  assert.equal(response.status, 200);
  const catalog = await response.json();
  assert.ok(catalog.hardware.memory_gb > 0);
  assert.ok(catalog.models.some((model) => model.kind === "summary" && model.id === "summary-template"));
  assert.ok(catalog.models.some((model) => model.kind === "summary" && model.model_id === "Xenova/LaMini-Flan-T5-248M"));
  assert.ok(catalog.models.some((model) => model.kind === "embedding" && model.model_id === "Xenova/paraphrase-multilingual-MiniLM-L12-v2"));
  assert.ok(catalog.storage.free_bytes > 0);
  const builtinInspection = await fetch(`${runtime.baseUrl}/models/embedding-hash-384/inspect`, { headers: auth });
  assert.equal(builtinInspection.status, 200);
  assert.equal((await builtinInspection.json()).status, "ready");

  const health = await (await fetch(`${runtime.baseUrl}/health`)).json();
  assert.equal(health.embedding_model, "embedding-hash-384");
  assert.equal(health.summary_model, "summary-template");

  const settingsResponse = await fetch(`${runtime.baseUrl}/settings`, { headers: auth });
  assert.equal(settingsResponse.status, 200);
  const settings = await settingsResponse.json();
  assert.equal(settings.embedding.dimensions, 384);
  assert.equal(Object.hasOwn(settings.embedding, "api_key"), false);

  const invalidSettings = await fetch(`${runtime.baseUrl}/settings`, {
    method: "PUT",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({
      summary: { source: "api", api_url: "", model: "", api_format: "openai", api_key: "" },
      embedding: { source: "local", api_url: "", model: "", api_format: "openai", api_key: "" },
    }),
  });
  assert.equal(invalidSettings.status, 400);

  const notDownloaded = await fetch(`${runtime.baseUrl}/models/select`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "embedding", model_id: "embedding-minilm-384" }),
  });
  assert.equal(notDownloaded.status, 409);
});

test("local API exposes background task status routes", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "kcc-task-api-test-"));
  const runtime = await startLocalApi({
    dataFile: join(root, "cards.json"),
    modelsDir: join(root, "models"),
    seedPath: join(projectRoot, "desktop", "seed.json"),
    migrateFromUrl: "",
  });
  context.after(async () => {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  });

  const rootResponse = await fetch(`${runtime.baseUrl}/api/v1/`, {
    headers: { Authorization: `Bearer ${runtime.authToken}` },
  });
  const info = await rootResponse.json();
  assert.equal(rootResponse.status, 200);
  assert.ok(info.capabilities.includes("tasks"));

  const tasksResponse = await fetch(`${runtime.baseUrl}/api/v1/tasks`, {
    headers: { Authorization: `Bearer ${runtime.authToken}` },
  });
  assert.equal(tasksResponse.status, 200);
  assert.deepEqual(await tasksResponse.json(), []);

  const missingTask = await fetch(`${runtime.baseUrl}/api/v1/tasks/not-found`, {
    headers: { Authorization: `Bearer ${runtime.authToken}` },
  });
  assert.equal(missingTask.status, 404);
});

test("local API enforces auth and validates versioned backups", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "kcc-secure-api-test-"));
  const runtime = await startLocalApi({
    dataFile: join(root, "cards.json"),
    modelsDir: join(root, "models"),
    seedPath: join(projectRoot, "desktop", "seed.json"),
    migrateFromUrl: "",
    // A fresh cabinet is empty, and this test needs a card to tamper with.
    loadSeed: true,
  });
  context.after(async () => {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  });

  const unauthorized = await fetch(`${runtime.baseUrl}/cards`);
  assert.equal(unauthorized.status, 401);
  const auth = { Authorization: `Bearer ${runtime.authToken}` };
  const exported = await (await fetch(`${runtime.baseUrl}/database/export`, { headers: auth })).json();
  assert.equal(exported.format_version, 2);
  assert.equal(typeof exported.checksum_sha256, "string");
  exported.cards[0].title = "tampered";
  const tampered = await fetch(`${runtime.baseUrl}/database/import`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify(exported),
  });
  assert.equal(tampered.status, 400);
  await access(join(root, "audit.jsonl"));
});

test("desktop task history persists and supports cancellation", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "kcc-task-manager-test-"));
  const storagePath = join(root, "tasks.json");
  const manager = createTaskManager({ storagePath });
  context.after(async () => {
    await manager.close();
    await rm(root, { recursive: true, force: true });
  });

  const task = manager.start("smoke", "取消測試", async () => new Promise((resolve) => setTimeout(() => resolve({ ok: true }), 500)), {
    retryPayload: { kind: "smoke" },
  });
  await new Promise((resolve) => setTimeout(resolve, 40));
  const cancelled = await manager.cancel(task.task_id);
  assert.equal(cancelled.status, "cancelled");

  const restored = createTaskManager({ storagePath });
  const history = restored.list();
  assert.equal(history[0].task_id, task.task_id);
  assert.equal(history[0].can_retry, true);
  await restored.close();
});

test("desktop packaging points to the local runtime", async () => {
  const main = await readFile(new URL("../desktop/main.cjs", import.meta.url), "utf8");
  const builder = await readFile(new URL("../desktop/electron-builder.yml", import.meta.url), "utf8");
  const localApi = new URL("../desktop/local-api.cjs", import.meta.url);

  await access(localApi);
  assert.match(main, /startLocalApi/);
  assert.match(main, /modelsDir/);
  assert.match(main, /ELECTRON_RUN_AS_NODE/);
  assert.doesNotMatch(main, /docker compose|Docker Desktop/);
  assert.match(builder, /kcc-web\/dist/);
  // seed.json now ships inside the asar with the rest of desktop/, so it is
  // deliberately no longer an extraResource.
  assert.doesNotMatch(builder, /kcc-data/);
  assert.match(builder, /asarUnpack:[\s\S]*onnxruntime-node/);
  assert.match(builder, /asarUnpack:[\s\S]*onnxruntime-common/);
  assert.match(builder, /asarUnpack:[\s\S]*sharp/);
  assert.doesNotMatch(builder, /kcc-runtime|docker-compose/);
  // Without an icon the installer and the .exe ship Electron's default logo,
  // which is the first thing anyone downloading a release would notice.
  assert.match(builder, /icon: build\/icon\.ico/);
  await access(new URL("../build/icon.ico", import.meta.url));
  const modelRuntime = await readFile(new URL("../desktop/model-runtime.cjs", import.meta.url), "utf8");
  const desktopPackage = JSON.parse(await readFile(new URL("../desktop/package.json", import.meta.url), "utf8"));
  assert.match(modelRuntime, /@huggingface\/transformers/);
  assert.match(modelRuntime, /app\.asar\.unpacked/);
  // The desktop package must not pull the whole web project in as a dependency;
  // it consumes the built frontend, not its sources.
  assert.equal(desktopPackage.dependencies["knowledge-card-cabinet"], undefined);
});

test("the README only documents scripts that exist", async () => {
  // Documentation is the one part of the project no other test covers, so it
  // quietly fell behind the code more than once.
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const readmes = await Promise.all(
    ["../README.md", "../desktop/README.md"].map((file) => readFile(new URL(file, import.meta.url), "utf8")),
  );

  const documented = new Set(
    readmes.flatMap((text) => [...text.matchAll(/npm run ([a-z][a-z:]*)/g)].map((match) => match[1])),
  );
  assert.ok(documented.size > 0);
  for (const script of documented) {
    assert.ok(manifest.scripts[script], `README documents "npm run ${script}", which package.json does not define`);
  }

  assert.equal(manifest.license, "MIT");
  await access(new URL("../LICENSE", import.meta.url));
});

test("the card back bounds its copy as one region", async () => {
  // Clamping the summary and the elaboration separately capped each paragraph
  // but never their sum, so a long card overflowed the panel and the clip cut
  // through the middle of a line. They have to share one bounded region.
  const cardFace = await readFile(new URL("../app/card-face.tsx", import.meta.url), "utf8");
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

  const region = cardFace.match(/collection-card__plain-copy[\s\S]*?<\/span>/);
  assert.ok(region, "the card back no longer wraps its copy in a bounded region");
  assert.match(region[0], /collection-card__plain-lead/);
  assert.match(region[0], /collection-card__plain-body/);

  const rules = css.match(/\.collection-card__plain-copy \{([\s\S]*?)\n\}/);
  assert.ok(rules, "globals.css no longer styles the card back's copy region");
  assert.match(rules[1], /overflow:\s*hidden/);
  assert.match(rules[1], /min-height:\s*0/);
  // The fade is what turns an unavoidable cut into something that reads as
  // deliberate rather than as a broken card.
  assert.match(rules[1], /mask-image:\s*linear-gradient/);
});

test("collection success notices are transient", async () => {
  const collectionPage = await readFile(new URL("../app/collection/page.tsx", import.meta.url), "utf8");

  assert.match(collectionPage, /window\.setTimeout\(\(\) => \{/);
  assert.match(collectionPage, /setCreateSuccess\(""\)/);
  assert.match(collectionPage, /window\.clearTimeout\(timeoutId\)/);
});
