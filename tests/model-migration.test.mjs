/**
 * Changing embedding model must not empty the cabinet while it happens.
 *
 * `/search` embeds the query with the active model and then keeps only cards
 * whose vector is the same width. So if a switch takes effect before the cards
 * are converted, every unconverted card is invisible — and conversion is the
 * slow part. Measured on a 91-card cabinet moving from BGE-M3 to
 * EmbeddingGemma, the first search after the switch returned one card, and full
 * results did not come back for fifteen seconds.
 *
 * The rule now is: convert first, switch last, in one step. These tests drive
 * the real API through a stand-in embedding service, so they need no weights
 * and no network.
 *
 * Run with:  node --test tests/model-migration.test.mjs
 */

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const { openStore } = require("../desktop/store.cjs");
const { startLocalApi } = await import("../desktop/local-api.cjs");

const seedPath = join(new URL("../", import.meta.url).pathname, "desktop", "seed.json");

/**
 * An embedding service that answers slowly.
 *
 * The delay is the point: a rebuild that finishes instantly cannot show whether
 * the cabinet was searchable *during* it.
 */
async function slowEmbeddingApi({ width = 16, delay = 70 } = {}) {
  let served = 0;
  const server = createServer((request, response) => {
    served += 1;
    setTimeout(() => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify([Array.from({ length: width }, (_, index) => (index % 3 === 0 ? 0.02 : -0.01))]));
    }, delay);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}/embed`,
    width,
    get served() { return served; },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

async function cabinet(t, cards = 15) {
  const root = await mkdtemp(join(tmpdir(), "kcc-migrate-"));
  // No bundled weights, so the cabinet starts on the built-in hash embedding —
  // available everywhere, and a different width from the stand-in service.
  const previousBundled = process.env.KCC_BUNDLED_MODELS_DIR;
  process.env.KCC_BUNDLED_MODELS_DIR = join(root, "no-bundled-weights");

  const runtime = await startLocalApi({
    dataFile: join(root, "data", "cards.json"),
    modelsDir: join(root, "models"),
    seedPath,
    migrateFromUrl: "",
  });
  t.after(async () => {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
    if (previousBundled === undefined) delete process.env.KCC_BUNDLED_MODELS_DIR;
    else process.env.KCC_BUNDLED_MODELS_DIR = previousBundled;
  });

  const headers = { Authorization: `Bearer ${runtime.authToken}`, "Content-Type": "application/json" };
  const api = {
    get: async (path) => (await fetch(`${runtime.baseUrl}${path}`, { headers })).json(),
    post: async (path, body) => {
      const response = await fetch(`${runtime.baseUrl}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
      return { status: response.status, body: await response.json() };
    },
    put: async (path, body) => {
      const response = await fetch(`${runtime.baseUrl}${path}`, { method: "PUT", headers, body: JSON.stringify(body) });
      return { status: response.status, body: await response.json() };
    },
    patch: async (path, body) => {
      const response = await fetch(`${runtime.baseUrl}${path}`, { method: "PATCH", headers, body: JSON.stringify(body) });
      return { status: response.status, body: await response.json() };
    },
    hits: async (query) => (await api.get(`/search?q=${encodeURIComponent(query)}&limit=50`)).length,
    /** Read the file, not the API: the point is what was actually committed. */
    stored: () => {
      const store = openStore(join(root, "data", "cards.json")).load();
      const live = store.cards.filter((card) => !card.deleted_at);
      return {
        model: store.embedding_model_id,
        widths: [...new Set(live.map((card) => card.embedding?.length ?? 0))].sort((a, b) => a - b),
        count: live.length,
      };
    },
    settle: async (taskId) => {
      for (let attempt = 0; attempt < 400; attempt += 1) {
        const task = await api.get(`/tasks/${taskId}`);
        if (task.status !== "running" && task.status !== "queued") return task;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error("背景任務沒有結束");
    },
  };

  for (let index = 0; index < cards; index += 1) {
    const { status } = await api.post("/cards", {
      id: `card-${index}`, number: `T-${index}`, topic: "測試", category: "測試",
      title: `卡片 ${index}`, summary: `這是第 ${index} 張測試卡片的內容。`,
    });
    assert.equal(status, 200);
  }
  return api;
}

const switchToApi = (url) => ({
  summary: { source: "local" },
  embedding: { source: "api", api_url: url, api_format: "tei", model: "stand-in" },
});

test("the cabinet stays searchable while its embedding model changes", async (t) => {
  const service = await slowEmbeddingApi();
  t.after(() => service.close());
  const api = await cabinet(t);

  const before = api.stored();
  assert.equal(before.count, 15);
  assert.equal(await api.hits("卡片"), 15, "the cabinet is not searchable to begin with");

  const started = await api.put("/settings", switchToApi(service.url));
  assert.equal(started.status, 202);

  // The whole point: sample repeatedly *while* the rebuild runs.
  const samples = [];
  for (;;) {
    samples.push(await api.hits("卡片"));
    const task = await api.get(`/tasks/${started.body.task_id}`);
    if (task.status !== "running" && task.status !== "queued") break;
  }
  assert.ok(samples.length >= 3, `only sampled ${samples.length} times; the stand-in service is answering too fast to test anything`);
  assert.deepEqual(
    [...new Set(samples)], [15],
    `search shrank during the rebuild: ${samples.join(", ")}`,
  );

  const task = await api.settle(started.body.task_id);
  assert.equal(task.status, "succeeded");
  const after = api.stored();
  assert.deepEqual(after.widths, [service.width], "the new vectors were never put into service");
  assert.equal(await api.hits("卡片"), 15);
});

test("cancelling a rebuild leaves the cabinet exactly as it was", async (t) => {
  const service = await slowEmbeddingApi({ delay: 120 });
  t.after(() => service.close());
  const api = await cabinet(t);

  const before = api.stored();
  const started = await api.put("/settings", switchToApi(service.url));
  assert.equal(started.status, 202);
  await new Promise((resolve) => setTimeout(resolve, 300));
  await api.post(`/tasks/${started.body.task_id}/cancel`, {});
  const task = await api.settle(started.body.task_id);

  assert.equal(task.status, "cancelled");
  // Not merely "still works" — byte for byte the cabinet it was before. A
  // cancelled switch that applied half its vectors would be far worse than one
  // that never started.
  assert.deepEqual(api.stored(), before, "a cancelled rebuild changed the cabinet");
  assert.equal((await api.get("/settings")).embedding.source, "local", "a cancelled rebuild still switched the setting");
  assert.equal(await api.hits("卡片"), 15);
});

test("a card written during a rebuild is not left behind on the old model", async (t) => {
  const service = await slowEmbeddingApi();
  t.after(() => service.close());
  const api = await cabinet(t);

  const started = await api.put("/settings", switchToApi(service.url));
  assert.equal(started.status, 202);

  // Written after staging began, so it carries a vector from the model being
  // retired; and an edit, so a staged vector no longer describes its wording.
  const added = await api.post("/cards", {
    id: "mid-flight", number: "T-MID", topic: "測試", category: "測試",
    title: "重建期間新增", summary: "這張卡在切換模型的過程中被寫入。",
  });
  assert.equal(added.status, 200);
  // And an edit, so that a vector already staged no longer describes the card's
  // wording by the time it would be committed.
  const edited = await api.patch("/cards/card-0", { summary: "重建期間改寫過的內容。" });
  assert.equal(edited.status, 200);

  const task = await api.settle(started.body.task_id);
  assert.equal(task.status, "succeeded");

  const after = api.stored();
  assert.equal(after.count, 16);
  assert.deepEqual(after.widths, [service.width], `mixed widths after the rebuild: ${after.widths.join(", ")}`);
  assert.equal(await api.hits("重建期間"), 16);
});
