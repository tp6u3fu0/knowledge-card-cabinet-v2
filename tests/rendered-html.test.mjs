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
  // Which embedding a fresh cabinet starts on depends on whether this build
  // bundled weights (see tests/model-catalogue.test.mjs); either way it is a
  // 384-dim model, and summaries always start on the rule-based template.
  assert.ok(["embedding-hash-384", "embedding-multilingual-384"].includes(health.embedding_model), health.embedding_model);
  assert.equal(health.embedding_dimensions, 384);
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
  // macOS uses ICNS rather than ICO; both architecture-specific artifacts are
  // built on native macOS runners during a tagged release.
  assert.match(builder, /mac:[\s\S]*icon: build\/icon\.icns/);
  await access(new URL("../build/icon.icns", import.meta.url));
  const releaseWorkflow = await readFile(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
  assert.match(releaseWorkflow, /macos-13/);
  assert.match(releaseWorkflow, /macos-14/);
  assert.match(releaseWorkflow, /--mac --arm64/);
  const afterPack = await readFile(new URL("../desktop/after-pack.cjs", import.meta.url), "utf8");
  assert.match(afterPack, /electronPlatformName === "darwin"/);
  assert.match(afterPack, /Contents[\s\S]*Resources/);
  assert.match(afterPack, /await createPackage\(temporaryDirectory, asarPath\)/);
  assert.doesNotMatch(afterPack, /archiveStream\.once/);
  const modelRuntime = await readFile(new URL("../desktop/model-runtime.cjs", import.meta.url), "utf8");
  const desktopPackage = JSON.parse(await readFile(new URL("../desktop/package.json", import.meta.url), "utf8"));
  assert.match(modelRuntime, /@huggingface\/transformers/);
  assert.match(modelRuntime, /app\.asar\.unpacked/);
  // The desktop package must not pull the whole web project in as a dependency;
  // it consumes the built frontend, not its sources.
  assert.equal(desktopPackage.dependencies["knowledge-card-cabinet"], undefined);
});

test("the docs only reference scripts and files that exist", async () => {
  // Documentation is the one part of the project no other test covers, so it
  // quietly fell behind the code more than once.
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const docs = ["../README.md", "../desktop/README.md", "../CLAUDE.md"];
  const readmes = await Promise.all(docs.map((file) => readFile(new URL(file, import.meta.url), "utf8")));

  // CLAUDE.md points at specific source files as the reason for its rules; a
  // rule whose file has moved is worse than no rule, because it reads as
  // authoritative.
  const guide = readmes[docs.indexOf("../CLAUDE.md")];
  const referenced = new Set(
    [...guide.matchAll(/`((?:desktop|app|scripts|tests)\/[\w./[\]-]+?\.(?:cjs|mjs|tsx?|css|yml|json))`/gu)].map((match) => match[1]),
  );
  assert.ok(referenced.size > 5, `CLAUDE.md referenced only ${referenced.size} source files`);
  for (const file of referenced) {
    await access(new URL(`../${file}`, import.meta.url));
  }

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

test("a carried card is measured before its deck slot is flattened", async () => {
  // The fanned position of a card is a transform on its deck slot, and a
  // transformed ancestor is the containing block for anything fixed inside it.
  // Measure first, then flatten: the other order pins the card to the slot and
  // it drifts away from the pointer by exactly the fan offset.
  const drag = await readFile(new URL("../app/collection/card-drag.ts", import.meta.url), "utf8");
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

  const lift = drag.match(/const lift = \(\) => \{([\s\S]*?)\n {6}\};/);
  assert.ok(lift, "card-drag no longer has a lift step");
  const measured = lift[1].indexOf("getBoundingClientRect");
  const flattened = lift[1].indexOf('holder.style.transform = "none"');
  assert.ok(measured >= 0 && flattened > measured, "the card is flattened before it is measured");
  assert.match(lift[1], /position = "fixed"/);

  // The rule that makes the flattening necessary, so this stays connected.
  const item = css.match(/\.card-deck__item \{([\s\S]*?)\n\}/);
  assert.ok(item, "globals.css no longer positions the cards in a deck");
  assert.match(item[1], /transform:/);
});

test("the deck's fan is measured rather than written as a percentage", async () => {
  // A percentage inside translate() resolves against the card being moved, not
  // the row it moves along, so the step came out as zero and the deck silently
  // never opened.
  const deck = await readFile(new URL("../app/collection/setting-cards.tsx", import.meta.url), "utf8");
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

  assert.match(deck, /new ResizeObserver\(measure\)/);
  assert.match(deck, /"--fan": `\$\{fan\}px`/);
  const rules = css.match(/\.card-deck \{([\s\S]*?)\n\}/);
  assert.ok(rules, "globals.css no longer styles a deck");
  assert.doesNotMatch(rules[1], /--fan:[^;]*%/, "the fan step is a percentage again");

  // Dropping is a shortcut, never the only way in: the click path is what
  // keyboards and screen readers use.
  assert.match(deck, /onClick=\{onClick\}/);
  assert.doesNotMatch(deck, /draggable=/, "the browser's drag image is back");
});

test("the settings page keeps its explanations smaller than its controls", async () => {
  const panels = await readFile(new URL("../app/collection/panels.tsx", import.meta.url), "utf8");
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

  // A glossary entry used to be a full flip card with a hint above and a toggle
  // below — on the data tab, three times the size of the button it explained.
  assert.doesNotMatch(panels, /glossary-card__shell/, "the glossary is back to full-size flip cards");
  const note = css.match(/\.glossary-note \{([\s\S]*?)\n\}/);
  assert.ok(note, "globals.css no longer styles a glossary note");
  // The thumbnail is the card cover art, which reads its colours from variables
  // that only .collection-card sets; without them it renders transparent.
  assert.match(note[1], /--cover-color:/);

  // The banner's title rule was also catching <strong> inside its paragraph,
  // which put two words of a sentence in 22px serif.
  assert.match(css, /\.settings-api-intro > strong \{/);
  assert.doesNotMatch(css, /\.settings-api-intro strong \{/);

  // Labels that belong to the fan cannot be legible while the deck is closed:
  // they would all sit on the same spot.
  const tier = css.match(/\.card-deck__item \.model-card-wall__tier \{([\s\S]*?)\n\}/);
  assert.ok(tier, "the deck's size labels are visible while the pile is closed");
  assert.match(tier[1], /opacity:\s*0/);
});

test("the API form says whether there is anything to save", async () => {
  const panels = await readFile(new URL("../app/collection/panels.tsx", import.meta.url), "utf8");
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

  assert.match(panels, /const hasUnsavedSettings =/);
  assert.match(panels, /disabled=\{isSettingsSaving \|\| isBackgroundTaskRunning \|\| !hasUnsavedSettings\}/);
  // The form is three screens tall; the button has to travel with the reader.
  const actions = css.match(/\.settings-api-actions \{[\s\S]*?position: sticky;[\s\S]*?\n\}/);
  assert.ok(actions, "the save bar no longer follows the form");
});
