import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

const require = createRequire(import.meta.url);
const { API_PROVIDERS, DIMENSION_GUIDE, MODEL_CATALOG, lookupHuggingFace } = require("../desktop/model-runtime.cjs");

const { startLocalApi } = await import("../desktop/local-api.cjs");
const projectRoot = new URL("../", import.meta.url);

async function withRuntime(run) {
  const root = await mkdtemp(join(tmpdir(), "kcc-catalogue-"));
  const runtime = await startLocalApi({
    dataFile: join(root, "cards.json"),
    modelsDir: join(root, "models"),
    seedPath: join(projectRoot.pathname.slice(1), "desktop", "seed.json"),
    migrateFromUrl: "",
  });
  const auth = { Authorization: `Bearer ${runtime.authToken}` };
  const json = async (path, init = {}) => {
    const response = await fetch(`${runtime.baseUrl}${path}`, {
      ...init,
      headers: { ...auth, ...(init.body ? { "Content-Type": "application/json" } : {}), ...init.headers },
    });
    return { status: response.status, body: await response.json() };
  };
  try {
    await run({ runtime, json });
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
}

test("the catalogue explains the dimension trade-off it asks people to make", async () => {
  await withRuntime(async ({ json }) => {
    const { status, body } = await json("/models");
    assert.equal(status, 200);

    const widths = body.dimension_guide.map((entry) => entry.dimensions);
    assert.deepEqual(widths, [384, 1024]);
    for (const entry of body.dimension_guide) {
      // Both sides have to be stated: a "guide" that only lists upsides for the
      // bigger model is a recommendation wearing a comparison's clothes.
      assert.ok(entry.strengths.length > 0, `${entry.label} lists no strengths`);
      assert.ok(entry.limits.length > 0, `${entry.label} lists no limits`);
    }
    // Every embedding the app ships must be covered by the guide.
    for (const model of body.models.filter((candidate) => candidate.kind === "embedding")) {
      assert.ok(widths.includes(model.dimensions), `embedding ${model.id} is ${model.dimensions}-dim, which the guide does not cover`);
    }
  });
});

test("API providers cover the local runners people actually use", async () => {
  await withRuntime(async ({ json }) => {
    const { body } = await json("/models");
    const ids = body.api_providers.map((provider) => provider.id);
    for (const expected of ["openai", "ollama", "lmstudio", "tei", "custom"]) {
      assert.ok(ids.includes(expected), `no preset for ${expected}`);
    }
    const ollama = body.api_providers.find((provider) => provider.id === "ollama");
    assert.match(ollama.embedding_url, /^http:\/\/127\.0\.0\.1:11434\//);
    assert.equal(ollama.key_required, false);
    assert.equal(API_PROVIDERS.length, body.api_providers.length);
  });
});

test("a Hugging Face model id is validated before it joins the catalogue", async () => {
  await withRuntime(async ({ json }) => {
    const malformed = await json("/models/custom", {
      method: "POST",
      body: JSON.stringify({ kind: "embedding", model_id: "not-a-model-id" }),
    });
    assert.equal(malformed.status, 400);
    assert.match(malformed.body.detail, /作者\/模型名稱/);

    const wrongKind = await json("/models/custom", {
      method: "POST",
      body: JSON.stringify({ kind: "vector", model_id: "Xenova/all-MiniLM-L6-v2" }),
    });
    assert.equal(wrongKind.status, 400);

    // Already shipped: adding it again would create two entries that download
    // to the same cache directory.
    const duplicate = await json("/models/custom", {
      method: "POST",
      body: JSON.stringify({ kind: "embedding", model_id: "Xenova/bge-m3", dimensions: 1024 }),
    });
    assert.equal(duplicate.status, 400);
    assert.match(duplicate.body.detail, /已經/);
  });
});

test("a custom model survives a restart and can be removed", async () => {
  const root = await mkdtemp(join(tmpdir(), "kcc-catalogue-restart-"));
  const options = {
    dataFile: join(root, "cards.json"),
    modelsDir: join(root, "models"),
    seedPath: join(projectRoot.pathname.slice(1), "desktop", "seed.json"),
    migrateFromUrl: "",
  };

  let runtime = await startLocalApi(options);
  const call = async (base, token, path, init = {}) => {
    const response = await fetch(`${base}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, ...(init.body ? { "Content-Type": "application/json" } : {}), ...init.headers },
    });
    return { status: response.status, body: await response.json() };
  };

  try {
    // Offline-safe: an explicit width means no Hugging Face round trip is
    // required for the entry to be accepted.
    const added = await call(runtime.baseUrl, runtime.authToken, "/models/custom", {
      method: "POST",
      body: JSON.stringify({ kind: "embedding", model_id: "test-org/test-embedding", label: "測試模型", dimensions: 768 }),
    });
    if (added.status !== 201) {
      // Reached Hugging Face and got a real answer: the id does not exist there.
      assert.equal(added.status, 400);
      return;
    }
    assert.equal(added.body.model.dimensions, 768);
    assert.equal(added.body.model.custom, true);

    const id = added.body.model.id;
    await runtime.close();
    runtime = await startLocalApi(options);

    const after = await call(runtime.baseUrl, runtime.authToken, "/models");
    assert.ok(after.body.models.some((model) => model.id === id), "custom model did not survive a restart");

    const removed = await call(runtime.baseUrl, runtime.authToken, `/models/custom/${id}`, { method: "DELETE" });
    assert.equal(removed.status, 200);
    const final = await call(runtime.baseUrl, runtime.authToken, "/models");
    assert.equal(final.body.models.some((model) => model.id === id), false);
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("probing a dead endpoint reports failure instead of throwing", async () => {
  await withRuntime(async ({ json }) => {
    const rejected = await json("/models/api/probe", { method: "POST", body: JSON.stringify({ api_url: "notaurl" }) });
    assert.equal(rejected.status, 400);

    // Port 9 discards everything, so this is a connection failure by design.
    const dead = await json("/models/api/probe", {
      method: "POST",
      body: JSON.stringify({ api_url: "http://127.0.0.1:9/v1/embeddings" }),
    });
    assert.equal(dead.status, 200);
    assert.equal(dead.body.ok, false);
    assert.ok(dead.body.detail.length > 0);
    assert.deepEqual(dead.body.models, []);
  });
});

test("the Hugging Face lookup keeps the org/name separator intact", async () => {
  // Escaping the slash makes the API answer 400 for every namespaced model,
  // which is every model worth adding. The failure looked like "Hugging Face is
  // down" rather than like a bug here, so it is worth pinning.
  const requested = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    requested.push(String(url));
    return new Response(JSON.stringify({ id: "org/name", siblings: [{ rfilename: "onnx/model_quantized.onnx" }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  try {
    const info = await lookupHuggingFace("org/name");
    assert.equal(info.has_onnx, true);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.ok(requested.length > 0);
  assert.ok(requested[0].endsWith("/api/models/org/name"), `requested ${requested[0]}`);
  for (const url of requested) assert.doesNotMatch(url, /%2F/iu);
});

test("a build that bundles weights starts semantic, and one that does not still works", async (t) => {
  const bundled = existsSync(new URL("../build/models/Xenova/paraphrase-multilingual-MiniLM-L12-v2/config.json", import.meta.url));
  await withRuntime(async ({ json }) => {
    const { body } = await json("/health");
    if (!bundled) {
      // No weights fetched: the hash embedding must still be the default, so a
      // plain `npm run build` is never left without an embedding at all.
      assert.equal(body.embedding_model, "embedding-hash-384");
      assert.equal(body.embedding_dimensions, 384);
      t.diagnostic("no bundled weights present; checked the fallback path");
      return;
    }

    // Weights are shipped: a fresh cabinet must already be on the real model
    // rather than waiting for someone to find the settings page.
    assert.equal(body.embedding_model, "embedding-multilingual-384");
    assert.equal(body.embedding_dimensions, 384);
    assert.equal(body.semantic_mode, true);

    const catalogue = await json("/models");
    const model = catalogue.body.models.find((candidate) => candidate.id === "embedding-multilingual-384");
    assert.equal(model.installed, true, "bundled model should need no download");
    assert.equal(model.bundled, true);
    assert.equal(model.storage.status, "ready");

    // Its files are part of the install, so "clean up the cache" is meaningless
    // and must not pretend to work.
    const removal = await json("/models/embedding-multilingual-384", { method: "DELETE" });
    assert.equal(removal.status, 409);
  });
});

test("the simple picker offers a size for tidying and a language for search", async () => {
  await withRuntime(async ({ json }) => {
    const { body } = await json("/models");
    assert.ok(body.simple, "the catalogue exposes no simple choices");

    // Small / medium / large, plus the no-download baseline.
    const tiers = body.simple.summary.map((choice) => choice.tier);
    assert.deepEqual(tiers, ["none", "small", "medium", "large"]);
    for (const choice of body.simple.summary) {
      const model = body.models.find((candidate) => candidate.id === choice.model_id);
      assert.ok(model, `summary tier ${choice.tier} points at a model that does not exist`);
      assert.equal(model.kind, "summary");
      assert.ok(choice.note.length > 0, `tier ${choice.tier} explains nothing`);
    }
    // Sizes must actually increase, or "小中大" is a lie.
    const bytes = body.simple.summary.map((choice) => body.models.find((model) => model.id === choice.model_id).storage.download_size_bytes);
    for (let index = 1; index < bytes.length; index += 1) {
      assert.ok(bytes[index] >= bytes[index - 1], `tier ${tiers[index]} is not larger than ${tiers[index - 1]}`);
    }

    // Every language × dimension pair resolves to something real.
    const languages = new Set(body.simple.embedding.map((choice) => choice.language));
    assert.deepEqual([...languages].sort(), ["en", "multi", "zh"]);
    for (const choice of body.simple.embedding) {
      const model = body.models.find((candidate) => candidate.id === choice.model_id);
      assert.ok(model, `${choice.language}/${choice.dimensions} points at a missing model`);
      assert.equal(model.dimensions, choice.dimensions, "resolved model does not have the promised width");
      // A near-match must say so rather than quietly substituting.
      if (!choice.exact) assert.ok(choice.note.length > 0, `${choice.language}/${choice.dimensions} substitutes silently`);
    }
  });
});

test("the built-in catalogue stays internally consistent", () => {
  const ids = new Set();
  for (const model of MODEL_CATALOG) {
    assert.equal(ids.has(model.id), false, `duplicate model id ${model.id}`);
    ids.add(model.id);
    assert.ok(model.kind === "summary" || model.kind === "embedding");
    if (model.kind === "embedding") assert.ok(model.dimensions > 0, `${model.id} declares no width`);
    if (!model.builtin) assert.ok(model.model_id, `${model.id} is downloadable but names no repository`);
  }
  assert.ok(DIMENSION_GUIDE.length >= 2);
});

test("an embedding API's vector width can be measured before it is saved", async () => {
  // A stand-in for Ollama/LM Studio: OpenAI-compatible, 1024 wide. The point of
  // the probe is that nothing else on the wire reveals this — /models lists
  // names, not shapes — so the only honest answer comes from embedding
  // something and counting.
  const { createServer } = await import("node:http");
  let seenBody = null;
  const service = createServer((request, response) => {
    let text = "";
    request.on("data", (chunk) => { text += chunk; });
    request.on("end", () => {
      seenBody = JSON.parse(text);
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ data: [{ embedding: Array.from({ length: 1024 }, (_, index) => index / 1024) }] }));
    });
  });
  await new Promise((resolve) => service.listen(0, "127.0.0.1", resolve));
  const endpoint = `http://127.0.0.1:${service.address().port}/v1/embeddings`;

  try {
    await withRuntime(async ({ json }) => {
      const probe = await json("/models/api/probe-embedding", {
        method: "POST",
        body: JSON.stringify({ api_url: endpoint, model: "bge-m3", api_format: "openai" }),
      });
      assert.equal(probe.status, 200);
      assert.equal(probe.body.ok, true);
      assert.equal(probe.body.dimensions, 1024, "the probe must report the width the service actually returned");
      assert.equal(seenBody.model, "bge-m3", "the chosen model name has to reach the service, or the width is another model's");
      // An empty library has no width to clash with, so there is nothing to
      // warn about — matches_store stays null rather than pretending to know.
      assert.equal(probe.body.store_dimensions, 0);
      assert.equal(probe.body.matches_store, null);

      await json("/cards", {
        method: "POST",
        body: JSON.stringify({ id: "dimension-probe", number: "D1", topic: "測試主題", category: "測試分類", title: "維度測試", question: "這張卡在問什麼？", summary: "一句話摘要。", analogy: "像是某個比喻。", detail: "比較長的說明內容。", source: "catalogue-test", tags: ["測試"] }),
      });
      const after = await json("/models/api/probe-embedding", {
        method: "POST",
        body: JSON.stringify({ api_url: endpoint, model: "bge-m3", api_format: "openai" }),
      });
      assert.equal(after.body.store_dimensions, 384, "a stored card fixes the library's width");
      assert.equal(after.body.matches_store, false, "1024 against a 384 library must be reported as incompatible");
    });
  } finally {
    await new Promise((resolve) => service.close(resolve));
  }
});

test("a probe against something that is not an embeddings endpoint fails clearly", async () => {
  const { createServer } = await import("node:http");
  const service = createServer((request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: { content: "hello" } }] }));
  });
  await new Promise((resolve) => service.listen(0, "127.0.0.1", resolve));

  try {
    await withRuntime(async ({ json }) => {
      const probe = await json("/models/api/probe-embedding", {
        method: "POST",
        body: JSON.stringify({ api_url: `http://127.0.0.1:${service.address().port}/v1/chat/completions`, model: "x" }),
      });
      assert.equal(probe.body.ok, false);
      assert.equal(probe.body.dimensions, 0);
      assert.match(probe.body.detail, /沒有回傳向量/u);
    });
  } finally {
    await new Promise((resolve) => service.close(resolve));
  }
});
