/**
 * Retrieval has to work when the model does not.
 *
 * These are the two failures the search endpoint was rewritten to stop making,
 * and neither one announces itself — both look like an empty result list.
 *
 *   1. A card that means the question in different words was found by the
 *      vectors and then dropped, because nothing on it spelled the query out.
 *   2. A card that spells the query out in full was never scored at all,
 *      because its embedding was missing, the wrong width, or the model was
 *      broken. Search embedded the query first and filtered on that width
 *      before it looked at any text.
 *
 * The suite runs against a stand-in embedding service rather than real weights,
 * so it needs no download and no network. The stand-in is not a model and is
 * not pretending to be one: it is a written-down statement of which phrasings a
 * competent model would place together, so that what is being measured here is
 * what the endpoint does with that answer — not how good the answer is.
 *
 * Run with:  node --test tests/retrieval.test.mjs
 */

import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const { lexicalMatch } = require("../desktop/local-api.cjs");
const { startLocalApi } = await import("../desktop/local-api.cjs");

const seedPath = join(new URL("../", import.meta.url).pathname, "desktop", "seed.json");
const WIDTH = 8;

/**
 * Four subjects, and the phrases that belong to each.
 *
 * Both halves of every test pair are listed here — the wording a card uses and
 * the wording somebody types when they have forgotten it. They share no
 * characters with each other on purpose; that is the whole point of the fixture.
 */
const CONCEPTS = [
  { axis: 0, marks: ["先從指定資料來源", "把問題轉成向量後比對", "用語意而不是字面找東西", "模型先查資料再回答"] },
  { axis: 1, marks: ["代理物件", "在方法呼叫前後插入", "在進入控制器之前攔下請求", "不改原本", "前後執行程式"] },
  { axis: 2, marks: ["b-tree", "整表掃描", "決定要不要走索引", "查詢為什麼會變慢"] },
  { axis: 3, marks: ["過半數", "多數決", "任期與投票", "誰說了算"] },
];

function noise(text) {
  const digest = crypto.createHash("sha256").update(text, "utf8").digest();
  return Array.from({ length: WIDTH }, (_, index) => (digest[index] % 7 - 3) * 0.004);
}

/** One-hot on the subject's axis, or on an axis no card occupies when nothing matches. */
function conceptVector(text) {
  const lower = String(text).toLowerCase();
  const vector = noise(lower);
  const concept = CONCEPTS.find((entry) => entry.marks.some((mark) => lower.includes(mark)));
  const axis = concept ? concept.axis : 4 + (crypto.createHash("sha256").update(lower, "utf8").digest()[0] % 4);
  vector[axis] += 1;
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map((value) => value / norm);
}

/**
 * The stand-in service, with two switches the tests throw.
 *
 * `down` refuses everything, which is what a model that will not load looks
 * like from here. `refuse` refuses only text matching a pattern, which is how a
 * single card ends up in the cabinet carrying no vector while every other card
 * has one — the state that used to make it unfindable by its own title.
 */
async function conceptService() {
  const state = { down: false, refuse: null, served: 0 };
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const text = String(JSON.parse(body || "{}").inputs?.[0] ?? "");
    state.served += 1;
    if (state.down || (state.refuse && state.refuse.test(text))) {
      response.statusCode = 503;
      response.end("embedding unavailable");
      return;
    }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify([conceptVector(text)]));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    state,
    url: `http://127.0.0.1:${server.address().port}/embed`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/**
 * Twelve cards, three to a subject.
 *
 * Three and not one, because the collection needs pairs that are alike and
 * pairs that are not before it has a distribution to measure a standout
 * against — with every card its own island there is no spread, `scoreRange`
 * says so, and nothing is ever filtered.
 */
const CARDS = [
  ["rag", "檢索", "RAG 為什麼需要檢索？", "為什麼不能直接請模型憑記憶作答？",
    "RAG 先從指定資料來源找出相關內容，再把內容交給模型生成回答。"],
  ["vector-db", "檢索", "向量資料庫在存什麼？", "為什麼不是存文字就好？",
    "它把問題轉成向量後比對，找出意思接近的段落。"],
  ["semantic-search", "檢索", "語意搜尋和關鍵字搜尋差在哪？", "換個說法為什麼還找得到？",
    "語意搜尋用語意而不是字面找東西，所以換句話說也命中。"],
  ["aop", "切面", "AOP 是什麼？", "共用邏輯要寫幾次？",
    "Spring 透過代理物件，在方法呼叫前後插入共用邏輯。"],
  ["proxy", "切面", "Proxy Pattern 解決什麼？", "要怎麼包住一個物件？",
    "代理物件站在真正的物件前面，替它接住呼叫。"],
  ["interceptor", "切面", "攔截器在哪一層？", "驗證要寫在每個端點裡嗎？",
    "它在進入控制器之前攔下請求，統一處理驗證與紀錄。"],
  ["btree", "索引", "B-tree 索引怎麼加速查詢？", "為什麼不用一直掃？",
    "B-tree 讓查詢走樹狀路徑，不必整表掃描。"],
  ["query-plan", "索引", "查詢計畫在說什麼？", "資料庫怎麼決定做法？",
    "最佳化器讀統計值，決定要不要走索引。"],
  ["slow-query", "索引", "查詢為什麼會變慢？", "資料變多就一定慢嗎？",
    "多半是走了整表掃描，而不是資料量本身。"],
  ["raft", "共識", "Raft 怎麼選出領導者？", "沒有主機時誰決定？",
    "節點用任期與投票決定領導者，取得過半數者當選。"],
  ["quorum", "共識", "為什麼共識需要過半數？", "少數同意不行嗎？",
    "只有過半數才能保證兩次決定不會互相矛盾。"],
  ["dist-lock", "共識", "分散式鎖靠什麼成立？", "誰說了算？",
    "靠一個大家都同意的仲裁者，誰說了算要先講好。"],
];

async function cabinet(t) {
  const root = await mkdtemp(join(tmpdir(), "kcc-retrieval-"));
  const previousBundled = process.env.KCC_BUNDLED_MODELS_DIR;
  process.env.KCC_BUNDLED_MODELS_DIR = join(root, "no-bundled-weights");
  process.env.KCC_UPDATE_CHECK = "off";

  const service = await conceptService();
  const runtime = await startLocalApi({
    dataFile: join(root, "data", "cards.json"),
    modelsDir: join(root, "models"),
    seedPath,
    migrateFromUrl: "",
  });
  t.after(async () => {
    await runtime.close();
    await service.close();
    await rm(root, { recursive: true, force: true });
    if (previousBundled === undefined) delete process.env.KCC_BUNDLED_MODELS_DIR;
    else process.env.KCC_BUNDLED_MODELS_DIR = previousBundled;
  });

  const headers = { Authorization: `Bearer ${runtime.authToken}`, "Content-Type": "application/json" };
  const call = async (method, path, body) => {
    const response = await fetch(`${runtime.baseUrl}/api/v1${path}`, {
      method, headers, body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, body: await response.json() };
  };

  const api = {
    service,
    search: async (query, extra = "") => {
      const result = await call("GET", `/search?q=${encodeURIComponent(query)}&limit=20${extra}`);
      assert.equal(result.status, 200, `search failed: ${JSON.stringify(result.body)}`);
      return result.body;
    },
    add: async ([id, category, title, question, summary]) => {
      const result = await call("POST", "/cards", {
        id, number: id.toUpperCase(), topic: category, category, title, question, summary,
        analogy: "", detail: "", source: "retrieval-fixture", tags: [category],
      });
      assert.equal(result.status, 200, `could not add ${id}: ${JSON.stringify(result.body)}`);
    },
    settle: async (taskId) => {
      for (let attempt = 0; attempt < 400; attempt += 1) {
        const task = await call("GET", `/tasks/${taskId}`);
        if (task.body.status !== "running" && task.body.status !== "queued") return task.body;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error("背景任務沒有結束");
    },
  };

  for (const card of CARDS) await api.add(card);

  // Move the whole cabinet onto the stand-in in one rebuild, which is also what
  // gives the store a semantic_baseline to measure standouts against.
  const switched = await call("PUT", "/settings", {
    summary: { source: "local" },
    embedding: { source: "api", api_url: service.url, api_format: "tei", model: "stand-in" },
  });
  assert.equal(switched.status, 202, JSON.stringify(switched.body));
  const task = await api.settle(switched.body.task_id);
  assert.equal(task.status, "succeeded", JSON.stringify(task));
  return api;
}

const ids = (results) => results.map((card) => card.id);

test("finds a card that means the question in words it does not use", async (t) => {
  const api = await cabinet(t);

  // The premise first: if this query literally appeared on the card there would
  // be nothing to prove. Anything under LEXICAL_MIN_COVERAGE is not a hit.
  const query = "模型先查資料再回答的方法";
  const target = CARDS.find((card) => card[0] === "rag");
  assert.ok(
    lexicalMatch({ title: target[2], question: target[3], summary: target[4], tags: [target[1]], category: target[1], topic: target[1] }, query).found < 0.5,
    "the fixture stopped being a semantic-only case; the query now literally matches the card",
  );

  const results = await api.search(query);
  assert.ok(ids(results).slice(0, 3).includes("rag"), `RAG was not in the top three: ${ids(results).join(", ")}`);
  assert.ok(!ids(results).slice(0, 3).includes("btree"), "an unrelated subject reached the top three");
});

test("finds the card behind a description of what it does", async (t) => {
  const api = await cabinet(t);
  const results = await api.search("不改原本 method 又可以在前後執行程式");
  assert.ok(ids(results).slice(0, 3).includes("aop"), `AOP was not in the top three: ${ids(results).join(", ")}`);
});

test("a card with no vector is still found by its own title", async (t) => {
  const api = await cabinet(t);

  // One card, refused by the embedding service, in a cabinet where everything
  // else embedded cleanly. Search used to embed the query, keep only cards of
  // that width, and score the text afterwards — so this card was not merely
  // ranked low, it was never a candidate.
  api.service.state.refuse = /Spring AOP 的啟用方式/u;
  await api.add(["spring-aop-setup", "切面", "Spring AOP 的啟用方式", "要加什麼註解？", "在設定類別上加上啟用註解即可。"]);
  api.service.state.refuse = null;

  const results = await api.search("Spring AOP 的啟用方式");
  const hit = results.find((card) => card.id === "spring-aop-setup");
  assert.ok(hit, `the card with no vector was dropped: ${ids(results).join(", ")}`);
  assert.equal(hit.semantic_score, null, "a card with no comparable vector must not report a semantic score");
  assert.ok(hit.lexical_score > 0, "it was found on its text, so its text must be what is reported");
  assert.equal(results[0].id, "spring-aop-setup", "an exact title match belongs at the top");
});

test("keyword search keeps working when the embedding model is broken", async (t) => {
  const api = await cabinet(t);
  assert.ok(ids(await api.search("B-tree 索引怎麼加速查詢？")).includes("btree"), "the cabinet was not working to begin with");

  // Not a slow model, not a missing one — a model that answers every request
  // with a failure, which is what a bad endpoint or a corrupt download looks
  // like. The query cannot be embedded at all, so there is no semantic half.
  api.service.state.down = true;

  const results = await api.search("B-tree 索引怎麼加速查詢？");
  assert.ok(ids(results).includes("btree"), `search died with the model: ${ids(results).join(", ")}`);
  assert.equal(results[0].id, "btree");
  assert.ok(results.every((card) => card.semantic_score === null), "nothing can claim a semantic score with no query vector");
  assert.ok(results.every((card) => !card.search_reasons.includes("語意相似")), "nothing can claim semantic similarity with no query vector");
});

test("still answers that there is nothing here about that", async (t) => {
  const api = await cabinet(t);
  // Loosening the lexical half is exactly how the every-query-returns-the-whole-
  // cabinet problem comes back, so the counter-case is part of the suite.
  const results = await api.search("橘子的種植與採收季節");
  assert.deepEqual(ids(results), [], `a cabinet about software answered a question about fruit: ${ids(results).join(", ")}`);
});

test("reports both halves of the score so ranking can be measured", async (t) => {
  const api = await cabinet(t);
  const results = await api.search("為什麼共識需要過半數？");
  const hit = results.find((card) => card.id === "quorum");
  assert.ok(hit, `the card was not returned: ${ids(results).join(", ")}`);
  assert.equal(typeof hit.lexical_score, "number");
  assert.equal(typeof hit.semantic_score, "number");
  assert.ok(hit.search_reasons.includes("標題命中"), `reasons were ${JSON.stringify(hit.search_reasons)}`);
});

test("a Chinese query is matched by what it says, not by being one long word", async (t) => {
  const api = await cabinet(t);
  // "為什麼共識需要過半數？" and "為什麼需要多數決" are the same question and
  // share no whole word, which is why whitespace tokenising scored this zero.
  const match = lexicalMatch(
    { title: "為什麼共識需要過半數？", question: "", summary: "只有過半數才能保證兩次決定不會互相矛盾。", tags: [], category: "共識", topic: "共識" },
    "共識為什麼要過半數",
  );
  assert.ok(match.found >= 0.5, `coverage was only ${match.found}`);
  assert.ok(ids(await api.search("共識為什麼要過半數")).includes("quorum"));
});
