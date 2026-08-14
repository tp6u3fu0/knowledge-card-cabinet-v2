/**
 * Adopting an existing JSON store.
 *
 * Anyone upgrading has their cabinet sitting in cards.json. The migration runs
 * once, silently, at startup — so it is the one code path where a mistake costs
 * real data. These tests check that everything crosses over and that the
 * original file is left alone as a fallback.
 *
 * Run with:  node --test tests/store-migration.test.mjs
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const { startLocalApi } = require("../desktop/local-api.cjs");

const legacyCard = (id, overrides = {}) => ({
  id,
  number: id.toUpperCase(),
  topic: "遷移主題",
  category: "遷移分類",
  title: `舊卡 ${id}`,
  question: "舊的問題",
  summary: "舊的摘要",
  analogy: "舊的比喻",
  detail: "舊的細節",
  source: "legacy",
  tags: ["舊標籤"],
  cover: { version: 10, seed: "abcdef0123456789", pattern: "orbit", motifs: [] },
  embedding: Array.from({ length: 384 }, (_, index) => (index % 7 === 0 ? 0.05 : -0.02)),
  embedding_model_id: "embedding-hash-384",
  embedding_source_hash: "stale-on-purpose",
  created_at: "2024-01-01T00:00:00.000Z",
  updated_at: "2024-01-02T00:00:00.000Z",
  deleted_at: null,
  ...overrides,
});

async function migrate(store) {
  const root = mkdtempSync(join(tmpdir(), "kcc-migrate-"));
  const dataFile = join(root, "cards.json");
  writeFileSync(dataFile, JSON.stringify(store, null, 2), "utf8");
  const runtime = await startLocalApi({
    dataFile,
    modelsDir: join(root, "models"),
    seedPath: join(process.cwd(), "backend", "seed.json"),
    migrateFromUrl: "",
  });
  const headers = { Authorization: `Bearer ${runtime.authToken}` };
  const get = async (path) => {
    const response = await fetch(`${runtime.baseUrl}/api/v1${path}`, { headers });
    assert.equal(response.ok, true, `GET ${path} → ${response.status}`);
    return response.json();
  };
  return { root, dataFile, runtime, get };
}

test("adopts an existing JSON store without losing anything", async (t) => {
  const legacy = {
    version: 2,
    cards: [legacyCard("keep-one"), legacyCard("keep-two"), legacyCard("in-trash", { deleted_at: "2024-02-01T00:00:00.000Z" })],
    relations: [{
      source_id: "keep-one", target_id: "keep-two", relation_type: "manual",
      score: 1, status: "confirmed", created_at: "2024-01-03T00:00:00.000Z", updated_at: "2024-01-03T00:00:00.000Z",
    }],
    categories: ["遷移分類", "空分類"],
    embedding_model_id: "embedding-hash-384",
    summary_model_id: "summary-template",
  };
  const { root, dataFile, runtime, get } = await migrate(legacy);
  t.after(async () => {
    await runtime.close();
    rmSync(root, { recursive: true, force: true });
  });

  const cards = await get("/cards");
  assert.deepEqual(cards.map((card) => card.id).sort(), ["keep-one", "keep-two"]);

  const card = await get("/cards/keep-one");
  assert.equal(card.title, "舊卡 keep-one");
  assert.equal(card.created_at, "2024-01-01T00:00:00.000Z", "created_at must survive the migration");
  assert.deepEqual(card.tags, ["舊標籤"]);
  assert.ok(card.cover, "the card keeps its cover art");

  const trash = await get("/trash");
  assert.deepEqual(trash.map((item) => item.id), ["in-trash"], "trashed cards migrate as trashed");

  const related = await get("/cards/keep-one/related");
  const manual = related.find((relation) => relation.card.id === "keep-two");
  assert.ok(manual, "a hand-made relation must survive");
  assert.equal(manual.relation_type, "manual");

  const categories = await get("/categories");
  const names = categories.map((item) => item.name);
  assert.ok(names.includes("遷移分類"));
  assert.ok(names.includes("空分類"), "a category with no cards is still a category");

  assert.ok(existsSync(runtime.databaseFile), "the SQLite store was created");
  assert.ok(existsSync(dataFile), "the JSON store is left in place as a fallback");
  assert.deepEqual(
    JSON.parse(readFileSync(dataFile, "utf8")).cards.map((item) => item.id),
    ["keep-one", "keep-two", "in-trash"],
    "the migration must not rewrite the file it read",
  );
});

test("migrates once, then leaves the JSON file behind", async (t) => {
  const legacy = {
    version: 2,
    cards: [legacyCard("only-card")],
    relations: [],
    categories: ["遷移分類"],
    embedding_model_id: "embedding-hash-384",
    summary_model_id: "summary-template",
  };
  const { root, dataFile, runtime, get } = await migrate(legacy);
  const headers = { Authorization: `Bearer ${runtime.authToken}` };

  // Edit through the API, then reopen: the second start must read SQLite, so
  // the edit survives and the untouched JSON file does not resurrect the card.
  await fetch(`${runtime.baseUrl}/api/v1/cards/only-card`, {
    method: "PATCH",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ title: "改過的舊卡" }),
  });
  assert.equal((await get("/cards/only-card")).title, "改過的舊卡");
  await runtime.close();

  const reopened = await startLocalApi({
    dataFile,
    modelsDir: join(root, "models"),
    seedPath: join(process.cwd(), "backend", "seed.json"),
    migrateFromUrl: "",
  });
  t.after(async () => {
    await reopened.close();
    rmSync(root, { recursive: true, force: true });
  });

  const response = await fetch(`${reopened.baseUrl}/api/v1/cards/only-card`, {
    headers: { Authorization: `Bearer ${reopened.authToken}` },
  });
  assert.equal((await response.json()).title, "改過的舊卡", "the stale JSON file must not win on restart");
});

async function freshRuntime(overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), "kcc-fresh-"));
  const runtime = await startLocalApi({
    dataFile: join(root, "cards.json"),
    modelsDir: join(root, "models"),
    seedPath: join(process.cwd(), "backend", "seed.json"),
    migrateFromUrl: "",
    ...overrides,
  });
  const cards = async () => {
    const response = await fetch(`${runtime.baseUrl}/api/v1/cards`, {
      headers: { Authorization: `Bearer ${runtime.authToken}` },
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  return { root, runtime, cards };
}

test("a fresh install starts with no cards", async (t) => {
  // Installing the app must not hand someone a cabinet full of sample cards;
  // the samples ship with the app but are only loaded when asked for.
  const { root, runtime, cards } = await freshRuntime();
  t.after(async () => {
    await runtime.close();
    rmSync(root, { recursive: true, force: true });
  });

  assert.deepEqual(await cards(), [], "a new cabinet is empty");
  assert.ok(existsSync(runtime.databaseFile), "but the store itself is created");
});

test("the sample cards load only when explicitly requested", async (t) => {
  const { root, runtime, cards } = await freshRuntime({ loadSeed: true });
  t.after(async () => {
    await runtime.close();
    rmSync(root, { recursive: true, force: true });
  });

  assert.ok((await cards()).length > 0, "asking for the samples must still work");
});
