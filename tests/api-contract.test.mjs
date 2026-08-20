/**
 * Behavioural contract for the card API.
 *
 * `runtime-contract.mjs` only checks that a runtime *advertises* the right
 * capabilities. This suite checks what the endpoints actually do — lifecycle,
 * ranking, relation caps, category rules, backup integrity — because that is
 * the part that drifts silently.
 *
 * It runs against the embedded Node runtime in a throwaway directory. Point
 * KCC_CONTRACT_URL / KCC_CONTRACT_TOKEN at another runtime to check parity
 * against it; never aim that at a store you care about, the suite writes.
 *
 * Run with:  node --test tests/api-contract.test.mjs
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

const require = createRequire(import.meta.url);
const { startLocalApi, deviceMayReach } = require("../desktop/local-api.cjs");

/** Mirrors RELATION_LIMIT in desktop/local-api.cjs and RELATED_LIMIT in backend config. */
const RELATION_LIMIT = 6;

let runtime;
let root;
let base;
let headers;

/** Raw call — returns status alongside the body so error cases stay assertable. */
async function call(method, path, body) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: body ? { ...headers, "content-type": "application/json" } : headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

/** Call that must succeed — returns the body directly. */
async function ok(method, path, body) {
  const result = await call(method, path, body);
  assert.equal(result.status, 200, `${method} ${path} → ${result.status}: ${JSON.stringify(result.body)}`);
  return result.body;
}

/** A complete card; tests override only the fields they are about. */
function cardInput(id, overrides = {}) {
  return {
    id,
    number: id.toUpperCase(),
    topic: "測試主題",
    category: "測試分類",
    title: `卡片 ${id}`,
    question: "這張卡在問什麼？",
    summary: "一句話摘要。",
    analogy: "像是某個比喻。",
    detail: "比較長的說明內容。",
    source: "contract-test",
    tags: ["測試"],
    ...overrides,
  };
}

before(async () => {
  // The suite must never reach the network. The update check's own logic is
  // covered against a stubbed GitHub in tests/update-check.test.mjs; what is
  // checked here is only that the route is wired, guarded, and honours this.
  process.env.KCC_UPDATE_CHECK = "off";
  if (process.env.KCC_CONTRACT_URL) {
    base = `${process.env.KCC_CONTRACT_URL}/api/v1`;
    headers = { Authorization: `Bearer ${process.env.KCC_CONTRACT_TOKEN ?? ""}` };
    return;
  }
  root = await mkdtemp(join(tmpdir(), "kcc-api-contract-"));
  runtime = await startLocalApi({
    dataFile: join(root, "cards.json"),
    modelsDir: join(root, "models"),
    seedPath: join(process.cwd(), "desktop", "seed.json"),
    migrateFromUrl: "",
  });
  base = `${runtime.baseUrl}/api/v1`;
  headers = { Authorization: `Bearer ${runtime.authToken}` };
});

after(async () => {
  if (runtime) await runtime.close();
  if (root) await rm(root, { recursive: true, force: true });
});

describe("what a paired device is allowed to ask for", () => {
  // The table rather than the server: this is a policy, and it should be
  // readable as one. Every line that says false is something a stolen phone
  // cannot do to the cabinet it was paired with.
  const allowed = [
    ["GET", ["cards"]], ["POST", ["cards"]], ["PATCH", ["cards", "abc"]], ["DELETE", ["cards", "abc"]],
    ["POST", ["cards", "draft"]], ["GET", ["cards", "duplicates"]],
    ["GET", ["categories"]], ["POST", ["categories", "merge"]],
    ["GET", ["search"]], ["GET", ["trash"]], ["DELETE", ["trash", "abc"]],
    ["GET", ["settings"]], ["GET", ["tasks"]], ["GET", ["tasks", "abc"]], ["GET", ["app", "version"]],
  ];
  const refused = [
    ["PUT", ["settings"]], ["POST", ["tasks", "abc", "cancel"]], ["POST", ["tasks", "abc", "retry"]],
    ["GET", ["models"]], ["POST", ["models", "select"]], ["DELETE", ["models", "abc"]],
    ["GET", ["database", "export"]], ["POST", ["database", "import"]], ["POST", ["database", "reset"]],
    ["GET", ["devices"]], ["POST", ["devices", "pairing-code"]], ["DELETE", ["devices", "abc"]],
    ["GET", ["network", "lan"]], ["POST", ["network", "lan"]],
    // Readable routes are named one at a time, never by prefix.
    ["GET", ["app"]], ["GET", ["app", "logs"]], ["GET", ["settings", "secret"]],
  ];

  it("lets a phone do the whole of the card job", () => {
    for (const [method, segments] of allowed) {
      assert.equal(deviceMayReach(method, segments), true, `${method} /${segments.join("/")} should be allowed`);
    }
  });

  it("lets a phone read the host's state and change none of it", () => {
    for (const [method, segments] of refused) {
      assert.equal(deviceMayReach(method, segments), false, `${method} /${segments.join("/")} should be refused`);
    }
  });
});

describe("which build this is", () => {
  const declared = JSON.parse(readFileSync(new URL("../desktop/package.json", import.meta.url), "utf8")).version;

  it("names its version in health, where a bug report can find it", async () => {
    const health = await ok("GET", "/health");
    assert.equal(health.version, declared);
    assert.equal(health.status, "ok");
  });

  it("reports the running version whether or not it can look one up", async () => {
    const version = await ok("GET", "/app/version");
    assert.equal(version.version, declared);
    // Switched off means switched off: no answer about a newer release, and
    // above all no request made to find one out.
    assert.equal(version.update_check, "off");
    assert.equal(version.update_available, false);
    assert.equal(version.latest_version, null);
  });

  it("keeps the update route behind the token", async () => {
    const response = await fetch(`${base}/app/version`);
    assert.equal(response.status, 401, "an unauthenticated caller can make the app reach the network");
  });
});

describe("authentication", () => {
  it("rejects a request with no token", async () => {
    const response = await fetch(`${base}/cards`);
    assert.equal(response.status, 401);
  });

  it("rejects a request with the wrong token", async () => {
    const response = await fetch(`${base}/cards`, { headers: { Authorization: "Bearer nope" } });
    assert.equal(response.status, 401);
  });

  it("issues a one-time device pairing code without revealing stored device tokens", async () => {
    const issued = await ok("POST", "/devices/pairing-code");
    assert.match(issued.code, /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}$/u);
    assert.ok(Date.parse(issued.expires_at) > Date.now());

    const paired = await call("POST", "/devices/pair", { code: issued.code.replace("-", " "), name: "測試 iPhone" });
    assert.equal(paired.status, 200);
    assert.match(paired.body.token, /^kcc_dv_/u);
    assert.equal(paired.body.device.name, "測試 iPhone");

    const replay = await call("POST", "/devices/pair", { code: issued.code, name: "重試裝置" });
    assert.equal(replay.status, 422, "a pairing code must only create one device token");

    const devices = await ok("GET", "/devices");
    assert.equal(devices.length, 1);
    assert.ok(!("token" in devices[0]), "the device list must never return a token");
  });

  it("lets a device token access cards but not host administration, and supports revocation", async () => {
    const issued = await ok("POST", "/devices/pairing-code");
    const paired = await call("POST", "/devices/pair", { code: issued.code, name: "撤銷測試裝置" });
    const deviceHeaders = { Authorization: `Bearer ${paired.body.token}` };

    assert.equal((await fetch(`${base}/cards`, { headers: deviceHeaders })).status, 200);

    // A phone may look at the host and may not touch it. Without the reading
    // half its settings page could only ever be a page about the phone; with
    // the writing half, a lost phone could repoint the model or empty the
    // cabinet. Named one by one — a new route under /app is not readable
    // until somebody decides it is.
    for (const path of ["/settings", "/tasks", "/app/version"]) {
      assert.equal((await fetch(`${base}${path}`, { headers: deviceHeaders })).status, 200, `${path} is not readable from a paired device`);
    }
    assert.equal((await fetch(`${base}/app/anything-else`, { headers: deviceHeaders })).status, 403);

    // The host's own secrets stay the host's, even in what a device can read.
    const visible = await (await fetch(`${base}/settings`, { headers: deviceHeaders })).json();
    assert.equal(Object.hasOwn(visible.embedding, "api_key"), false, "a device can read the embedding API key");
    assert.equal(Object.hasOwn(visible.summary, "api_key"), false, "a device can read the summary API key");

    const changes = [
      ["PUT", "/settings"],
      ["POST", "/models/select"],
      ["GET", "/models"],
      ["GET", "/database/export"],
      ["POST", "/database/reset"],
      ["GET", "/devices"],
      ["POST", "/devices/pairing-code"],
      ["GET", "/network/lan"],
    ];
    for (const [method, path] of changes) {
      const status = (await fetch(`${base}${path}`, { method, headers: deviceHeaders })).status;
      assert.equal(status, 403, `${method} ${path} is reachable from a paired device`);
    }
    await ok("DELETE", `/devices/${paired.body.device.id}`);
    assert.equal((await fetch(`${base}/cards`, { headers: deviceHeaders })).status, 401);
  });

  it("only removes a device record once the device has been revoked", async () => {
    const issued = await ok("POST", "/devices/pairing-code");
    const paired = await call("POST", "/devices/pair", { code: issued.code, name: "刪除測試裝置" });
    const id = paired.body.device.id;

    // Removing the record is tidying up, not the thing that cuts a phone off.
    // Skipping revocation would let a live device vanish from the list.
    const early = await call("DELETE", `/devices/${id}?purge=1`);
    assert.equal(early.status, 409);
    assert.ok((await ok("GET", "/devices")).some((device) => device.id === id));

    await ok("DELETE", `/devices/${id}`);
    const removed = await ok("DELETE", `/devices/${id}?purge=1`);
    assert.equal(removed.status, "removed");
    assert.ok(!(await ok("GET", "/devices")).some((device) => device.id === id));
    assert.equal((await call("DELETE", `/devices/${id}?purge=1`)).status, 404);
  });
});

describe("audit log", () => {
  it("records the authenticated actor, not merely that a header was sent", async (t) => {
    if (!root) return t.skip("audit file only reachable for the embedded runtime");
    await fetch(`${base}/cards`, { headers: { Authorization: "Bearer wrong-token" } });
    await ok("GET", "/cards");

    const lines = (await readFile(join(root, "audit.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    const rejected = lines.findLast((entry) => entry.status === 401);
    const accepted = lines.findLast((entry) => entry.status === 200 && entry.route.endsWith("/cards"));

    assert.ok(rejected, "a rejected request must still be audited");
    assert.equal(rejected.actor, "anonymous", "a failed attempt must not be logged as authenticated");
    assert.equal(accepted.actor, "api-token");
    assert.ok(Number.isFinite(accepted.duration_ms), "entries carry duration_ms like the server runtime");
  });
});

describe("card lifecycle", () => {
  const id = "lifecycle-card";

  it("creates a card and reports the embedding model it used", async () => {
    const created = await ok("POST", "/cards", cardInput(id));
    assert.equal(created.card.id, id);
    assert.ok(created.embedding_model, "response must name the embedding model");
    assert.ok(created.card.cover, "a new card must get a cover");
    assert.ok(Array.isArray(created.suggested_relations));
  });

  it("rejects a card missing a required field", async () => {
    const result = await call("POST", "/cards", { id: "broken", number: "B1" });
    assert.equal(result.status, 422);
  });

  it("reads the card back with the fields the front-end renders", async () => {
    const card = await ok("GET", `/cards/${id}`);
    for (const field of ["number", "topic", "category", "title", "question", "summary", "analogy", "detail", "tags", "cover"]) {
      assert.ok(field in card, `public card is missing ${field}`);
    }
    assert.ok(!("embedding" in card), "raw embeddings must not leak to clients");
  });

  it("lists active cards ordered by number", async () => {
    const cards = await ok("GET", "/cards");
    const numbers = cards.map((card) => card.number);
    assert.deepEqual(numbers, [...numbers].sort((first, second) => first.localeCompare(second)));
    assert.ok(cards.every((card) => !card.deleted_at), "the list must not contain trashed cards");
  });

  it("patches a field while keeping created_at", async () => {
    const before = await ok("GET", `/cards/${id}`);
    const patched = await ok("PATCH", `/cards/${id}`, { title: "改過的標題" });
    assert.equal(patched.card.title, "改過的標題");
    assert.equal(patched.card.created_at, before.created_at, "editing must not reset created_at");
    assert.equal(patched.card.question, before.question, "unlisted fields must survive a patch");
  });

  it("defaults a missing category to the topic rather than leaving it blank", async () => {
    const created = await ok("POST", "/cards", cardInput("no-category", { category: undefined, topic: "回填主題" }));
    assert.equal(created.card.category, "回填主題");
  });

  it("moves a deleted card to the trash instead of dropping it", async () => {
    const deleted = await ok("DELETE", `/cards/${id}`);
    assert.equal(deleted.status, "trashed");
    assert.equal((await call("GET", `/cards/${id}`)).status, 404);

    const trash = await ok("GET", "/trash");
    const trashed = trash.find((card) => card.id === id);
    assert.ok(trashed, "the card should be in the trash");
    assert.ok(trashed.deleted_at, "a trashed card must carry deleted_at");
  });

  it("restores a trashed card", async () => {
    const restored = await ok("POST", `/cards/${id}/restore`);
    assert.equal(restored.status, "restored");
    assert.equal((await ok("GET", `/cards/${id}`)).id, id);
    assert.ok(!(await ok("GET", "/trash")).some((card) => card.id === id));
  });

  it("permanently deletes only from the trash", async () => {
    assert.equal((await call("DELETE", `/trash/${id}`)).status, 404, "an active card must not be purgeable");
    await ok("DELETE", `/cards/${id}`);
    assert.equal((await ok("DELETE", `/trash/${id}`)).status, "deleted");
    assert.equal((await call("GET", `/cards/${id}`)).status, 404);
  });
});

describe("search", () => {
  before(async () => {
    await ok("POST", "/cards", cardInput("search-alpha", {
      title: "向量索引怎麼運作",
      topic: "資料庫",
      category: "資料庫",
      tags: ["索引", "效能"],
      detail: "HNSW 是一種近似最近鄰搜尋結構。",
    }));
    await ok("POST", "/cards", cardInput("search-beta", {
      title: "快取失效策略",
      topic: "系統設計",
      category: "系統設計",
      tags: ["效能"],
      detail: "快取失效是命名之外最難的事。",
    }));
  });

  it("marks a keyword hit in the reasons", async () => {
    const results = await ok("GET", "/search?q=HNSW&limit=10");
    const hit = results.find((card) => card.id === "search-alpha");
    assert.ok(hit, "an exact substring should be found");
    assert.ok(hit.search_reasons.includes("關鍵字命中"), `reasons were ${JSON.stringify(hit.search_reasons)}`);
  });

  it("gives partial credit for a multi-word query", async () => {
    // Both words appear, but not as one contiguous phrase. A binary
    // whole-string match would score this 0 and bury the card.
    const results = await ok("GET", "/search?q=向量 HNSW&limit=10");
    const hit = results.find((card) => card.id === "search-alpha");
    assert.ok(hit, "a query whose words all appear should still rank");
    assert.ok(hit.score > 0);
  });

  it("filters by category and says so", async () => {
    const results = await ok("GET", "/search?q=效能&category=資料庫&limit=10");
    assert.ok(results.length > 0);
    assert.ok(results.every((card) => card.category === "資料庫"));
    assert.ok(results[0].search_reasons.includes("同分類"));
  });

  it("filters by tag", async () => {
    const results = await ok("GET", "/search?q=效能&tag=索引&limit=10");
    assert.ok(results.every((card) => card.tags.includes("索引")));
    assert.ok(results.every((card) => card.search_reasons.includes("共享標籤")));
  });

  it("marks 語意相似 relative to the query, not against a fixed cosine", async () => {
    // A strong model scores every card in a narrow high band, so a fixed
    // threshold labels either all of the results or none. The label is only
    // useful if it distinguishes within a single query's own results — which
    // needs enough cards for the query to have a distribution at all.
    for (let index = 0; index < 8; index += 1) {
      await ok("POST", "/cards", cardInput(`spread-${index}`, {
        title: `索引與查詢效能 ${index}`,
        detail: index % 2 === 0 ? "索引讓查詢跳過整表掃描。" : "完全不相干的內容，講的是天氣。",
      }));
    }
    const results = await ok("GET", "/search?q=索引與查詢效能&limit=20");
    assert.ok(results.length > 2, "need several results to compare against");
    const labelled = results.filter((card) => card.search_reasons.includes("語意相似"));
    assert.ok(labelled.length > 0, "something must qualify");
    assert.ok(labelled.length < results.length, "but not everything can qualify");
  });

  it("honours the limit", async () => {
    assert.ok((await ok("GET", "/search?q=效能&limit=1")).length <= 1);
  });

  it("sorts by title when asked", async () => {
    const titles = (await ok("GET", "/search?q=效能&sort=title&limit=10")).map((card) => card.title);
    assert.deepEqual(titles, [...titles].sort((first, second) => first.localeCompare(second)));
  });

  it("never returns trashed cards", async () => {
    await ok("POST", "/cards", cardInput("search-trashed", { title: "只會出現在垃圾桶的卡" }));
    await ok("DELETE", "/cards/search-trashed");
    const results = await ok("GET", "/search?q=只會出現在垃圾桶的卡&limit=10");
    assert.ok(!results.some((card) => card.id === "search-trashed"));
    await ok("DELETE", "/trash/search-trashed");
  });
});

describe("relations", () => {
  before(async () => {
    // Enough neighbours that the per-card cap has something to cut.
    for (let index = 0; index < RELATION_LIMIT + 4; index += 1) {
      await ok("POST", "/cards", cardInput(`rel-${index}`, {
        title: `關聯測試卡 ${index}`,
        topic: "關聯",
        category: "關聯",
        tags: ["關聯"],
      }));
    }
  });

  it("caps how many relations one card returns", async () => {
    // Without a cap a dense cluster gives every card an edge to every other,
    // and the canvas turns into a hairball.
    const related = await ok("GET", "/cards/rel-0/related");
    assert.ok(related.length <= RELATION_LIMIT, `got ${related.length} relations, cap is ${RELATION_LIMIT}`);
  });

  it("never returns the same neighbour twice", async () => {
    // Rebuilding relations for several cards at once reaches each pair from
    // both ends. The store's primary key hides the duplicate on write, so it
    // surfaces only in what the API serves — until the next restart.
    const related = await ok("GET", "/cards/rel-0/related");
    const ids = related.map((relation) => relation.card.id);
    assert.equal(new Set(ids).size, ids.length, `duplicate neighbours: ${ids.join(", ")}`);
  });

  it("confirms a manual relation and shows it with its own reason", async () => {
    const confirmed = await ok("POST", "/cards/rel-0/relations/rel-1/confirm");
    assert.equal(confirmed.relation_type, "manual");
    assert.equal(confirmed.status, "confirmed");
    // Stored under a sorted key so the pair is the same edge from either side.
    assert.ok(confirmed.source_id < confirmed.target_id);

    const related = await ok("GET", "/cards/rel-0/related");
    const manual = related.find((relation) => relation.card.id === "rel-1");
    assert.ok(manual, "a confirmed relation must appear from the source card");
    assert.equal(manual.relation_type, "manual");
    assert.equal(manual.reason, "自製關聯");

    const reverse = await ok("GET", "/cards/rel-1/related");
    assert.ok(reverse.some((relation) => relation.card.id === "rel-0"), "and from the target card");

    // The pair now holds a suggested relation as well as the confirmed one;
    // it is still one neighbour, and the confirmed one is what to show.
    assert.equal(related.filter((relation) => relation.card.id === "rel-1").length, 1);
  });

  it("keeps the cap with manual relations in the mix", async () => {
    for (let index = 2; index < RELATION_LIMIT + 4; index += 1) {
      await ok("POST", `/cards/rel-0/relations/rel-${index}/confirm`);
    }
    const related = await ok("GET", "/cards/rel-0/related");
    assert.ok(related.length <= RELATION_LIMIT, `manual relations escaped the cap: ${related.length}`);
  });

  it("deletes a manual relation", async () => {
    assert.equal((await ok("DELETE", "/cards/rel-0/relations/rel-1")).status, "deleted");
    assert.equal((await call("DELETE", "/cards/rel-0/relations/rel-1")).status, 404, "deleting twice must 404");
  });

  it("refuses to relate a card to itself", async () => {
    assert.equal((await call("POST", "/cards/rel-0/relations/rel-0/confirm")).status, 404);
  });

  it("drops relations when a card is purged", async () => {
    await ok("POST", "/cards/rel-2/relations/rel-3/confirm");
    await ok("DELETE", "/cards/rel-3");
    await ok("DELETE", "/trash/rel-3");
    const related = await ok("GET", "/cards/rel-2/related");
    assert.ok(!related.some((relation) => relation.card.id === "rel-3"), "a purged card must leave no dangling edge");
  });
});

describe("categories", () => {
  it("creates a category and rejects a duplicate name", async () => {
    assert.equal((await ok("POST", "/categories", { name: "新分類" })).name, "新分類");
    assert.equal((await call("POST", "/categories", { name: "新分類" })).status, 409);
    assert.equal((await call("POST", "/categories", { name: "   " })).status, 422);
  });

  it("renames a category and moves its cards", async () => {
    // Creating a card in a category is enough to register it — posting the
    // category as well would be a duplicate.
    await ok("POST", "/cards", cardInput("cat-card", { category: "改名前", topic: "改名前" }));
    const renamed = await ok("PATCH", "/categories/改名前", { name: "改名後" });
    assert.equal(renamed.name, "改名後");
    assert.equal(renamed.affected_cards, 1);
    assert.equal((await ok("GET", "/cards/cat-card")).category, "改名後");
  });

  it("protects 待分類 from being renamed", async () => {
    assert.equal((await call("PATCH", "/categories/待分類", { name: "別的名字" })).status, 409);
  });

  it("merges a category into another", async () => {
    await ok("POST", "/cards", cardInput("merge-card", { category: "來源分類", topic: "來源分類" }));
    const merged = await ok("POST", "/categories/merge", { source: "來源分類", target: "改名後" });
    assert.equal(merged.name, "改名後");
    assert.ok(merged.affected_cards >= 1);
    assert.equal((await ok("GET", "/cards/merge-card")).category, "改名後");
    assert.ok(!(await ok("GET", "/categories")).some((item) => item.name === "來源分類"));
  });

  it("refuses to merge a category into itself", async () => {
    assert.equal((await call("POST", "/categories/merge", { source: "改名後", target: "改名後" })).status, 409);
  });
});

describe("backup integrity", () => {
  it("exports a checksummed payload that imports back", async () => {
    const exported = await ok("GET", "/database/export");
    assert.equal(exported.format_version, 2, "the desktop and server formats must stay on one version");
    assert.ok(exported.checksum_sha256, "an export without a checksum cannot be verified on import");

    const preview = await ok("POST", "/database/import/preview", exported);
    assert.equal(preview.valid, true);
    assert.ok(preview.summary.cards >= 1, "preview must report what would be written");
    // Re-importing the store it came from changes nothing — a preview that
    // claimed otherwise would scare the user off their own backup.
    assert.equal(preview.summary.added_cards, 0);
    assert.equal(preview.summary.removed_cards, 0);
  });

  it("rejects a payload whose checksum does not match its contents", async () => {
    // The whole point of the checksum: a half-copied or edited backup must not
    // silently overwrite a good store.
    const exported = await ok("GET", "/database/export");
    exported.cards[0].title = "被竄改的標題";
    const result = await call("POST", "/database/import/preview", exported);
    assert.equal(result.status, 400, "a tampered payload must be refused");
    assert.equal(result.body.valid, false);
  });

  it("accepts a payload with no checksum at all", async () => {
    // A backup from another implementation cannot carry a checksum this runtime
    // would agree with, so arriving without one is the supported way in.
    const exported = await ok("GET", "/database/export");
    delete exported.checksum_sha256;
    assert.equal((await ok("POST", "/database/import/preview", exported)).valid, true);
  });

  it("rebuilds vectors on import so search is not left empty", async () => {
    // Imported cards arrive without usable vectors — they came from another
    // model or another runtime — and search deliberately skips cards that have
    // none. Without a rebuild here the cabinet looks empty until a restart.
    const exported = await ok("GET", "/database/export");
    delete exported.checksum_sha256;
    exported.cards = exported.cards.map((card) => ({ ...card, embedding: null, embedding_model_id: null }));
    exported.conflict_strategy = "update";

    const result = await ok("POST", "/database/import", exported);
    assert.ok(result.imported.reindexed_cards > 0, "the import must re-embed what it brought in");

    const target = exported.cards.find((card) => card.title);
    const found = await ok("GET", `/search?q=${encodeURIComponent(target.title)}&limit=10`);
    assert.ok(found.some((card) => card.id === target.id), "an imported card must be findable immediately");
  });

  it("rejects an unknown format version", async () => {
    const exported = await ok("GET", "/database/export");
    const result = await call("POST", "/database/import/preview", { ...exported, format_version: 99 });
    assert.equal(result.status, 400);
  });
});

describe("tidying a card takes care of itself", () => {
  // These two were the applyable half of a batch panel: you selected cards,
  // previewed, and applied. They are cheap enough to do on the way in, and a
  // cabinet that never needs tidying is better than one with a tidy button.
  it("spells a tag the way the cabinet already spells it", async () => {
    await ok("POST", "/cards", cardInput("tidy-first", { title: "第一張", tags: ["RAG", "向量檢索"] }));
    const second = await ok("POST", "/cards", cardInput("tidy-second", { title: "第二張", tags: ["rag", "  Rag ", "向量檢索"] }));
    assert.deepEqual(second.card.tags, ["RAG", "向量檢索"], "a tag arrived in its own spelling, and twice");
  });

  it("files a card under its topic when no category is given", async () => {
    const created = await ok("POST", "/cards", { ...cardInput("tidy-third", { title: "第三張" }), category: undefined });
    assert.equal(created.card.category, created.card.topic);
  });

  it("leaves an explicit category alone", async () => {
    const created = await ok("POST", "/cards", cardInput("tidy-fourth", { title: "第四張", topic: "主題甲", category: "待分類" }));
    assert.equal(created.card.category, "待分類", "a deliberate 待分類 was overwritten");
  });
});

describe("duplicates", () => {
  // `\W` looked like the way to strip punctuation from a title and is not:
  // with `\w` meaning [A-Za-z0-9_], every Chinese character counts as
  // punctuation, so all-Chinese titles normalised to "" and matched each other.
  // A cabinet written in Chinese reported itself as entirely duplicate.
  it("does not call two different Chinese titles the same", async () => {
    await ok("POST", "/cards", cardInput("dup-a", { title: "檢索增強生成", summary: "甲的內容與乙毫不相干。", analogy: "甲。", detail: "甲甲甲。" }));
    await ok("POST", "/cards", cardInput("dup-b", { title: "重新排序", summary: "乙談的是另一件事。", analogy: "乙。", detail: "乙乙乙。" }));
    const { duplicates } = await ok("GET", "/cards/duplicates");
    const pair = duplicates.find((item) => [item.source_id, item.target_id].includes("dup-a") && [item.source_id, item.target_id].includes("dup-b"));
    assert.ok(!pair || pair.reason !== "標題相同", "two unrelated Chinese titles were called identical");
  });

  it("still catches the same title twice, punctuation aside", async () => {
    await ok("POST", "/cards", cardInput("dup-c", { title: "檢索、增強生成" }));
    const { duplicates } = await ok("GET", "/cards/duplicates");
    const pair = duplicates.find((item) => [item.source_id, item.target_id].includes("dup-a") && [item.source_id, item.target_id].includes("dup-c"));
    assert.ok(pair, "a title differing only by punctuation was not caught");
    assert.equal(pair.reason, "標題相同");
    assert.ok(pair.source_title && pair.target_title, "the pair does not say which cards it means");
  });

  // The first version of this compared a raw cosine against 0.9, which §1.3
  // says nothing useful about: on a strong multilingual model 0.9 is an
  // ordinary score for two cards that merely belong together, so a real
  // cabinet reported most of itself as duplicate. It now takes both a score at
  // the top of this collection's own range and the same wording.
  it("does not call two cards on one subject a duplicate", async () => {
    await ok("POST", "/cards", cardInput("near-a", {
      title: "向量檢索的召回率",
      question: "召回率不夠時要看哪裡？",
      summary: "召回率描述檢索器把該找到的文件找回來的比例。",
      analogy: "像撒網，網目太大就會漏掉魚。",
      detail: "提高召回通常從切塊大小與查詢改寫著手，代價是精確率下降。",
    }));
    await ok("POST", "/cards", cardInput("near-b", {
      title: "重排序模型",
      question: "重排序放在管線的哪一段？",
      summary: "重排序在初步檢索之後，對候選文件重新評分。",
      analogy: "像複試，先海選再細看。",
      detail: "交叉編碼器一次讀入查詢與文件，準確但昂貴，所以只處理前幾十筆。",
    }));
    const { duplicates } = await ok("GET", "/cards/duplicates");
    const pair = duplicates.find((item) => [item.source_id, item.target_id].includes("near-a") && [item.source_id, item.target_id].includes("near-b"));
    assert.ok(!pair, `two related but different cards were called duplicates: ${JSON.stringify(pair)}`);
  });

  it("still catches the same card typed in under a new title", async () => {
    const original = cardInput("copy-a", {
      title: "查詢改寫",
      question: "為什麼要改寫使用者的查詢？",
      summary: "使用者的問句往往太短，改寫後才有足夠的詞可以比對。",
      analogy: "像把口語的問題翻成書面語再去查目錄。",
      detail: "常見做法是用模型補上同義詞與缺少的主詞，再送進檢索器。",
    });
    await ok("POST", "/cards", original);
    await ok("POST", "/cards", { ...original, id: "copy-b", number: "COPY-B", title: "改寫查詢" });
    const { duplicates } = await ok("GET", "/cards/duplicates");
    const pair = duplicates.find((item) => [item.source_id, item.target_id].includes("copy-a") && [item.source_id, item.target_id].includes("copy-b"));
    assert.ok(pair, "the same card entered twice went unnoticed");
    assert.equal(pair.reason, "內容幾乎相同");
    assert.ok(pair.score > 0.5, `the reported overlap is not the wording overlap: ${pair.score}`);
  });

  // The case that killed the similarity half of the rule: measured on a
  // four-card cabinet, this pair scored 0.29 against the collection's own
  // range while two unrelated cards scored 1.00 — the model reads 「檢索增強
  // 生成」 and 「RAG」 as fairly different titles, so it votes against exactly
  // what this is looking for. The wording does not.
  it("catches a retyped card even when the title and question both changed", async () => {
    const body = {
      summary: "把外部文件接進生成流程，答案可以引用來源。",
      analogy: "像開書考試，重點是查得到。",
      detail: "先檢索再生成，適合知識會變動的場景，改索引就好，不必重訓。",
    };
    await ok("POST", "/cards", cardInput("retype-a", { title: "檢索增強生成", question: "什麼時候該用檢索增強生成？", ...body }));
    await ok("POST", "/cards", cardInput("retype-b", { title: "RAG", question: "RAG 適合哪些情況？", ...body }));
    const { duplicates } = await ok("GET", "/cards/duplicates");
    const pair = duplicates.find((item) => [item.source_id, item.target_id].includes("retype-a") && [item.source_id, item.target_id].includes("retype-b"));
    assert.ok(pair, "the same card under two titles went unnoticed");
    assert.equal(pair.reason, "內容幾乎相同");
  });

  it("no longer offers a batch organiser", async () => {
    const result = await call("POST", "/cards/batch/organize", { card_ids: [], apply: false });
    assert.equal(result.status, 404);
    const root = await ok("GET", "");
    assert.ok(!root.capabilities.includes("cards.batch.organize"), "the capability list still advertises it");
  });
});
