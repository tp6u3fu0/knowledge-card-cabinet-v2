import assert from "node:assert/strict";
import { access, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
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
const { BUILTIN_EMBEDDING_MODEL, BUNDLED_EMBEDDING_MODEL, MODEL_CATALOG } = require("../desktop/model-runtime.cjs");
const widthOf = (id) => MODEL_CATALOG.find((model) => model.id === id)?.dimensions;

const projectRoot = fileURLToPath(new URL("../", import.meta.url));

/**
 * The text between two markers, with both ends checked.
 *
 * `slice(indexOf(a), indexOf(b))` reads fine and fails silently. A marker that
 * no longer exists is -1, so the region becomes either one character or the
 * entire rest of the file, and the assertions on it then pass or fail for a
 * reason that has nothing to do with what the test is checking. Deleting one
 * unrelated function did exactly that: a region meant to be forty lines long
 * swallowed a thousand, and the failure named the wrong culprit.
 *
 * Prefer a marker inside the thing being read — its own closing brace — over
 * the name of whatever happens to sit next to it in the file.
 */
function region(source, from, to, label) {
  const start = source.indexOf(from);
  assert.notEqual(start, -1, `${label}: cannot find "${from}"`);
  const end = source.indexOf(to, start + from.length);
  assert.notEqual(end, -1, `${label}: cannot find "${to}" after it`);
  return source.slice(start, end);
}

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

  // There is no front page in the product any more — it is published on its
  // own out of site/. Anyone arriving at the root gets their cards.
  const root = await fetch(`http://127.0.0.1:${runtime.port}/`, { redirect: "manual" });
  assert.equal(root.status, 307);
  assert.equal(root.headers.get("location"), "/collection");

  const collection = await fetch(`http://127.0.0.1:${runtime.port}/collection`);
  assert.equal(collection.status, 200);
  const collectionHtml = await collection.text();
  // Nothing in the product may offer a way back to a page that is not in it.
  // Two links in this header did, and both landed the reader on the page they
  // were already reading.
  assert.doesNotMatch(collectionHtml, /href="\/"/u, "the product still links to a front page it does not ship");
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
  // bundled weights (see tests/model-catalogue.test.mjs). The width follows
  // from that choice — it used to be written out as 384, which was only ever
  // true because both candidates happened to be that wide. Summaries always
  // start on the rule-based template.
  assert.ok([BUILTIN_EMBEDDING_MODEL, BUNDLED_EMBEDDING_MODEL].includes(health.embedding_model), health.embedding_model);
  assert.equal(health.embedding_dimensions, widthOf(health.embedding_model));
  assert.equal(health.summary_model, "summary-template");

  const settingsResponse = await fetch(`${runtime.baseUrl}/settings`, { headers: auth });
  assert.equal(settingsResponse.status, 200);
  const settings = await settingsResponse.json();
  assert.equal(settings.embedding.dimensions, widthOf(health.embedding_model));
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
  assert.match(releaseWorkflow, /macos-14/);
  assert.match(releaseWorkflow, /--mac --arm64/);
  // Intel is deliberately not built: that runner queued for most of an hour
  // while the other two were done, for a machine Apple no longer sells.
  assert.doesNotMatch(releaseWorkflow, /macos-13|--mac --x64/u);
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

  // The always-on-host path in the README is a docker build, which nothing
  // else runs. It copied backend/seed.json for months after the Python service
  // was deleted, so the very first COPY failed and the documented command
  // could not have worked for anyone who tried it.
  const dockerfile = await readFile(new URL("../Dockerfile.standalone", import.meta.url), "utf8");
  const copied = [...dockerfile.matchAll(/^COPY (?!--from)(.+?) \S+$/gmu)].flatMap((match) => match[1].trim().split(/\s+/u));
  assert.ok(copied.length > 3, `only found ${copied.length} COPY sources to check`);
  for (const source of copied) {
    if (source.includes("*")) continue;
    await access(new URL(`../${source}`, import.meta.url));
  }
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

  // Putting the slot back is the other half. Its transform is animated, so
  // handing it to CSS while the transition is live sends the slot — and the
  // card that has only just landed in it — travelling from the rail origin all
  // over again. Restore, flush, then re-enable.
  const clear = drag.match(/const clear = \(\) => \{([\s\S]*?)\n {4}\};/u);
  assert.ok(clear, "card-drag no longer cleans up after a carry");
  const restored = clear[1].indexOf('holder.style.removeProperty("transform")');
  const flushed = clear[1].indexOf("void holder.offsetWidth");
  const reenabled = clear[1].indexOf('holder.style.removeProperty("transition")');
  assert.ok(restored >= 0 && flushed > restored, "the slot's position is restored without flushing the style");
  assert.ok(reenabled > flushed, "the slot animates back from the rail origin, dragging the card with it");
});

test("an open deck lays its cards out at full width, measured", async () => {
  // A percentage inside translate() resolves against the card being moved, not
  // the row it moves along, so a computed step came out as zero and the deck
  // silently never opened. And the open layout has to be a wall rather than one
  // long row: eight cards fanned along a single line left each one a sliver of
  // its own right edge, with the title clipped away.
  const deck = await readFile(new URL("../app/collection/setting-cards.tsx", import.meta.url), "utf8");
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

  assert.match(deck, /new ResizeObserver\(measure\)/);
  assert.match(deck, /"--x": `\$\{\(index % layout\.perRow\) \* layout\.step\}px`/);
  assert.match(deck, /"--y": `\$\{Math\.floor\(index \/ layout\.perRow\) \* layout\.rowHeight\}px`/);
  // The step never drops below a card's own width — "no overlap", in one line.
  assert.match(deck, /Math\.max\(cardWidth \+ CARD_GAP_PX, spread\)/);
  const open = css.match(/\.card-deck\.is-open \.card-deck__item \{([\s\S]*?)\n\}/);
  assert.ok(open, "globals.css no longer positions an open deck");
  assert.doesNotMatch(open[1], /%/, "the open positions are percentages again");

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

test("the flip card has an edge that follows its outline", async () => {
  // Turned past about 80 degrees, a card made of two faces at z=0 vanishes into
  // a hairline — and that is exactly the angle someone turns a card to when
  // they want to see how thick it is. The edge used to be four quads standing
  // on the sides, which is the wrong shape for a rounded card: they cut the
  // corners and read as planks growing out of it. Now the card's own outline is
  // repeated across the thickness. (A rule body holds no closing brace, so
  // [^}] is enough to capture one.)
  const cardFace = await readFile(new URL("../app/card-face.tsx", import.meta.url), "utf8");
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

  assert.doesNotMatch(cardFace, /card-flip__edge/u, "the flat side quads are back");
  assert.doesNotMatch(css, /card-flip__edge/u, "the flat side quads are back in the stylesheet");

  // Both faces must sit half a thickness off centre, or the edge sticks out.
  const front = css.match(/\.card-flip__face \{([^}]*)\}/u);
  const back = css.match(/\.card-flip__face--back \{([^}]*)\}/u);
  assert.ok(front && back, "globals.css no longer positions the card's faces");
  assert.match(front[1], /translateZ\(calc\(var\(--card-thickness\) \/ 2\)\)/u);
  assert.match(back[1], /rotateY\(180deg\) translateZ\(calc\(var\(--card-thickness\) \/ 2\)\)/u);

  // The slices carry the same radius as the faces, or the edge shows square
  // corners under a rounded card.
  const slice = css.match(/\.card-flip__slice \{([^}]*)\}/u);
  assert.ok(slice, "globals.css no longer draws the card's edge");
  assert.match(slice[1], /border-radius: var\(--card-radius\)/u, "the edge does not follow the outline");
  assert.match(slice[1], /translateZ\(calc\(var\(--slice-depth[^)]*\) \* var\(--card-thickness\)\)\)/u);
  assert.match(front[1], /border-radius: var\(--card-radius\)/u, "the face and its edge use different radii");

  // Enough layers to close the gaps: at 5px thickness, ten would sit half a
  // pixel apart and the edge would read as a stack of cards.
  const count = cardFace.match(/const EDGE_SLICE_COUNT = (\d+);/u);
  assert.ok(count, "the edge no longer says how many layers it has");
  assert.ok(Number(count[1]) >= 12, `the edge is only ${count[1]} layers thick`);

  // The edge is cut from the same stock as the faces. A grey band stuck to a
  // coloured card reads as packaging, not as the card's own thickness — and the
  // colour variables live on .collection-card, inside a face, so the edge only
  // gets them if FlipCard puts the accent on the inner element itself.
  // Two rules carry this selector — the layout one and the thickness one.
  const inner = css.match(/\.card-flip__inner \{([^}]*--card-thickness[^}]*)\}/u);
  assert.ok(inner, "globals.css no longer sets up the card's thickness");
  assert.match(inner[1], /--card-stock:[^;]*var\(--domain-soft/u, "the edge is not cut from the card's own colour");
  assert.match(slice[1], /background: color-mix\([^;]*var\(--card-stock\)/u, "the edge ignores the card's colour");
  assert.match(cardFace, /collection-card--\$\{accent\}`? *\}?/u, "the accent never reaches the edge");

  // Without a line where the face wraps over it, an edge in exactly the card's
  // colour is invisible: nothing marks where the face stops.
  const rim = css.match(/\.card-flip__slice--rim \{([^}]*)\}/u);
  assert.ok(rim, "the edge lost the line that makes its thickness readable");
  assert.match(rim[1], /border: 1px solid var\(--card-rim\)/u);
  assert.match(cardFace, /rim: index === 0 \|\| index === EDGE_SLICE_COUNT - 1/u, "the rim is not on the two outermost layers");

  // Array.from's map callback takes two arguments — reading a third one for the
  // length gives undefined and the viewer throws on render.
  const table = cardFace.match(/const EDGE_SLICES = Array\.from\(([\s\S]*?)\n\}\);/u);
  assert.ok(table, "the edge no longer builds its layers");
  assert.doesNotMatch(table[0], /\(_, index, [A-Za-z]+\)/u, "Array.from's callback has no third argument");
});


test("the dropdown is the cabinet's own, not the operating system's", async () => {
  // A native <select> opens an OS menu — on Windows a grey list with square
  // corners — which was the one control drawn in someone else's hand. Replacing
  // it is only an improvement if it keeps what a <select> gave for free: the
  // keyboard, a form that still refuses to submit empty, and a menu that is not
  // clipped by whatever container it happens to sit in.
  const select = await readFile(new URL("../app/collection/card-select.tsx", import.meta.url), "utf8");
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  const users = await Promise.all(
    ["page", "panels", "relation-view"].map((name) =>
      readFile(new URL(`../app/collection/${name}.tsx`, import.meta.url), "utf8"),
    ),
  );

  for (const [index, source] of users.entries()) {
    assert.doesNotMatch(source, /<select/u, `a native select is back in file ${index}`);
  }

  // The listbox contract. Without these the picker is a div that looks like a
  // control to sighted mouse users and to nobody else.
  assert.match(select, /role="combobox"/u);
  assert.match(select, /role="listbox"/u);
  assert.match(select, /role="option"/u);
  assert.match(select, /aria-expanded=\{open\}/u);
  assert.match(select, /aria-activedescendant=\{open \? optionId\(active\) : undefined\}/u);
  for (const key of ["ArrowDown", "ArrowUp", "Home", "End", "Escape", "Enter"]) {
    assert.match(select, new RegExp(`"${key}"`, "u"), `the picker ignores ${key}`);
  }

  // Rendered into the body: a menu laid out in flow gets cut off by the
  // toolbars and cards it opens inside of.
  assert.match(select, /createPortal\(panel, document\.body\)/u);
  const panel = css.match(/\.card-select__panel \{([^}]*)\}/u);
  assert.ok(panel, "globals.css no longer draws the dropdown");
  assert.match(panel[1], /position: fixed/u);
  assert.match(panel[1], /animation: card-select-open/u);

  // display:none would take the guard out of form validation entirely, which is
  // the one thing it exists for.
  const guard = css.match(/\.card-select__validity \{([^}]*)\}/u);
  assert.ok(guard, "the required-field guard lost its styling");
  assert.doesNotMatch(guard[1], /display: none/u, "a hidden guard is skipped by validation");
  assert.match(guard[1], /opacity: 0/u);
  assert.match(select, /required\n?\s*value=\{value\}/u, "the guard no longer mirrors the value");

  // Motion the reader did not ask for is motion the reader can turn off.
  const reduced = css.match(/@media \(prefers-reduced-motion: reduce\) \{\s*\.card-select__panel,\s*\.card-select__option \{\s*animation: none;/u);
  assert.ok(reduced, "the dropdown ignores prefers-reduced-motion");

  for (const frames of ["card-select-open", "card-select-close", "card-select-deal"]) {
    assert.ok(css.includes(`@keyframes ${frames} {`), `${frames} is missing`);
  }
});

test("long jobs run in the background instead of holding the app hostage", async () => {
  // Downloading a model and rebuilding every card's vector take minutes. They
  // used to be awaited inside the click handler, which left the settings form
  // disabled and the panel refusing to close for the duration — the whole app
  // stopped for a job that has nothing to do with reading cards.
  const page = await readFile(new URL("../app/collection/page.tsx", import.meta.url), "utf8");
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

  assert.doesNotMatch(page, /waitForBackgroundTask/u, "the blocking wait is back");

  // Starting a job must not be awaited to completion. The three long ones hand
  // the task id to the watcher and return.
  for (const handler of ["handleSaveSettings", "handleDownloadModel", "handleSelectModel"]) {
    const body = page.slice(page.indexOf(`const ${handler} = async`), page.indexOf(`const ${handler} = async`) + 2600);
    assert.ok(body.length > 100, `${handler} is gone`);
    assert.match(body, /void watchBackgroundTask\(/u, `${handler} does not hand off to the watcher`);
    assert.doesNotMatch(body, /await watchBackgroundTask\(/u, `${handler} still waits for the job to finish`);
  }

  // Escape and the close button must not consult the running task any more.
  // The guard is the early return; what follows it may still mention the task,
  // because a finished one is cleared on the way out.
  const close = page.match(/const closeModels = \(\) => \{\s*\n([^\n]*)/u);
  assert.ok(close, "closeModels is gone");
  assert.doesNotMatch(close[1], /isBackgroundTaskRunning/u, "a running job still locks the settings shut");

  // And the progress has to survive that close, or the job becomes invisible.
  assert.match(page, /!isModelsOpen && backgroundTask \? \(/u, "a running job disappears when the settings close");
  assert.match(page, /className="background-task-dock"/u);
  const dock = css.match(/\.background-task-dock \{([^}]*)\}/u);
  assert.ok(dock, "the docked progress panel has no styling");
  assert.match(dock[1], /position: fixed/u);
});

test("the dimension guide states the choice, not an essay per option", async () => {
  // Three dimensions each arguing their case in full is three screens of prose
  // between the reader and the picker they came for. The two figures people
  // actually compare stay on the face; the trade-offs open one at a time.
  const panels = await readFile(new URL("../app/collection/panels.tsx", import.meta.url), "utf8");
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

  const guide = region(panels, "function DimensionGuide", "export function ModelSettingsPanel", "dimension guide");
  assert.ok(guide.length > 200, "the dimension guide is gone");
  assert.match(guide, /const \[open, setOpen\] = useState<number \| null>\(null\)/u, "every dimension is open at once again");
  assert.match(guide, /aria-expanded=\{isOpen\}/u);
  assert.match(guide, /isOpen \? \(/u, "the trade-offs are not behind the disclosure");
  // The bullets are the long part: they must only exist while one is open.
  const bulletsAt = guide.indexOf("dimension-guide__list");
  assert.ok(bulletsAt > guide.indexOf("isOpen ? ("), "the bullet lists are still on the face");

  assert.match(css, /\.dimension-guide__face \{/u, "the guide has no face to click");
  assert.match(css, /@keyframes dimension-guide-open \{/u);
});

test("each explanation is given once, where it changes a decision", async () => {
  // The settings page had grown a habit of saying the same thing three times:
  // in the section description, again in the slot hint under it, and a third
  // time in the glossary card beside it. The rule is one statement per fact,
  // at the place it changes what someone does — background lives in the
  // glossary card, and only there.
  const [panels, glossary, catalogue] = await Promise.all([
    readFile(new URL("../app/collection/panels.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/collection/glossary.ts", import.meta.url), "utf8"),
    readFile(new URL("../desktop/model-runtime.cjs", import.meta.url), "utf8"),
  ]);

  // Changing embedding rebuilds every card. Said where a change is committed,
  // not on individual catalogue entries, where it read as a property of those
  // two models rather than of the choice.
  const rebuildOnCards = catalogue.match(/description: "[^"]*重建[^"]*"/gu) ?? [];
  assert.deepEqual(rebuildOnCards, [], `the rebuild warning is back on ${rebuildOnCards.length} model cards`);
  assert.match(panels, /若動到 embedding，儲存後會重建所有卡片的向量與關聯/u, "the save bar no longer says what saving costs");
  // The picker is behind a door now, so the door is where the cost is stated —
  // once when closed, with the real number, and again in full when opened.
  assert.match(panels, /重新計算全部 \{cardCount\} 張卡片的向量/u, "the closed gate no longer says how much work a change is");
  assert.match(panels, /更改向量模型會重建整個卡片資料庫/u, "the opened gate no longer says what it costs to go through it");

  // Background that belongs to the glossary card, and is not also said inline
  // a few lines above it: `kept` is what the card must still explain, `gone` is
  // the inline copy of it.
  for (const [term, kept, gone] of [
    ["onnx", "onnx-community", "onnx-community"],
    ["local-vs-api", "完全不離開這台機器", "用本機供應商時"],
    ["api-dimensions", "數數看回來幾個數字", "服務不會用別的方式"],
  ]) {
    assert.ok(glossary.includes(kept), `the ${term} card lost its explanation`);
    assert.ok(!panels.includes(gone), `${term} is explained inline as well as in the glossary`);
  }

  // What must not be trimmed: the sentences someone loses data or privacy by
  // not reading.
  for (const warning of [
    "這會清除目前所有啟用卡片、垃圾桶卡片與關聯",
    "不含 API 金鑰",
    "匯入會取代目前的本機資料",
    "Tailscale",
  ]) {
    assert.ok(panels.includes(warning), `a warning was trimmed away: ${warning}`);
  }

  // A section description that repeats its own slot hint is the shape the trim
  // was about; the two must not be the same sentence.
  const descriptions = [...panels.matchAll(/description="([^"]+)"/gu)].map((match) => match[1]);
  const hints = [...panels.matchAll(/slotHint="([^"]+)"/gu)].map((match) => match[1]);
  for (const hint of hints) {
    const core = hint.replace(/[。，、]/gu, "").slice(0, 8);
    for (const description of descriptions) {
      assert.ok(!description.replace(/[。，、]/gu, "").includes(core), `a description repeats its slot hint: ${core}`);
    }
  }
});

test("the app moves on one set of timings", async () => {
  // Motion only reads as one object if every part of it uses the same curve and
  // the same handful of speeds. Before this there were nine durations and two
  // curves in play, plus the browser's own `ease`, whose slow start makes a
  // short movement feel like lag.
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  const page = await readFile(new URL("../app/collection/page.tsx", import.meta.url), "utf8");

  for (const token of ["--ease-out:", "--ease-in-out:", "--motion-quick:", "--motion-base:", "--motion-slow:"]) {
    assert.ok(css.includes(token), `the motion system lost ${token}`);
  }

  // Every transition and animation draws from the tokens. The exceptions are
  // the ambient loops — a background that drifts for a minute at a time is not
  // on the same clock as a button.
  const declarations = css.match(/\n\s*(transition|animation):[^;}]*;/gu) ?? [];
  const strays = declarations
    .filter((line) => !line.includes("infinite"))
    .filter((line) => /\d+m?s(?![\w-])/u.test(line) || /cubic-bezier/u.test(line) || /(?<![-\w])ease(?![-\w(])/u.test(line));
  assert.deepEqual(strays.map((line) => line.trim()), [], "these move on their own clock");

  // The backstop, so anything added later is covered without remembering to.
  const reduced = css.match(/@media \(prefers-reduced-motion: reduce\) \{\s*\*,\s*\*::before,\s*\*::after \{([^}]*)\}/u);
  assert.ok(reduced, "there is no app-wide reduced-motion rule");
  assert.match(reduced[1], /animation-duration: 1ms !important/u);
  assert.match(reduced[1], /transition-duration: 1ms !important/u);

  // A surface that arrives and then vanishes is worse than one that does
  // neither, so both full-screen surfaces are held mounted while they leave.
  assert.match(css, /\.card-viewer\.is-closing/u);
  assert.match(css, /\.settings-modal-backdrop\.is-closing/u);
  assert.match(page, /const closeViewer = useCallback/u, "the viewer unmounts before it can leave");
  assert.match(page, /const dismissSettings = useCallback/u, "the settings unmount before they can leave");
  assert.match(page, /setIsViewerClosing\(true\)/u);
  assert.match(page, /VIEWER_EXIT_MS/u);

  // The wall deals itself out, but the stagger is capped: three hundred cards
  // at 26ms apart would still be arriving eight seconds later.
  assert.match(page, /"--i": Math\.min\(index, \d+\)/u, "the card stagger is uncapped");
  assert.match(page, /"--s": Math\.min\(order, \d+\)/u, "the category stagger is uncapped");
});

test("duplicates come to the reader instead of waiting in a panel", async () => {
  // The AI batch organiser reported four things behind a card selection and a
  // preview: two of them are done on save now, one was a copy of the relation
  // view, and this one — the only one that needs a person to look — was the
  // least likely to be found, since nobody opens a panel to discover something
  // they do not know is there.
  const page = await readFile(new URL("../app/collection/page.tsx", import.meta.url), "utf8");
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  const api = await readFile(new URL("../desktop/local-api.cjs", import.meta.url), "utf8");

  assert.doesNotMatch(page, /批次整理/u, "the batch organiser is back in the toolbar");
  assert.doesNotMatch(page, /batch\/organize/u, "the batch endpoint is being called again");
  assert.doesNotMatch(api, /batchOrganize/u, "the batch analysis is back");

  assert.match(page, /const loadDuplicates = async/u, "nothing reads the duplicates");
  assert.match(page, /void loadDuplicates\(\)/u, "the duplicates are never actually read");
  assert.match(page, /className="duplicate-notice"/u, "there is nowhere for them to show up");
  assert.match(css, /\.duplicate-notice \{/u);

  // Each side of a pair opens its own card: a duplicate is not actionable
  // until you can see both of them.
  assert.match(page, /setViewerCardId\(pair\.source_id\)/u);
  assert.match(page, /setViewerCardId\(pair\.target_id\)/u);

  // Saying "duplicate" about two cards that merely belong together is worse
  // than saying nothing. The evidence is the wording — never a cosine against
  // a constant (§3.3), and not the collection's own range either: on a small
  // cabinet that range is noise, and it voted against a retyped card while
  // giving two unrelated cards a perfect score.
  const duplicateRule = region(api, "function findDuplicates", "\n}\n", "duplicate rule");
  assert.match(duplicateRule, /overlap < DUPLICATE_MIN_OVERLAP/u, "wording is not being checked at all");
  assert.doesNotMatch(duplicateRule, /cosine\(/u, "similarity is back in the duplicate rule");
});

/**
 * Changing the embedding model is not the same kind of choice as the others.
 *
 * The summary model can be swapped freely and never touches a stored card.
 * Changing the embedding model recomputes every vector in the cabinet, which is
 * minutes of work for no gain unless something specific is wrong with the model
 * in use. Side by side and equally reachable, the two read as the same
 * decision, so the costly one now sits behind a door.
 *
 * The slot naming the model in use stays outside it: that is information, and
 * hiding it would mean nobody could tell what their cabinet was built with.
 */
test("changing the embedding model is behind a door, in both views", async () => {
  const panels = await readFile(new URL("../app/collection/panels.tsx", import.meta.url), "utf8");

  const uses = panels.match(/<EmbeddingChangeGate/gu) ?? [];
  assert.equal(uses.length, 2, `the gate is used ${uses.length} times; it belongs in the simple view and the advanced one`);

  // In the simple view the axes are inside the gate and the slot is not.
  const simple = region(panels, "function SimpleModelPicker", "\n}\n", "the simple picker");
  const gateAt = simple.indexOf("<EmbeddingChangeGate");
  assert.notEqual(gateAt, -1, "the simple view no longer gates the embedding choice");
  assert.ok(gateAt < simple.indexOf("simple-picker__axes"), "the picker sits outside the gate");
  assert.ok(simple.indexOf("slotCard={embeddingSlot}") < gateAt, "the active model is hidden behind the gate too");

  // And the deck of every model in the advanced view is gated as well, or the
  // door is a door in one view and a decoration in the other.
  assert.match(panels, /gate=\{\(content\) => <EmbeddingChangeGate/u, "the advanced view no longer gates the embedding choice");
});

/**
 * The semantic search has to be able to *add* a card, not only remove one.
 *
 * The collection filtered on "the card's text contains what was typed" AND
 * "the host returned this card", so the vectors could only ever narrow the
 * literal matches. That makes the whole embedding pipeline decorative, and
 * invisibly so: the host scores a Chinese query — which has no spaces, and so
 * is one term — against every card, but the literal test then rejects anything
 * that does not spell the query out. Measured against the running cabinet,
 * "為什麼需要多數決" hits "為什麼共識需要過半數？" at 0.750 and showed nothing,
 * because those two share no character at all.
 */
test("a card the host matched is not thrown away for lacking the exact words", async () => {
  const page = await readFile(new URL("../app/collection/page.tsx", import.meta.url), "utf8");
  // Bounded by the filter's own end rather than by whatever is declared next.
  const filter = region(page, "const filteredCards = cards.filter", "}).sort(", "the collection filter");

  // Unioning the two was the first repair and it is no longer enough. The host
  // deliberately drops cards that are merely the nearest thing on the shelf,
  // and a local includes() puts exactly those back — which is how one word
  // fills the screen again. The host now runs the lexical half itself, over
  // every card including the ones carrying no vector at all (see
  // tests/retrieval.test.mjs), so when it has answered, its answer is the
  // result set.
  assert.match(
    filter,
    /semanticSearchMatches\s*\?\s*semanticSearchMatches\.has\(card\.id\)/u,
    "the host's answer is not what decides which cards a query matches",
  );
  assert.doesNotMatch(
    filter,
    /searchText\.includes\(query\)\s*\|\|\s*Boolean\(semanticSearchMatches/u,
    "the local match is being unioned with the host's answer again",
  );
  assert.doesNotMatch(
    filter,
    /matchesSemanticSearch|searchText\.includes\(query\)\s*&&/u,
    "the host's answer is back to being a second gate the literal match has to pass as well",
  );
  // The local match survives only as the stopgap for the moment before the
  // first answer arrives, and for a host that is not answering at all.
  assert.match(filter, /:\s*searchText\.includes\(query\)/u, "there is no longer anything to show before the host answers");
  // An empty query still shows the whole cabinet.
  assert.match(filter, /!query$/mu, "an empty query no longer matches everything");
});

/**
 * A backend that cannot be reached has to arrive as a sentence.
 *
 * These routes only forward, so the failure they have to handle is the one
 * where forwarding itself throws. Without a catch the framework answers with
 * the plain text "Internal Server Error", and the caller — which quite
 * reasonably expects JSON — shows the user
 * `Unexpected token 'I', "Internal S"... is not valid JSON`. That is what the
 * settings dialog showed, and it was the only place left in the app that could:
 * thirty-six of thirty-eight routes already caught, settings and network/lan
 * did not.
 *
 * Checked per file rather than per handler, because a file is free to share one
 * catch between its handlers — network/lan does.
 */
test("every API proxy route answers a dead backend in words", async () => {
  const root = new URL("../app/api/", import.meta.url);
  const routes = [];
  const walk = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const child = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, dir);
      if (entry.isDirectory()) await walk(child);
      else if (entry.name === "route.ts") routes.push(child);
    }
  };
  await walk(root);
  assert.ok(routes.length >= 30, `only found ${routes.length} proxy routes`);

  for (const route of routes) {
    const source = await readFile(route, "utf8");
    const name = route.pathname.slice(route.pathname.indexOf("/app/api/") + 9);
    // health/ has no handlers to protect.
    if (!/export async function (GET|POST|PUT|PATCH|DELETE)/u.test(source)) continue;
    assert.match(source, /catch\s*(\([^)]*\))?\s*\{/u, `${name} forwards to the backend without catching a failure`);
    assert.match(source, /status: 503/u, `${name} has no "backend unreachable" answer`);
  }
});

test("the canvas can be arranged by colour", async () => {
  // A card's colour is its category's colour, so lanes of colour are lanes of
  // category — the arrangement people were doing by hand, dragging one node at
  // a time, until the graph was too big to be worth the dragging.
  const view = await readFile(new URL("../app/collection/relation-view.tsx", import.meta.url), "utf8");
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

  assert.match(view, /function createColorLayout/u, "there is no colour layout");
  assert.match(view, /aria-label="節點排列方式"/u, "the arrangement cannot be chosen");
  assert.match(view, /\["color", "依顏色"\]/u);

  // Warm to cool, so the canvas comes out a spectrum rather than a shuffle.
  assert.match(view, /const LANE_ORDER = \["coral", "rose", "amber", "moss", "mint", "sky", "indigo", "lavender"\]/u);

  // A laid-out node has to land where a dragged node is allowed to be, or it
  // could never be dragged back to where it started.
  const clamps = view.match(/clamp\(nextX, (\d+), (\d+)\)[\s\S]*?clamp\(nextY, (\d+), (\d+)\)/u);
  assert.ok(clamps, "the drag clamps moved");
  assert.ok(
    view.includes(`Math.min(${clamps[2]}, Math.max(${clamps[1]}, laneCenter`),
    "a lane can put a node outside the draggable width",
  );
  assert.ok(
    view.includes(`Math.min(${clamps[4]}, Math.max(${clamps[3]}, top`),
    "a lane can put a node outside the draggable height",
  );

  // Pressing the arrangement you are already in re-deals it, which is the only
  // way back after dragging half the canvas around.
  assert.match(view, /setLayoutNonce\(\(current\) => current \+ 1\)/u);
  assert.match(view, /const layoutKey = `\$\{layoutMode\}\|\$\{layoutNonce\}/u);

  // The lane says which category it is: past eight categories two share a colour.
  assert.match(view, /className=\{`relation-lane relation-lane--\$\{lane\.accent\}`\}/u);
  assert.match(css, /\.relation-lane--coral \{/u, "lane bands have no colour of their own");

  // The graph is the whole point of the view, so it gets the window's height
  // rather than a fixed slab.
  assert.match(css, /\.relation-canvas \{[^}]*min-height: clamp\(/u, "the canvas is back to a fixed height");
});

test("what gets downloaded is the cabinet, not the advertisement", async () => {
  // The front page and the product used to be two routes of one build, so
  // every desktop release carried the marketing copy, and every change to the
  // marketing copy needed a release. They are two builds now.
  const root = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(root, /redirect\("\/collection"\)/u, "the product root no longer sends anyone to their cards");
  assert.ok(root.length < 1200, "the product root has grown a front page again");

  const landing = await readFile(new URL("../site/landing.tsx", import.meta.url), "utf8");
  assert.match(landing, /export function LandingPage/u);
  // Shared, not copied: the cards on the page are the cards in the app.
  assert.match(landing, /from "\.\.\/app\/card-face"/u, "the front page has its own copy of the card components");

  // The built product must not contain the page's copy anywhere — not in the
  // client chunks, not in the server bundle, not in standalone.
  const built = await readdir(new URL("../dist", import.meta.url), { recursive: true, withFileTypes: true });
  const files = built.filter((entry) => entry.isFile() && /\.(?:js|html|css|json)$/u.test(entry.name));
  assert.ok(files.length > 10, `only ${files.length} files in dist — was the product built?`);
  for (const entry of files) {
    const text = await readFile(join(entry.parentPath ?? entry.path, entry.name), "utf8");
    assert.doesNotMatch(text, /把知識整理好/u, `${entry.name} carries the front page`);
  }

  // The page is configured at build time, and every setting is allowed to be
  // missing: a page that links nowhere is worse than a page that says "soon".
  const config = await readFile(new URL("../vite.config.site.ts", import.meta.url), "utf8");
  assert.match(config, /outDir: "\.\.\/dist-site"/u);
  assert.match(config, /base: "\.\/"/u, "the built page only works at a domain root");
  assert.match(landing, /import\.meta\.env\.VITE_KCC_DOWNLOAD_URL/u);
  assert.match(landing, /import\.meta\.env\.VITE_KCC_APP_URL/u);
  assert.doesNotMatch(landing, /process\.env/u, "Vite replaces process.env with {} — the setting would silently be empty");
  assert.doesNotMatch(landing, /href="\/collection"/u, "the page still links to a route it no longer sits next to");

  // The workflow that publishes the page is the only place those settings are
  // ever supplied, and supplying the wrong name is invisible: the build still
  // succeeds and the download button simply is not there. So the names have to
  // agree on both sides, and the build has to be the site build.
  const pages = await readFile(new URL("../.github/workflows/pages.yml", import.meta.url), "utf8");
  assert.match(pages, /npm run build:site/u, "the page workflow builds something other than the page");
  for (const setting of landing.match(/VITE_KCC_[A-Z_]+/gu) ?? []) {
    if (setting === "VITE_KCC_APP_URL") continue; // Optional: no public copy of the cabinet is hosted.
    assert.ok(pages.includes(`${setting}:`), `${setting} is read by the page and never set when it is published`);
  }
  assert.match(pages, /releases\/latest/u, "the download link would need a rebuild for every release");
});

test("the package leaves out only what it cannot reach", async () => {
  // 1.2 GB of Windows package was 370 MB of files the process cannot open:
  // onnxruntime ships prebuilds for six platform/arch pairs, transformers and
  // onnxruntime-web each ship a browser half, and Chromium ships fifty
  // languages. Cutting them is safe exactly as long as the keep-list still
  // matches what the packages resolve to in Node — which is what this checks.
  const builder = await readFile(new URL("../desktop/electron-builder.yml", import.meta.url), "utf8");

  assert.match(builder, /- "!\*\*\/\*\.map"/u, "source maps are shipping again");
  assert.match(builder, /electronLanguages:[\s\S]*zh-TW/u, "every Chromium locale is shipping again");

  // Each platform keeps its own onnxruntime binary and drops the others.
  const windows = region(builder, "\nwin:", "\nmac:", "the win: block");
  assert.match(windows, /!node_modules\/onnxruntime-node\/bin\/napi-v3\/darwin\/\*\*/u);
  assert.match(windows, /!node_modules\/onnxruntime-node\/bin\/napi-v3\/linux\/\*\*/u);
  assert.doesNotMatch(windows, /!node_modules\/onnxruntime-node\/bin\/napi-v3\/win32\/\*\*/u, "the Windows build excludes its own runtime");
  const mac = region(builder, "\nmac:", "\nnsis:", "the mac: block");
  assert.match(mac, /!node_modules\/onnxruntime-node\/bin\/napi-v3\/win32\/\*\*/u);
  assert.doesNotMatch(mac, /!node_modules\/onnxruntime-node\/bin\/napi-v3\/darwin\/\*\*/u, "the macOS build excludes its own runtime");

  // The exclusion that can break the app rather than merely fatten it —
  // onnxruntime-web is dropped wholesale and its Node entry added back by name
  // — is checked against the installed packages by scripts/check-packaging.mjs.
  // That needs desktop/node_modules, which only exists after
  // `npm run desktop:prepare`; CI does not install it, and a test that reads it
  // unconditionally is how this suite first went red. The release workflow runs
  // the script after packaging, before anything is uploaded.
  const { checkPackaging } = await import("../scripts/check-packaging.mjs");
  try {
    await access(new URL("../desktop/node_modules/onnxruntime-web/package.json", import.meta.url));
  } catch {
    return;
  }
  await checkPackaging();
});

test("the app can tell you which build it is", async () => {
  // 1.0.0 shipped with no version anywhere in the interface and no way to
  // learn that a newer one exists. A fix that cannot reach anyone is not a
  // fix, and a bug report that cannot name a build is hard to act on.
  const page = await readFile(new URL("../app/collection/page.tsx", import.meta.url), "utf8");
  assert.ok(page.includes('fetch("/api/app/version"'), "the interface never asks which version it is");
  assert.ok(page.includes("collection-page-version"), "the version is fetched and then not shown");
  assert.ok(page.includes("有新版本"), "there is no way for a published fix to announce itself");

  // Asked once, on mount — not on a timer, and not on every render.
  const effect = page.slice(page.indexOf('fetch("/api/app/version"'));
  assert.match(effect.slice(0, 400), /\}, \[\]\);/u, "the version check is not pinned to a single mount");
  assert.doesNotMatch(page, /setInterval\([^)]*app\/version/u, "the app polls for updates");

  // The route it calls has to exist, and has to go to the local API rather
  // than to GitHub from the browser.
  const route = await readFile(new URL("../app/api/app/version/route.ts", import.meta.url), "utf8");
  assert.match(route, /backendFetch\("\/app\/version"/u);
  assert.doesNotMatch(route, /api\.github\.com/u, "the page would call GitHub itself, exposing the reader's browser");

  // And the check itself must stay switchable and rare, because an app that
  // promises to keep to itself cannot quietly call home on every launch.
  const check = await readFile(new URL("../desktop/update-check.cjs", import.meta.url), "utf8");
  assert.match(check, /24 \* 60 \* 60 \* 1000/u, "the once-a-day cap is gone");
  const api = await readFile(new URL("../desktop/local-api.cjs", import.meta.url), "utf8");
  assert.match(api, /KCC_UPDATE_CHECK/u, "there is no way to switch the update check off");
  // A paired phone may read the last answer and may not cause a new request.
  // The two suites cannot tell these apart at runtime — with the check off
  // they return the same thing — so the branch is asserted where it is made.
  assert.match(
    api,
    /authScope === "device" \? updateCheck\.status\(\) : await updateCheck\.check\(\)/u,
    "a paired device can make the host reach the network",
  );
  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
  assert.match(readme, /KCC_UPDATE_CHECK/u, "the one network call the app makes is undocumented");
});


test("a query gets an answer, not a shelf to look along", async () => {
  // The category wall shows a title and a question and hides the one sentence
  // behind a click. That is the right shape for browsing and the wrong shape
  // for "did I ever write this down" — which is the question the cabinet
  // exists to answer, and the one a search is always asking.
  const page = await readFile(new URL("../app/collection/page.tsx", import.meta.url), "utf8");

  const results = region(page, "function SearchResults(", "\n}\n", "the search result list");
  for (const field of ["number", "category", "title", "question", "summary"]) {
    assert.match(results, new RegExp(`card\\.${field}`, "u"), `a result does not carry its ${field}`);
  }
  assert.match(results, /reasons\.get\(card\.id\)/u, "a result does not say why it is here");
  assert.doesNotMatch(results, /\bscore\b/u, "a score is on screen; the reason is what a reader can act on");

  // And it has to actually be what a query renders.
  const branch = region(page, `collectionView === "cards" && collectionQuery.trim()`, "collection-categories", "the cards view branch");
  assert.match(branch, /<SearchResults/u, "a query still renders the browsing wall");
});

test("the quick search overlay is a client of the same search, and says which keys it takes", async () => {
  // A second endpoint would grow a second ranking, and one of the two would
  // rot. The overlay is another client of GET /search, nothing more.
  const quick = await readFile(new URL("../app/quick/page.tsx", import.meta.url), "utf8");
  assert.match(quick, /\/api\/search\?/u, "the overlay does not use the cabinet's own search");
  assert.doesNotMatch(quick, /quick-search|\/api\/quick/u, "the overlay grew its own endpoint");

  // Keyboard first: the mouse is the secondary way in, so every one of these
  // has to be handled.
  const keys = region(quick, "const onKeyDown = useCallback", "}, [close, cursor, results]);", "the overlay's key handling");
  for (const key of ["Escape", "ArrowDown", "ArrowUp", "Enter"]) {
    assert.match(keys, new RegExp(`"${key}"`, "u"), `${key} does nothing in the overlay`);
  }
  assert.match(keys, /metaKey \|\| event\.ctrlKey/u, "there is no way to send a card to the cabinet");

  // Focus stays in the field, which is what lets somebody keep typing while
  // they steer — so the rows must not be tab stops competing for it.
  assert.match(quick, /tabIndex=\{-1\}/u, "the result rows take focus away from the field");
});

test("the quick search shortcut is claimed honestly or not claimed at all", async () => {
  // A global accelerator is first-come-first-served across the machine, and
  // Electron reports a refusal by returning false rather than by throwing.
  // Ignoring that ships an app whose headline feature silently does nothing.
  const main = await readFile(new URL("../desktop/main.cjs", import.meta.url), "utf8");

  assert.match(main, /QUICK_ACCELERATORS = \[/u, "there is no accelerator list to fall back through");
  const register = region(main, "function registerQuickShortcut()", "\n}\n", "shortcut registration");
  assert.match(register, /if \(globalShortcut\.register\(/u, "the return value of register() is ignored");
  assert.match(register, /quickAccelerator = null/u, "a machine where nothing could be claimed is not recorded");
  assert.match(main, /ipcMain\.handle\("quick:shortcut"/u, "the interface cannot ask what was claimed");

  // The window is kept, not rebuilt: creating one on demand takes long enough
  // that the keystroke reads as having done nothing.
  assert.match(main, /quickWindow\?\.hide\(\)/u, "the overlay is destroyed instead of hidden");
  assert.match(main, /globalShortcut\.unregisterAll\(\)/u, "the accelerator is still claimed after the app quits");

  // And the interface must print what was claimed rather than a guess.
  const page = await readFile(new URL("../app/collection/page.tsx", import.meta.url), "utf8");
  assert.match(page, /bridge\.shortcut\(\)/u, "the hint does not ask which accelerator is live");
  assert.doesNotMatch(page, /"(Ctrl|⌘)\+Shift\+K"/u, "the accelerator is hardcoded into the interface");
});

test("keeping an understanding asks for the understanding and nothing else", async () => {
  // The form used to open on a box wanting a card id — a string nobody who
  // reads the card later has any use for — followed by a number, a topic and a
  // category before the first word of the actual card. Four decisions in front
  // of the one thing the product is for. That is the shape that turns "keep
  // this" into "I'll organise it later" (CLAUDE.md §1 P-04).
  const panels = await readFile(new URL("../app/collection/panels.tsx", import.meta.url), "utf8");
  const form = region(panels, "export function CreateCardForm(", "\n}\n", "the card form");
  const quick = region(form, `<div className="create-card-grid">`, `<div className="create-card-advanced">`, "the fields asked for up front");

  for (const field of ["title", "question", "summary", "category"]) {
    assert.match(quick, new RegExp(`"${field}"`, "u"), `quick capture does not ask for the ${field}`);
  }
  for (const field of ["id", "number", "topic", "analogy", "detail", "source", "tags"]) {
    assert.doesNotMatch(quick, new RegExp(`onChange\\("${field}"`, "u"), `${field} is still in the way of capture`);
  }

  // Still reachable, still editable — moved, not deleted.
  const advanced = region(form, `<div className="create-card-advanced">`, "{error ?", "the advanced fields");
  for (const field of ["analogy", "detail", "source", "tags", "topic", "number"]) {
    assert.match(advanced, new RegExp(`onChange\\("${field}"`, "u"), `${field} was dropped rather than moved`);
  }
  // The id is the one thing that is never typed: before the first save there is
  // nothing to show, and afterwards it is the runtime's, not the writer's.
  assert.doesNotMatch(form, /onChange\("id"/u, "the form still invites someone to name a card id");
  assert.match(advanced, /isEditing \?[\s\S]*readOnly/u, "an existing card cannot be traced back to its id");

  // And the runtime has to accept what the form now sends.
  const api = await readFile(new URL("../desktop/local-api.cjs", import.meta.url), "utf8");
  assert.doesNotMatch(api, /!body\.id \|\| !body\.number/u, "the runtime still demands an id and a number");
  assert.match(api, /generateCardId\(\)/u, "the runtime does not mint an id of its own");
  assert.match(api, /nextCardNumber\(store\.cards\)/u, "the runtime does not number a card of its own");
});
