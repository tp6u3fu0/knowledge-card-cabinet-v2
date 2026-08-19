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

  // There is no front page in the product any more — it is published on its
  // own out of site/. Anyone arriving at the root gets their cards.
  const root = await fetch(`http://127.0.0.1:${runtime.port}/`, { redirect: "manual" });
  assert.equal(root.status, 307);
  assert.equal(root.headers.get("location"), "/collection");

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

  const guide = panels.slice(panels.indexOf("function DimensionGuide"), panels.indexOf("export function ModelSettingsPanel"));
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
  assert.match(panels, /換模型會重建所有卡片的向量/u, "the simple picker applies a model immediately and no longer says so");

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
  // a constant (§1.3), and not the collection's own range either: on a small
  // cabinet that range is noise, and it voted against a retyped card while
  // giving two unrelated cards a perfect score.
  const duplicateRule = api.slice(api.indexOf("function findDuplicates"), api.indexOf("function unitValue"));
  assert.match(duplicateRule, /overlap < DUPLICATE_MIN_OVERLAP/u, "wording is not being checked at all");
  assert.doesNotMatch(duplicateRule, /cosine\(/u, "similarity is back in the duplicate rule");
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

  // The one that can break the app rather than just fatten it: onnxruntime-web
  // is excluded wholesale and its Node entry added back by name. If the
  // package renames that file, the app ships without the module transformers
  // imports at load time — and nothing else would notice.
  const ortWeb = JSON.parse(await readFile(new URL("../desktop/node_modules/onnxruntime-web/package.json", import.meta.url), "utf8"));
  // Some packages hang their conditions off "." and some off the root.
  const ortConditions = ortWeb.exports?.["."] ?? ortWeb.exports ?? {};
  const nodeEntries = Object.values(ortConditions.node ?? {}).map((entry) => entry.replace(/^\.\//u, ""));
  assert.ok(nodeEntries.length > 0, "onnxruntime-web no longer declares a node export");
  for (const entry of nodeEntries) {
    assert.ok(
      builder.includes(`- "node_modules/onnxruntime-web/${entry}"`),
      `onnxruntime-web resolves to ${entry} in Node, which the package excludes`,
    );
    await access(new URL(`../desktop/node_modules/onnxruntime-web/${entry}`, import.meta.url));
  }

  // Same check for transformers: Node resolves to dist/transformers.node.*,
  // and those must not be caught by the exclusions aimed at its browser half.
  const transformers = JSON.parse(await readFile(new URL("../desktop/node_modules/@huggingface/transformers/package.json", import.meta.url), "utf8"));
  const conditions = transformers.exports?.["."] ?? transformers.exports ?? {};
  const resolved = [conditions.node?.import?.default, conditions.node?.require?.default];
  for (const entry of resolved) {
    assert.ok(entry?.includes("transformers.node."), `transformers now resolves to ${entry} in Node`);
    assert.ok(!builder.includes(`!node_modules/@huggingface/transformers/${entry.replace(/^\.\//u, "")}`));
  }

  // Each platform keeps its own onnxruntime binary and drops the others.
  const windows = builder.slice(builder.indexOf("\nwin:"), builder.indexOf("\nmac:"));
  assert.match(windows, /!node_modules\/onnxruntime-node\/bin\/napi-v3\/darwin\/\*\*/u);
  assert.match(windows, /!node_modules\/onnxruntime-node\/bin\/napi-v3\/linux\/\*\*/u);
  assert.doesNotMatch(windows, /!node_modules\/onnxruntime-node\/bin\/napi-v3\/win32\/\*\*/u, "the Windows build excludes its own runtime");
  const mac = builder.slice(builder.indexOf("\nmac:"), builder.indexOf("\nnsis:"));
  assert.match(mac, /!node_modules\/onnxruntime-node\/bin\/napi-v3\/win32\/\*\*/u);
  assert.doesNotMatch(mac, /!node_modules\/onnxruntime-node\/bin\/napi-v3\/darwin\/\*\*/u, "the macOS build excludes its own runtime");
});
