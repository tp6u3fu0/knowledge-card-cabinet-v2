/**
 * Bringing back what nobody remembered to look for.
 *
 * Search answers "I know I wrote this down somewhere". It structurally cannot
 * answer "I forgot I ever knew this", and that second kind of forgetting is the
 * expensive one. This is the only feature in the cabinet aimed at it.
 *
 * The tests here mostly guard against it becoming something else. Every line
 * that checks a limit — one card, once a day, muteable forever, no schedule —
 * is holding the boundary against spaced repetition, which is a different
 * product and one this deliberately is not (CLAUDE.md §9).
 *
 * Run with:  node --test tests/resurface.test.mjs
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

const require = createRequire(import.meta.url);
const { startLocalApi, RESURFACE_QUIET_DAYS, deviceMayReach } = require("../desktop/local-api.cjs");

let runtime;
let root;
let base;
let headers;

const daysAgo = (days) => new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

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
  root = await mkdtemp(join(tmpdir(), "kcc-resurface-"));
  runtime = await startLocalApi({ dataFile: join(root, "cards.json"), modelsDir: join(root, "models"), seedPath: "", migrateFromUrl: "" });
  base = `${runtime.baseUrl}/api/v1`;
  headers = { Authorization: `Bearer ${runtime.authToken}` };

  // Cards old enough to have been forgotten. created_at is a field the API
  // already accepts — imports and backups carry their own — so no test here
  // needs to reach past the runtime into its database.
  for (let index = 0; index < 6; index += 1) {
    await ok("POST", "/cards", {
      title: `很久以前整理的卡 ${index + 1}`,
      summary: `當時讀懂了，現在只剩下模糊印象 ${index + 1}。`,
      created_at: daysAgo(RESURFACE_QUIET_DAYS + 120 + index * 10),
    });
  }
});

after(async () => {
  if (runtime) await runtime.close();
  if (root) await rm(root, { recursive: true, force: true });
});

describe("what the cabinet offers on its own", () => {
  // First, because it is the one test that needs the once-a-day gate to be
  // untouched — every other test asks on purpose with force=1.
  it("offers at most one card, roughly once a day", async () => {
    const first = await ok("GET", "/resurface");
    assert.ok(first.card, "nothing was offered at all");
    // One card. Not three, not a list, not a queue to work through.
    assert.equal(Array.isArray(first.card), false);
    assert.match(first.reason, /個月/u, "the reason does not say how long it has been");

    const second = await ok("GET", "/resurface");
    assert.equal(second.card, null, "a second look at the page produced a second suggestion");
    assert.ok(second.quiet_until_hours > 0);

    // Asking on purpose is a different thing from the page reloading.
    const asked = await ok("GET", "/resurface?force=1");
    assert.ok(asked.card, "asking for another one on purpose was refused");
  });

  it("says nothing about a card that was only written today", async () => {
    const fresh = await ok("POST", "/cards", { title: "今天剛整理的卡", summary: "剛寫的東西不需要被提醒。" });
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const offered = await ok("GET", "/resurface?force=1");
      assert.notEqual(offered.card?.id, fresh.card.id, "a card written today was offered back");
      if (!offered.card) break;
    }
  });

  it("brings back the card that has waited longest", async () => {
    const all = await ok("GET", "/cards");
    const aged = all.filter((card) => card.created_at < daysAgo(RESURFACE_QUIET_DAYS) && !card.last_opened_at);
    const oldest = aged.sort((first, second) => first.created_at.localeCompare(second.created_at))[0];
    const offered = await ok("GET", "/resurface?force=1");
    assert.equal(offered.card.id, oldest.id, "something newer was offered ahead of the oldest card");
  });

  it("stops offering a card the moment it is read", async () => {
    const before = await ok("GET", "/resurface?force=1");
    assert.ok(before.card, "nothing to read in this test");
    await ok("POST", `/cards/${encodeURIComponent(before.card.id)}/opened`);
    const after = await ok("GET", "/resurface?force=1");
    assert.notEqual(after.card?.id, before.card.id, "a card just read came straight back");
  });

  it("records reading a card without touching when it was changed", async () => {
    const created = await ok("POST", "/cards", { title: "只是被讀過的卡", summary: "讀不是改。" });
    const changedAt = created.card.updated_at;
    const recorded = await ok("POST", `/cards/${encodeURIComponent(created.card.id)}/opened`);
    assert.equal(recorded.status, "recorded");
    const read = await ok("GET", `/cards/${encodeURIComponent(created.card.id)}`);
    assert.equal(read.updated_at, changedAt, "reading a card marked it as edited");
    assert.ok(read.last_opened_at, "reading a card was not recorded at all");
  });
});

describe("the limits that keep it from becoming a review app", () => {
  it("never offers a muted card again", async () => {
    const offered = await ok("GET", "/resurface?force=1");
    assert.ok(offered.card, "nothing was offered to mute");
    await ok("POST", `/cards/${encodeURIComponent(offered.card.id)}/mute-resurface`);
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const next = await ok("GET", "/resurface?force=1");
      assert.notEqual(next.card?.id, offered.card.id, "a muted card was offered again");
      if (!next.card) break;
    }
  });

  it("skips past a card without silencing it", async () => {
    const first = await ok("GET", "/resurface?force=1");
    assert.ok(first.card);
    const second = await ok(
      "GET",
      `/resurface?force=1&exclude=${encodeURIComponent(first.card.id)}`,
    );
    assert.notEqual(second.card?.id, first.card.id);
    // Skipping is "not now". The card is still eligible the next time round.
    const again = await ok("GET", "/resurface?force=1");
    assert.ok(again.card, "skipping one card emptied the whole pool");
  });

  it("carries no score, no interval and no streak", async () => {
    const offered = await ok("GET", "/resurface?force=1");
    if (!offered.card) return;
    for (const field of ["ease", "interval", "due_at", "streak", "review_count", "next_review"]) {
      assert.equal(field in offered.card, false, `the card carries ${field}; this is not a review app`);
    }
  });

  it("lets a paired phone be reminded, but never lets one reach the network", () => {
    assert.equal(deviceMayReach("GET", ["resurface"]), true);
    assert.equal(deviceMayReach("POST", ["cards", "abc", "opened"]), true);
    // A phone left on a table must not be able to aim the host at an address
    // only the host can see.
    assert.equal(deviceMayReach("POST", ["sources", "check"]), false);
    assert.equal(deviceMayReach("POST", ["sources", "accept"]), false);
    assert.equal(deviceMayReach("GET", ["sources"]), false);
  });
});
