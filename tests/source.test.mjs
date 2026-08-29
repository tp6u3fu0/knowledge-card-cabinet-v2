/**
 * Where a card came from.
 *
 * A card is a cache entry, so its source is the cache origin. A string saying
 * "Spring AOP 的 Notion 筆記" cannot answer the questions that makes worth
 * asking — where is it, has it changed — so the origin is kept in fields
 * beside it (CLAUDE.md §3.18).
 *
 * Two things here are not conveniences. A source url is rendered as a link, so
 * it is a field someone pastes into without reading and it must never carry a
 * scheme a browser would execute. And everything that describes the document
 * has to be dropped when the link moves, or staleness detection will one day
 * compare a card against a document it was never made from.
 *
 * Run with:  node --test tests/source.test.mjs
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

const require = createRequire(import.meta.url);
const { startLocalApi, normalizeSourceMetadata, fetchSourceDigest, canonicalSource, SOURCE_TYPES, SOURCE_CHECK_MAX_BYTES } = require("../desktop/local-api.cjs");
const { openStore, STORE_VERSION } = require("../desktop/store.cjs");

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
  root = await mkdtemp(join(tmpdir(), "kcc-source-"));
  runtime = await startLocalApi({
    dataFile: join(root, "cards.json"),
    modelsDir: join(root, "models"),
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

describe("a source url is a link, so it is treated as one", () => {
  // Each of these would become an anchor's href. None of them may survive.
  for (const hostile of ["javascript:alert(1)", "data:text/html,<script>alert(1)</script>", "file:///etc/passwd", "vbscript:msgbox(1)"]) {
    it(`refuses ${hostile.split(":")[0]}:`, () => {
      const result = normalizeSourceMetadata({ source_url: hostile });
      assert.equal(result.source_url, null, `${hostile} was stored as a link`);
      assert.equal(result.source_type, "manual");
    });
  }

  it("keeps http and https, and drops anything it cannot parse", () => {
    assert.equal(normalizeSourceMetadata({ source_url: "https://arxiv.org/abs/1706.03762" }).source_url, "https://arxiv.org/abs/1706.03762");
    assert.equal(normalizeSourceMetadata({ source_url: "http://localhost:3000/notes" }).source_url, "http://localhost:3000/notes");
    assert.equal(normalizeSourceMetadata({ source_url: "not a url at all" }).source_url, null);
    assert.equal(normalizeSourceMetadata({ source_url: "   " }).source_url, null);
  });

  it("refuses the same schemes over the API, without refusing the card", async () => {
    const created = await ok("POST", "/cards", {
      title: "來源連結有問題的卡",
      source: "某個地方",
      source_url: "javascript:alert(document.cookie)",
    });
    // The card is kept — a bad link is not a reason to lose someone's
    // understanding — but the link is not.
    assert.equal(created.card.title, "來源連結有問題的卡");
    assert.equal(created.card.source, "某個地方");
    assert.equal(created.card.source_url, null);
    assert.equal(created.card.source_type, "manual");
  });
});

describe("the kind of source is read off the link", () => {
  it("recognises a Notion page and pulls its id out", async () => {
    const created = await ok("POST", "/cards", {
      title: "從 Notion 整理出來的卡",
      source_url: "https://www.notion.so/My-Notes-1a2b3c4d5e6f70819a2b3c4d5e6f7081",
    });
    assert.equal(created.card.source_type, "notion");
    assert.equal(created.card.source_external_id, "1a2b3c4d5e6f70819a2b3c4d5e6f7081");
  });

  it("calls everything else a url, and nothing at all manual", () => {
    assert.equal(normalizeSourceMetadata({ source_url: "https://arxiv.org/abs/1706.03762" }).source_type, "url");
    assert.equal(normalizeSourceMetadata({}).source_type, "manual");
    for (const type of SOURCE_TYPES) {
      assert.equal(normalizeSourceMetadata({ source_type: type }).source_type, type);
    }
    assert.equal(normalizeSourceMetadata({ source_type: "spreadsheet" }).source_type, "manual");
  });

  it("re-reads the type when the link moves, but not over a type chosen by hand", () => {
    const wasNotion = { source_type: "notion", source_url: "https://www.notion.so/p-1a2b3c4d5e6f70819a2b3c4d5e6f7081" };
    // A PATCH hands the runtime the card merged with the change, so the stale
    // `notion` arrives alongside the new link. It must not win.
    assert.equal(normalizeSourceMetadata({ ...wasNotion, source_url: "https://example.com/x" }, wasNotion).source_type, "url");
    assert.equal(normalizeSourceMetadata({ ...wasNotion, source_url: "" }, wasNotion).source_type, "manual");

    const chosen = { source_type: "document", source_url: "https://example.com/a.pdf" };
    assert.equal(normalizeSourceMetadata({ ...chosen, source_url: "https://example.com/b.pdf" }, chosen).source_type, "document");
  });
});

describe("what described the old document does not follow the card to a new one", () => {
  const held = {
    source_url: "https://www.notion.so/p-1a2b3c4d5e6f70819a2b3c4d5e6f7081",
    source_type: "notion",
    source_external_id: "1a2b3c4d5e6f70819a2b3c4d5e6f7081",
    source_title: "舊的頁面標題",
    source_content_hash: "deadbeef",
    source_checked_at: "2026-01-01T00:00:00.000Z",
    source_updated_at: "2026-01-01T00:00:00.000Z",
  };

  it("clears every derived field when the link changes", () => {
    const moved = normalizeSourceMetadata({ ...held, source_url: "https://example.com/other" }, held);
    for (const field of ["source_external_id", "source_title", "source_content_hash", "source_checked_at", "source_updated_at"]) {
      assert.equal(moved[field], null, `${field} followed the card to a document it does not describe`);
    }
  });

  it("keeps them when the link did not change", () => {
    const same = normalizeSourceMetadata({ ...held }, held);
    assert.equal(same.source_content_hash, "deadbeef");
    assert.equal(same.source_title, "舊的頁面標題");
  });

  it("keeps a value the caller states in the same breath as the new link", () => {
    const moved = normalizeSourceMetadata({ ...held, source_url: "https://example.com/other", source_content_hash: "cafe" }, held);
    assert.equal(moved.source_content_hash, "cafe");
  });

  it("lets an empty string clear a field", () => {
    assert.equal(normalizeSourceMetadata({ ...held, source_title: "" }, held).source_title, null);
  });
});

describe("going to look at whether a source moved on", () => {
  let origin;
  let body = "第一版的文件內容，長度足夠當成一份文件。";

  before(async () => {
    // A local stand-in for the web. The suite must never reach the network, and
    // this is the feature that would.
    const { createServer } = await import("node:http");
    origin = createServer((request, response) => {
      if (request.url === "/gone") {
        response.writeHead(404).end("nope");
        return;
      }
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8" }).end(body);
    });
    await new Promise((resolve) => origin.listen(0, "127.0.0.1", resolve));
  });

  after(() => origin?.close());

  const sourced = async (title) => {
    const created = await ok("POST", "/cards", {
      title,
      summary: "一張有來源連結的卡。",
      source: "本地測試文件",
      source_url: `http://127.0.0.1:${origin.address().port}/doc`,
    });
    return created.card;
  };

  it("records what is there the first time, then notices when it changes", async () => {
    const card = await sourced("會被改掉的來源");
    const first = await ok("POST", "/sources/check", { card_id: card.id });
    assert.equal(first.status, "recorded");
    assert.ok(first.card.source_content_hash, "the first check recorded nothing to compare against");
    assert.ok(first.card.source_checked_at);
    assert.equal(first.card.source_stale_at, null);

    const again = await ok("POST", "/sources/check", { card_id: card.id });
    assert.equal(again.status, "unchanged");

    body = "第二版的文件內容，已經被人改過了。";
    const changed = await ok("POST", "/sources/check", { card_id: card.id });
    assert.equal(changed.status, "changed");
    assert.ok(changed.card.source_stale_at, "a changed source left no mark on the card");
  });

  it("never rewrites the card, whatever the source now says", async () => {
    const all = await ok("GET", "/cards");
    const card = all.find((item) => item.title === "會被改掉的來源");
    // The card holds what the reader understood at the time. The source moving
    // on is a thing to be told about, not a thing to be overwritten by.
    assert.equal(card.title, "會被改掉的來源");
    assert.equal(card.summary, "一張有來源連結的卡。");
    assert.equal(card.source, "本地測試文件");
  });

  it("clears the mark when the reader says they have looked", async () => {
    const all = await ok("GET", "/cards");
    const card = all.find((item) => item.title === "會被改掉的來源");
    const accepted = await ok("POST", "/sources/accept", { card_id: card.id });
    assert.equal(accepted.status, "accepted");
    assert.equal(accepted.card.source_stale_at, null);
    assert.equal(accepted.card.title, "會被改掉的來源", "accepting the new version rewrote the card");
    const after = await ok("POST", "/sources/check", { card_id: card.id });
    assert.equal(after.status, "unchanged");
  });

  it("says it does not know, rather than saying it changed, when it cannot look", async () => {
    const created = await ok("POST", "/cards", {
      title: "連不到的來源",
      source_url: `http://127.0.0.1:${origin.address().port}/gone`,
    });
    const result = await ok("POST", "/sources/check", { card_id: created.card.id });
    assert.equal(result.status, "unreachable");
    assert.equal(result.card.source_stale_at, null, "a failed look was reported as a change");
  });

  it("refuses a card with no link at all", async () => {
    const created = await ok("POST", "/cards", { title: "沒有來源連結的卡" });
    const refused = await call("POST", "/sources/check", { card_id: created.card.id });
    assert.equal(refused.status, 422);
  });

  it("source stream stops at configured cap", async () => {
    // The cap has to be on what is downloaded, not on what is hashed. Proving
    // that from inside the client is awkward — heap measurements are noise —
    // so the proof is taken from the other end of the socket: a server that
    // wants to send 20 MB and is told to stop cannot have sent 20 MB.
    const { createHash } = await import("node:crypto");
    const { createServer } = await import("node:http");

    const CHUNK = 256 * 1024;
    const TOTAL = 20 * 1024 * 1024;
    const filler = Buffer.alloc(CHUNK, 0x61);
    let written = 0;
    let stoppedEarly = false;
    let handlerDone;
    const finished = new Promise((resolve) => { handlerDone = resolve; });

    const big = createServer(async (request, response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      for (let sent = 0; sent < TOTAL; sent += CHUNK) {
        if (response.writableEnded || response.destroyed || request.destroyed) {
          stoppedEarly = true;
          handlerDone();
          return;
        }
        // Honour backpressure, or the whole 20 MB lands in the socket buffer
        // and the test proves nothing about what the client asked for.
        if (!response.write(filler)) {
          const drained = await new Promise((resolve) => {
            const onDrain = () => { response.off("close", onClose); resolve(true); };
            const onClose = () => { response.off("drain", onDrain); resolve(false); };
            response.once("drain", onDrain);
            response.once("close", onClose);
          });
          if (!drained) {
            stoppedEarly = true;
            handlerDone();
            return;
          }
        }
        written += CHUNK;
      }
      response.end();
      handlerDone();
    });
    await new Promise((resolve) => big.listen(0, "127.0.0.1", resolve));

    try {
      const url = `http://127.0.0.1:${big.address().port}/huge`;
      const digest = await fetchSourceDigest(url);

      // Correct: the hash is the hash of the first cap-many bytes.
      const expected = createHash("sha256").update(Buffer.alloc(SOURCE_CHECK_MAX_BYTES, 0x61)).digest("hex");
      assert.equal(digest, expected, "the digest is not the hash of the first MAX_BYTES");

      // The reader cancelling and the server noticing are two ends of a socket,
      // so wait for the sending side to settle before reading its counters.
      await finished;

      // Bounded: the transfer was stopped. Some slack for the socket buffers
      // that were already in flight when the reader cancelled — the claim
      // being tested is "not the whole document", not an exact byte count.
      assert.ok(written < TOTAL / 2, `the server sent ${written} of ${TOTAL} bytes before being stopped`);
      assert.equal(stoppedEarly, true, "the server ran to completion; nothing cancelled the stream");
    } finally {
      big.close();
    }
  });

  it("still gives up on a source that never answers", async () => {
    // The cap must not have quietly replaced the timeout: a server that holds
    // the connection open and sends nothing is the other way this can hang.
    const { createServer } = await import("node:http");
    const silent = createServer((request, response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      // Deliberately never written to and never ended.
    });
    await new Promise((resolve) => silent.listen(0, "127.0.0.1", resolve));
    try {
      const started = Date.now();
      await assert.rejects(() => fetchSourceDigest(`http://127.0.0.1:${silent.address().port}/hang`));
      assert.ok(Date.now() - started < 20000, "the timeout did not fire");
    } finally {
      silent.close();
      silent.closeAllConnections?.();
    }
  });

  it("does not call a page changed because its nonce changed", async () => {
    // The acceptance case. A page whose article has not changed a word still
    // arrives with a fresh CSP nonce, a new analytics id and a rendered
    // timestamp. Hashing the raw response marks the card stale every time,
    // and a prompt that is wrong most times it appears is one people stop
    // reading.
    const article = "<h1>AOP 是什麼？</h1><p>用代理物件包住方法&nbsp;&amp; 前後各留一個切入點。</p>";
    const dressed = (nonce, at) => Buffer.from(
      `<!doctype html><html><head><title>AOP</title>`
      + `<script nonce="${nonce}">window.__HYDRATE={at:${at}}</script>`
      + `<style>.a{color:#${nonce}}</style><meta name="csrf" content="${nonce}"></head>`
      + `<body>${article}<!-- built ${at} --><script>track("${nonce}")</script></body></html>`, "utf8");

    const first = canonicalSource(dressed("aaa111", 1), "text/html; charset=utf-8");
    const second = canonicalSource(dressed("zzz999", 2), "text/html; charset=utf-8");
    assert.equal(first, second, "the same article fingerprinted differently because its wrapper moved");
    assert.match(first, /AOP 是什麼？/u, "the article itself was stripped out along with the wrapper");
    assert.doesNotMatch(first, /nonce|track|__HYDRATE|csrf/u, "machinery survived into the fingerprint");
    // Entities are resolved, so &amp; and & are the same document.
    assert.match(first, /方法 & 前後/u);

    // And a real change is still a change.
    const rewritten = canonicalSource(
      Buffer.from(`<html><body><h1>AOP 是什麼？</h1><p>完全改寫過的內文。</p></body></html>`, "utf8"),
      "text/html",
    );
    assert.notEqual(rewritten, first, "rewriting the article did not change the fingerprint");
  });

  it("normalises text and leaves bytes alone", () => {
    const text = (value) => canonicalSource(Buffer.from(value, "utf8"), "text/plain");
    assert.equal(text("a\r\n  b\n\nc  "), "a b c", "the same text differed from itself over line endings");
    assert.equal(text("  spaced   out  "), "spaced out");
    assert.equal(canonicalSource(Buffer.from("{ \"a\": 1 }", "utf8"), "application/json"), '{ "a": 1 }');
    // A PDF has no text form to normalise, and pretending otherwise would
    // fingerprint the decoding rather than the document.
    const pdf = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0x01]);
    assert.ok(Buffer.isBuffer(canonicalSource(pdf, "application/pdf")));
    assert.equal(canonicalSource(pdf, "application/pdf").equals(pdf), true);
  });

  it("sees through a changed wrapper end to end", async () => {
    // The same thing again, but through the route, so the canonicalisation is
    // actually reached by a source check rather than only unit-tested.
    const { createServer } = await import("node:http");
    let nonce = "first";
    const site = createServer((request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<html><head><script nonce="${nonce}">var t=${Date.now()};</script></head>`
        + `<body><h1>一篇沒有改過的文章</h1><p>內文從頭到尾都一樣。</p></body></html>`);
    });
    await new Promise((resolve) => site.listen(0, "127.0.0.1", resolve));
    try {
      const created = await ok("POST", "/cards", {
        title: "指向一個會換 nonce 的頁面",
        source_url: `http://127.0.0.1:${site.address().port}/article`,
      });
      const recorded = await ok("POST", "/sources/check", { card_id: created.card.id });
      assert.equal(recorded.status, "recorded");
      nonce = "second";
      await new Promise((resolve) => setTimeout(resolve, 5));
      const again = await ok("POST", "/sources/check", { card_id: created.card.id });
      assert.equal(again.status, "unchanged", "a new nonce and timestamp read as the article changing");
      assert.equal(again.card.source_stale_at, null);
    } finally {
      site.close();
    }
  });

  it("can be switched off entirely, like the update check", async () => {
    const elsewhere = await mkdtemp(join(tmpdir(), "kcc-source-off-"));
    try {
      const quiet = await startLocalApi({
        dataFile: join(elsewhere, "cards.json"),
        modelsDir: join(elsewhere, "models"),
        seedPath: "",
        migrateFromUrl: "",
        sourceCheckEnabled: false,
      });
      try {
        const response = await fetch(`${quiet.baseUrl}/api/v1/sources/check`, {
          method: "POST",
          headers: { Authorization: `Bearer ${quiet.authToken}`, "content-type": "application/json" },
          body: JSON.stringify({ card_id: "anything" }),
        });
        assert.equal(response.status, 409);
      } finally {
        await quiet.close();
      }
    } finally {
      await rm(elsewhere, { recursive: true, force: true });
    }
  });
});

describe("cards that predate all of this", () => {
  it("reads an old card back with its source intact", async () => {
    const created = await ok("POST", "/cards", { id: "attention", number: "AI-001", title: "Attention 是什麼？", source: "Attention Is All You Need" });
    assert.equal(created.card.source, "Attention Is All You Need");
    assert.equal(created.card.source_url, null);
    assert.equal(created.card.source_type, "manual");

    // And is still there after a round through the database.
    const read = await ok("GET", "/cards/attention");
    assert.equal(read.source, "Attention Is All You Need");
  });

  it("adds the columns to a database that was made without them", async () => {
    const older = await mkdtemp(join(tmpdir(), "kcc-source-old-"));
    try {
      const dataFile = join(older, "cards.json");
      // A store as it stood before the source columns existed.
      const first = openStore(dataFile);
      first.replaceAll({
        version: 2,
        cards: [{ id: "old", number: "KC-000001", title: "舊資料庫裡的卡", source: "舊來源", tags: [], category: "舊分類", topic: "舊分類" }],
        relations: [],
        categories: ["舊分類"],
        category_accents: {},
      });
      first.close?.();
      // Drop the columns back off, which is what an actual old file looks like.
      const { DatabaseSync } = await import("node:sqlite");
      const raw = new DatabaseSync(join(older, "cards.db"));
      for (const column of ["source_type", "source_title", "source_url", "source_external_id", "source_updated_at", "source_content_hash", "source_checked_at", "source_stale_at", "last_opened_at", "resurface_muted_at"]) {
        raw.exec(`ALTER TABLE cards DROP COLUMN ${column}`);
      }
      raw.close();

      const reopened = openStore(dataFile);
      const store = reopened.load();
      assert.equal(store.cards.length, 1, "the migration lost the card");
      assert.equal(store.cards[0].source, "舊來源", "the migration lost the source it already had");
      assert.equal(store.cards[0].source_url, null, "a card that predates the column should read back as null");
      reopened.close?.();
    } finally {
      await rm(older, { recursive: true, force: true });
    }
  });

  it("carries the fields through an export and back", async () => {
    await ok("POST", "/cards", {
      id: "sourced",
      title: "有來源連結的卡",
      source: "arXiv",
      source_url: "https://arxiv.org/abs/1706.03762",
    });
    const backup = await ok("GET", "/database/export");
    const exported = backup.cards.find((card) => card.id === "sourced");
    assert.equal(exported.source_url, "https://arxiv.org/abs/1706.03762");
    assert.equal(exported.source_type, "url");

    const imported = await ok("POST", "/database/import", { ...backup, conflict_strategy: "replace" });
    assert.ok(imported, "the backup did not import");
    const read = await ok("GET", "/cards/sourced");
    assert.equal(read.source_url, "https://arxiv.org/abs/1706.03762");
    assert.equal(read.source_type, "url");
  });

  it("says which schema it is on", () => {
    assert.equal(STORE_VERSION, 4);
  });
});
