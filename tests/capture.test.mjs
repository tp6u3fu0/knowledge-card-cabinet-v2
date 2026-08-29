/**
 * What it costs to keep an understanding.
 *
 * The cabinet used to refuse a card unless the writer had first chosen an id,
 * a number and a topic. Three decisions nobody reading the card later has any
 * use for, standing in front of the one thing the product is for — and the
 * point at which "I'll organise it later" starts, which is how a cabinet dies
 * (CLAUDE.md §1 P-04).
 *
 * These tests hold the floor at one field. They also hold the two rules that
 * make automatic identity safe rather than merely convenient: a number is
 * handed out once and never recomputed, and anything the caller brings with it
 * is obeyed.
 *
 * Run with:  node --test tests/capture.test.mjs
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

const require = createRequire(import.meta.url);
const { startLocalApi, generateCardId, nextCardNumber } = require("../desktop/local-api.cjs");

let runtime;
let root;
let base;
let headers;

async function call(method, path, body) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: body ? { ...headers, "content-type": "application/json" } : headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

async function ok(method, path, body) {
  const result = await call(method, path, body);
  assert.equal(result.status, 200, `${method} ${path} → ${result.status}: ${JSON.stringify(result.body)}`);
  return result.body;
}

before(async () => {
  process.env.KCC_UPDATE_CHECK = "off";
  root = await mkdtemp(join(tmpdir(), "kcc-capture-"));
  runtime = await startLocalApi({
    dataFile: join(root, "cards.json"),
    modelsDir: join(root, "models"),
    // Empty on purpose: numbering starts at one only in a cabinet that starts
    // at nothing, and that is what a fresh install is (CLAUDE.md §9).
    seedPath: "",
    migrateFromUrl: "",
  });
  base = `${runtime.baseUrl}/api/v1`;
  headers = { Authorization: `Bearer ${runtime.authToken}` };
});

after(async () => {
  if (runtime) await runtime.close();
  if (root) await rm(root, { recursive: true, force: true });
});

describe("a card costs one field", () => {
  it("keeps a card that arrives with nothing but a title", async () => {
    const created = await ok("POST", "/cards", { title: "AOP 是什麼？" });
    assert.equal(created.card.title, "AOP 是什麼？");
    assert.ok(created.card.id.length > 0, "the runtime must mint an id");
    assert.match(created.card.number, /^KC-\d{6}$/);
    assert.equal(created.card.category, "待分類");
    // Not blank: the topic is shown next to the number in the trash list and
    // on the card face, and quick capture never asks for one.
    assert.equal(created.card.topic, "待分類");
  });

  it("still refuses a card nobody could recognise in a list", async () => {
    const refused = await call("POST", "/cards", { question: "沒有標題的卡片", summary: "沒有標題的卡片" });
    assert.equal(refused.status, 422);
    assert.match(refused.body.detail, /title/);
  });

  it("fills the topic from the category when capture only asked for one", async () => {
    const created = await ok("POST", "/cards", { title: "Proxy Pattern 解決什麼？", category: "設計模式" });
    assert.equal(created.card.category, "設計模式");
    assert.equal(created.card.topic, "設計模式");
  });

  it("hands out numbers in order without reusing one", async () => {
    const first = await ok("POST", "/cards", { title: "第一張自動編號的卡" });
    const second = await ok("POST", "/cards", { title: "第二張自動編號的卡" });
    assert.equal(Number(second.card.number.slice(3)) - Number(first.card.number.slice(3)), 1);

    // Trashing a card must not free its number: restoring it later would then
    // collide with whatever was handed out in the meantime.
    await ok("DELETE", `/cards/${encodeURIComponent(second.card.id)}`);
    const third = await ok("POST", "/cards", { title: "第三張自動編號的卡" });
    assert.notEqual(third.card.number, second.card.number);
    assert.equal(Number(third.card.number.slice(3)) - Number(second.card.number.slice(3)), 1);
  });

  it("obeys an id and a number the caller brought with them", async () => {
    const created = await ok("POST", "/cards", { id: "attention-v2", number: "AI-005", title: "Attention 是什麼？" });
    assert.equal(created.card.id, "attention-v2");
    assert.equal(created.card.number, "AI-005");

    // A number in another scheme is not counted and not rewritten. The next
    // automatic one carries on from the cabinet's own sequence.
    const next = await ok("POST", "/cards", { title: "接在自訂編號之後的卡" });
    assert.match(next.card.number, /^KC-\d{6}$/);
    const still = await ok("GET", "/cards/attention-v2");
    assert.equal(still.number, "AI-005");
  });

  it("never renumbers or re-identifies a card that already exists", async () => {
    const created = await ok("POST", "/cards", { title: "會被改很多次的卡", category: "資料庫" });
    const { id, number } = created.card;
    const moved = await ok("PATCH", `/cards/${encodeURIComponent(id)}`, { category: "分散式系統", title: "改過標題的卡" });
    assert.equal(moved.card.id, id);
    assert.equal(moved.card.number, number);
    // The same rule as the colour a card is painted (CLAUDE.md §3.5): assigned
    // once, because it is part of how the reader recognises it.
    const rewritten = await ok("POST", "/cards", { id, title: "再寫一次同一張卡" });
    assert.equal(rewritten.card.number, number);
  });
});

describe("the identity the runtime mints", () => {
  it("sorts by the moment it was created", () => {
    const early = generateCardId(1_700_000_000_000);
    const late = generateCardId(1_800_000_000_000);
    assert.ok(early < late, `${early} should sort before ${late}`);
    assert.equal(early.length, 26);
  });

  it("does not repeat itself within one millisecond", () => {
    const at = Date.now();
    const ids = new Set(Array.from({ length: 500 }, () => generateCardId(at)));
    assert.equal(ids.size, 500);
  });

  it("uses no letter that can be misread as a digit", () => {
    for (const id of Array.from({ length: 200 }, () => generateCardId())) {
      assert.doesNotMatch(id, /[ILOU]/, `${id} contains a character that reads as another`);
    }
  });

  it("counts the trash and ignores everything that is not its own scheme", () => {
    assert.equal(nextCardNumber([]), "KC-000001");
    assert.equal(nextCardNumber([{ number: "AI-005" }, { number: "" }, { number: null }]), "KC-000001");
    assert.equal(nextCardNumber([{ number: "KC-000041" }, { number: "KC-000042", deleted_at: "2026-01-01" }]), "KC-000043");
  });
});
