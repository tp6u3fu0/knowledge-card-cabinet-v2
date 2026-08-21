/**
 * The embedding width is runtime state, not a compile-time constant.
 *
 * It used to be a hardcoded 384 in two files, which meant a 1024-dim API was
 * rejected outright and the hash fallback could quietly hand back a vector of
 * the wrong width. The contract now is: the active model (or the first reply
 * from a custom API) decides the width, and everything afterwards must agree.
 *
 * Run with:  node --test tests/embedding-dimensions.test.mjs
 */

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createModelRuntime } = require("../desktop/model-runtime.cjs");
const { openStore } = require("../desktop/store.cjs");
const { hashEmbedding } = require("../desktop/local-api.cjs");

/** A stand-in embedding API whose reply width the test controls. */
async function fakeEmbeddingApi() {
  let width = 1024;
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    // TEI format: a bare array of vectors.
    response.end(JSON.stringify([Array.from({ length: width }, (_, index) => (index % 3 === 0 ? 0.02 : -0.01))]));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}/embed`,
    setWidth: (next) => { width = next; },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

function apiBackedRuntime(root, apiUrl, apiDimensions = 0) {
  const modelsDir = join(root, "models");
  mkdirSync(modelsDir, { recursive: true });
  writeFileSync(join(modelsDir, "settings.json"), JSON.stringify({
    sources: { summary: "local", embedding: "api" },
    custom: {
      summary: { api_url: "", api_format: "openai", model: "", api_key: "" },
      embedding: { api_url: apiUrl, api_format: "tei", model: "test-model", api_key: "" },
    },
  }), "utf8");
  return createModelRuntime({ modelsDir, hashEmbedding, templateDraft: () => ({}), apiDimensions });
}

/**
 * Point the runtime at an empty directory for bundled weights, so a test can
 * describe a build that ships none. Returns the cleanup for `t.after`.
 */
function withoutBundledWeights(root) {
  const previous = process.env.KCC_BUNDLED_MODELS_DIR;
  process.env.KCC_BUNDLED_MODELS_DIR = join(root, "no-bundled-weights");
  return () => {
    if (previous === undefined) delete process.env.KCC_BUNDLED_MODELS_DIR;
    else process.env.KCC_BUNDLED_MODELS_DIR = previous;
  };
}

test("a custom API wider than the old hardcoded 384 is accepted", async (t) => {
  const api = await fakeEmbeddingApi();
  const root = mkdtempSync(join(tmpdir(), "kcc-dims-"));
  t.after(async () => {
    await api.close();
    rmSync(root, { recursive: true, force: true });
  });

  const runtime = apiBackedRuntime(root, api.url);
  const vector = await runtime.embed("內容", { allowFallback: false });
  assert.equal(vector.length, 1024, "the API's own width must be adopted, not forced to 384");
  assert.equal(runtime.expectedEmbeddingDimensions(), 1024, "and remembered");
});

test("once a width is established the API cannot silently change it", async (t) => {
  const api = await fakeEmbeddingApi();
  const root = mkdtempSync(join(tmpdir(), "kcc-dims-swap-"));
  t.after(async () => {
    await api.close();
    rmSync(root, { recursive: true, force: true });
  });

  const runtime = apiBackedRuntime(root, api.url);
  await runtime.embed("先建立寬度", { allowFallback: false });

  // Someone repoints the API at a different model behind the app's back.
  api.setWidth(384);
  await assert.rejects(
    () => runtime.embed("之後的內容", { allowFallback: false }),
    /維度不符/,
    "a changed width must be refused, not mixed into the store",
  );
});

test("the fallback never substitutes a vector of a different width", async (t) => {
  const api = await fakeEmbeddingApi();
  const root = mkdtempSync(join(tmpdir(), "kcc-dims-fallback-"));
  t.after(async () => {
    await api.close();
    rmSync(root, { recursive: true, force: true });
  });

  // Seeded as a 1024-dim store, then the API goes away entirely.
  const runtime = apiBackedRuntime(root, api.url, 1024);
  await api.close();

  // The old behaviour returned a 384-dim hash vector here, which then scored
  // against real 1024-dim vectors as if it meant something.
  await assert.rejects(() => runtime.embed("內容", { allowFallback: true }));
});

test("a store reports the width its cards actually use", () => {
  const root = mkdtempSync(join(tmpdir(), "kcc-dims-store-"));
  const db = openStore(join(root, "cards.json"));
  try {
    assert.equal(db.storedDimensions(), 0, "an empty store has no width yet");

    const card = (id, dims) => ({
      id, number: id, topic: "t", category: "c", title: id, question: "", summary: "",
      analogy: "", detail: "", source: "", tags: [], cover: null,
      embedding: dims ? new Array(dims).fill(0.01) : null,
      embedding_model_id: "m", embedding_source_hash: "h",
      created_at: "t", updated_at: "t", deleted_at: null,
    });

    db.replaceAll({
      version: 2,
      // Two settled cards plus one straggler still waiting on a reindex: the
      // majority defines the store, not the odd one out.
      cards: [card("a", 1024), card("b", 1024), card("c", 384), card("d", 0)],
      relations: [], categories: [], embedding_model_id: "m", summary_model_id: "s",
    });
    assert.equal(db.storedDimensions(), 1024);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("every catalogue embedding model declares a usable width", (t) => {
  const root = mkdtempSync(join(tmpdir(), "kcc-dims-catalog-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const modelsDir = join(root, "models");
  mkdirSync(modelsDir, { recursive: true });
  const runtime = createModelRuntime({ modelsDir, hashEmbedding, templateDraft: () => ({}) });

  const embeddings = runtime.catalog().models.filter((model) => model.kind === "embedding");
  assert.ok(embeddings.length > 0);
  assert.equal(new Set(embeddings.map((model) => model.id)).size, embeddings.length, "duplicate model ids");

  for (const model of embeddings) {
    // `dimensions` is what the runtime validates real output against, so a
    // missing or wrong value here fails at embed time, not at load time.
    assert.ok(Number.isInteger(model.dimensions) && model.dimensions > 0, `${model.id} has no width`);
    if (model.builtin) continue;
    assert.ok(model.model_id, `${model.id} has no repository`);
    assert.ok(model.dtype, `${model.id} must pin a dtype so it does not pull full-precision weights`);
    assert.ok(model.download_size_bytes > 0, `${model.id} has no download size`);
  }

  assert.ok(
    embeddings.some((model) => model.dimensions >= 1024),
    "the catalogue should offer a model above the original 384-dim ceiling",
  );
});

test("selecting a wider model makes the runtime expect that width", (t) => {
  const root = mkdtempSync(join(tmpdir(), "kcc-dims-selected-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const modelsDir = join(root, "models");
  mkdirSync(modelsDir, { recursive: true });
  // Written straight into settings rather than going through select(), which
  // would insist the 570 MB model is downloaded first.
  writeFileSync(join(modelsDir, "settings.json"), JSON.stringify({
    sources: { summary: "local", embedding: "local" },
    embedding_model_id: "embedding-bge-m3-1024",
  }), "utf8");

  const runtime = createModelRuntime({ modelsDir, hashEmbedding, templateDraft: () => ({}) });
  assert.equal(runtime.expectedEmbeddingDimensions(), 1024, "the selected model's width must drive the runtime");
  assert.equal(runtime.activeEmbeddingModelId(), "embedding-bge-m3-1024");
});

test("falling back to the built-in model is reported, not silent", (t) => {
  const root = mkdtempSync(join(tmpdir(), "kcc-dims-dropped-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const modelsDir = join(root, "models");
  mkdirSync(modelsDir, { recursive: true });
  writeFileSync(join(modelsDir, "settings.json"), JSON.stringify({
    sources: { summary: "local", embedding: "local" },
    embedding_model_id: "embedding-model-that-no-longer-exists",
  }), "utf8");

  // Describes a build with no bundled weights, so the fallback under test is
  // the built-in one. Without this the answer depends on whether this machine
  // happens to have run `npm run models:bundle`.
  t.after(withoutBundledWeights(root));
  const runtime = createModelRuntime({ modelsDir, hashEmbedding, templateDraft: () => ({}) });
  // Dropping to the built-in model rebuilds every vector at 384 dimensions and
  // makes semantic search quietly worse, so it must not pass unannounced.
  assert.equal(runtime.expectedEmbeddingDimensions(), 384, "it does fall back");
  assert.match(runtime.health().model_error, /embedding/, "and says so");
  assert.match(runtime.health().model_error, /embedding-model-that-no-longer-exists/);
});

test("a local model keeps its own declared width", (t) => {
  const root = mkdtempSync(join(tmpdir(), "kcc-dims-local-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const modelsDir = join(root, "models");
  mkdirSync(modelsDir, { recursive: true });
  t.after(withoutBundledWeights(root));
  const runtime = createModelRuntime({ modelsDir, hashEmbedding, templateDraft: () => ({}) });
  // With nothing bundled the default is the built-in hash embedding, whose
  // width is genuinely 384.
  assert.equal(runtime.expectedEmbeddingDimensions(), 384);
});
