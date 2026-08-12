const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { URL } = require("node:url");
const { createModelRuntime } = require("./model-runtime.cjs");

const EMBEDDING_DIMENSIONS = 384;
const COVER_VERSION = 8;
const MOTIF_SIZE = 8.4;
const MOTIF_SHAPES = ["block", "stair", "corner", "zigzag", "stack", "window", "plus", "frame"];
const MOTIF_LAYOUT = [
  [11, 11, 0], [37, 11, 0], [63, 11, 0],
  [89, 11, 90], [89, 37, 90], [89, 63, 90],
  [89, 89, 180], [63, 89, 180], [37, 89, 180],
  [11, 89, 270], [11, 63, 270], [11, 37, 270],
];
const PALETTES = [
  { accent: "coral", color: "#c96f5f", soft_color: "#f0d5cc", background: "#fbf1eb" },
  { accent: "sky", color: "#4e91a8", soft_color: "#d7e8ed", background: "#eef7f8" },
  { accent: "lavender", color: "#8068a4", soft_color: "#e4dced", background: "#f5f0f8" },
  { accent: "mint", color: "#4d9b8e", soft_color: "#d7ebe5", background: "#eef8f4" },
];
const TOKEN_PATTERN = /[a-z0-9_]+|[\u4e00-\u9fff]/giu;

function now() {
  return new Date().toISOString();
}

function embeddingText(card) {
  return [
    `Title: ${card.title}`,
    `Question: ${card.question}`,
    `Summary: ${card.summary}`,
    `Analogy: ${card.analogy}`,
    `Detail: ${card.detail}`,
    `Topic: ${card.topic}`,
    `Tags: ${(card.tags || []).join(", ")}`,
    `Source: ${card.source || ""}`,
  ].join("\n");
}

function hashEmbedding(text) {
  const tokens = text.toLowerCase().match(TOKEN_PATTERN) || [];
  const expanded = tokens.concat(tokens.slice(0, -1).map((token, index) => `${token}_${tokens[index + 1]}`));
  const vector = Array.from({ length: EMBEDDING_DIMENSIONS }, () => 0);

  for (const token of expanded) {
    const digest = crypto.createHash("sha256").update(token, "utf8").digest();
    const bucket = digest.readUInt32BE(0) % EMBEDDING_DIMENSIONS;
    vector[bucket] += digest[4] & 1 ? 1 : -1;
  }

  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map((value) => value / norm);
}

function cosine(first, second) {
  const length = Math.min(first.length, second.length);
  let score = 0;
  for (let index = 0; index < length; index += 1) score += first[index] * second[index];
  return score;
}

function unitValue(digest, offset) {
  const start = offset % (digest.length - 8);
  return Number.parseInt(digest.slice(start, start + 8), 16) / 0xffffffff;
}

function chunkAverage(values, index, count = 8) {
  const start = Math.floor(index * values.length / count);
  const end = Math.max(start + 1, Math.floor((index + 1) * values.length / count));
  const chunk = values.slice(start, end);
  return chunk.reduce((sum, value) => sum + value, 0) / chunk.length;
}

function chunkFeatures(values, index, count = MOTIF_LAYOUT.length) {
  const start = Math.floor(index * values.length / count);
  const end = Math.max(start + 1, Math.floor((index + 1) * values.length / count));
  const chunk = values.slice(start, end);
  const average = chunk.reduce((sum, value) => sum + value, 0) / chunk.length;
  const energy = Math.sqrt(chunk.reduce((sum, value) => sum + value * value, 0) / chunk.length);
  const variation = chunk.slice(1).reduce((sum, value, offset) => sum + Math.abs(value - chunk[offset]), 0) / Math.max(1, chunk.length - 1);
  return { average, energy, variation };
}

function buildCover(embedding) {
  const norm = Math.sqrt(embedding.reduce((sum, value) => sum + value * value, 0)) || 1;
  const stableValues = embedding.map((value) => value / norm);
  const fingerprint = stableValues.map((value) => value.toFixed(8)).join(",");
  const digest = crypto.createHash("sha256").update(fingerprint, "utf8").digest("hex");
  const chunks = Array.from({ length: 8 }, (_, index) => chunkAverage(stableValues, index));
  const features = MOTIF_LAYOUT.map((_, index) => chunkFeatures(stableValues, index));
  const maxAverage = Math.max(...features.map(({ average }) => Math.abs(average))) || 1;
  const maxEnergy = Math.max(...features.map(({ energy }) => energy)) || 1;
  const maxVariation = Math.max(...features.map(({ variation }) => variation)) || 1;
  const patternNames = ["orbit", "grid", "ladder", "shelf"];
  const pattern = patternNames[Math.floor(unitValue(digest, 0) * patternNames.length) % patternNames.length];
  const palette = PALETTES[Math.floor((Math.abs(chunks[0]) + unitValue(digest, 12)) * PALETTES.length) % PALETTES.length];
  const motifs = features.map(({ average, energy, variation }, index) => {
    const averageRatio = (average / maxAverage + 1) / 2;
    const energyRatio = energy / maxEnergy;
    const variationRatio = variation / maxVariation;
    const [x, y, rotation] = MOTIF_LAYOUT[index];
    const shapeIndex = Math.floor((averageRatio * 2.1 + energyRatio * 3.4 + variationRatio * 4.7 + unitValue(digest, 44 + index * 5)) * MOTIF_SHAPES.length) % MOTIF_SHAPES.length;
    return {
      shape: MOTIF_SHAPES[shapeIndex],
      x,
      y,
      size: MOTIF_SIZE,
      rotation,
      opacity: Number((0.38 + energyRatio * 0.46).toFixed(3)),
      weight: Number(energyRatio.toFixed(3)),
    };
  });

  return {
    version: COVER_VERSION,
    seed: digest.slice(0, 16),
    pattern,
    ...palette,
    rotation: Number((-24 + unitValue(digest, 20) * 48).toFixed(2)),
    scale: Number((0.88 + unitValue(digest, 28) * 0.24).toFixed(3)),
    density: Number((0.55 + Math.abs(chunks[3]) * 0.45).toFixed(3)),
    orbit: Number((Math.abs(chunks[5]) * 0.9 + unitValue(digest, 36) * 0.1).toFixed(3)),
    motifs,
  };
}

function normalizeCard(input, previous = {}) {
  const card = {
    id: String(input.id ?? previous.id ?? "").trim(),
    number: String(input.number ?? previous.number ?? "").trim(),
    topic: String(input.topic ?? previous.topic ?? "").trim(),
    title: String(input.title ?? previous.title ?? "").trim(),
    question: String(input.question ?? previous.question ?? "").trim(),
    summary: String(input.summary ?? previous.summary ?? "").trim(),
    analogy: String(input.analogy ?? previous.analogy ?? "").trim(),
    detail: String(input.detail ?? previous.detail ?? "").trim(),
    source: String(input.source ?? previous.source ?? "").trim(),
    tags: Array.isArray(input.tags) ? input.tags.map(String).map((tag) => tag.trim()).filter(Boolean) : (previous.tags || []),
    cover: input.cover ?? previous.cover ?? null,
    created_at: previous.created_at ?? input.created_at ?? now(),
    updated_at: now(),
    deleted_at: input.deleted_at ?? previous.deleted_at ?? null,
  };
  card.embedding = hashEmbedding(embeddingText(card));
  card.cover = buildCover(card.embedding);
  return card;
}

function publicCard(card, score = 0) {
  return {
    id: card.id,
    number: card.number,
    topic: card.topic,
    title: card.title,
    question: card.question,
    summary: card.summary,
    analogy: card.analogy,
    detail: card.detail,
    source: card.source,
    tags: card.tags,
    score,
    cover: card.cover,
  };
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function writeStore(filePath, store) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(store, null, 2), "utf8");
  fs.renameSync(temporaryPath, filePath);
}

function relationKey(sourceId, targetId, type) {
  return `${sourceId}|${targetId}|${type}`;
}

function rebuildSemanticRelations(store) {
  store.relations = store.relations.filter((relation) => relation.relation_type !== "semantic");
  const activeCards = store.cards.filter((card) => !card.deleted_at);
  for (let firstIndex = 0; firstIndex < activeCards.length; firstIndex += 1) {
    for (let secondIndex = firstIndex + 1; secondIndex < activeCards.length; secondIndex += 1) {
      const first = activeCards[firstIndex];
      const second = activeCards[secondIndex];
      const score = cosine(first.embedding, second.embedding);
      if (score < 0.55) continue;
      const [sourceId, targetId] = [first.id, second.id].sort();
      store.relations.push({ source_id: sourceId, target_id: targetId, relation_type: "semantic", score, status: "suggested", updated_at: now() });
    }
  }
}

async function loadStore({ dataFile, seedPath, migrateFromUrl }) {
  if (fs.existsSync(dataFile)) {
    const existing = readJson(dataFile, null);
    if (existing?.cards) {
      existing.relations = Array.isArray(existing.relations) ? existing.relations : [];
      return existing;
    }
  }

  let sourceCards = [];
  if (migrateFromUrl) {
    try {
      const response = await fetch(`${migrateFromUrl.replace(/\/$/, "")}/cards`);
      if (response.ok) {
        const remoteCards = await response.json();
        if (Array.isArray(remoteCards) && remoteCards.length > 0) sourceCards = remoteCards;
      }
    } catch {
      // Docker is optional; fall back to the bundled starter cards.
    }
  }
  if (sourceCards.length === 0) sourceCards = readJson(seedPath, []);

  const store = {
    version: 1,
    cards: sourceCards.map((card) => normalizeCard(card)),
    relations: [],
    embedding_model_id: "embedding-hash-384",
    summary_model_id: "summary-template",
  };
  rebuildSemanticRelations(store);
  writeStore(dataFile, store);
  return store;
}

async function reindexStore(store, modelRuntime, { allowFallback = false } = {}) {
  for (const card of store.cards) {
    card.embedding = await modelRuntime.embed(embeddingText(card), { allowFallback });
    card.cover = buildCover(card.embedding);
    card.updated_at = now();
  }
  store.embedding_model_id = modelRuntime.activeEmbeddingModelId();
  store.summary_model_id = modelRuntime.activeSummaryModelId();
  rebuildSemanticRelations(store);
}

function sendJson(response, status, payload) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(payload));
}

function sendText(response, status, content, contentType = "text/plain; charset=utf-8") {
  response.writeHead(status, { "Content-Type": contentType });
  response.end(content);
}

async function readBody(request) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 2_000_000) throw new Error("Request body is too large");
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function draftFromContent(content, source) {
  const compact = String(content).replace(/\s+/g, " ").trim();
  const sentences = compact.split(/(?<=[。！？.!?])/u).map((sentence) => sentence.trim()).filter(Boolean);
  const title = (sentences[0] || compact).replace(/[。！？.!?]+$/u, "").slice(0, 48);
  const summary = (sentences.slice(0, 2).join(" ") || compact).slice(0, 220);
  return {
    topic: "待分類",
    title: title || "未命名知識卡",
    question: `我想用自己的話說明「${(title || "這個概念").slice(0, 30)}」什麼？`,
    summary,
    analogy: "可以先找一個日常經驗，對照這個概念正在解決的問題。",
    detail: compact.slice(summary.length).trim().slice(0, 800),
    source: String(source || "").trim(),
    tags: [],
  };
}

function createApiServer(store, dataFile, modelRuntime, { authToken = "" } = {}) {
  const save = () => {
    store.embedding_model_id = modelRuntime.activeEmbeddingModelId();
    store.summary_model_id = modelRuntime.activeSummaryModelId();
    writeStore(dataFile, store);
  };
  const getCard = (id, includeDeleted = false) => store.cards.find((card) => card.id === id && (includeDeleted || !card.deleted_at));
  const similarCards = (card) => store.cards
    .filter((candidate) => candidate.id !== card.id && !candidate.deleted_at)
    .map((candidate) => ({ id: candidate.id, score: cosine(card.embedding, candidate.embedding) }))
    .filter((candidate) => candidate.score >= 0.55)
    .sort((first, second) => second.score - first.score)
    .slice(0, 6);

  async function handle(request, response) {
    const requestUrl = new URL(request.url || "/", "http://127.0.0.1");
    let segments = requestUrl.pathname.split("/").filter(Boolean).map((segment) => decodeURIComponent(segment));
    const isVersioned = segments[0] === "api" && segments[1] === "v1";
    if (isVersioned) segments = segments.slice(2);

    if (request.method === "OPTIONS") {
      response.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS", "Access-Control-Allow-Headers": "Authorization, Content-Type" });
      response.end();
      return;
    }

    if (isVersioned && authToken) {
      const authorization = String(request.headers.authorization || "");
      const providedToken = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
      if (providedToken !== authToken) {
        sendJson(response, 401, { detail: "需要本機 API 權杖" });
        return;
      }
    }

    if (segments.length === 0 && isVersioned) {
      sendJson(response, 200, { name: "Knowledge Card Cabinet API", version: "v1", authentication: "bearer-local", intended_use: "local desktop runtime", docs: "/docs", openapi: "/openapi.json", capabilities: ["cards", "search", "related", "trash", "models", "settings"] });
      return;
    }

    if (request.method === "GET" && segments[0] === "health") {
      sendJson(response, 200, { status: "ok", ...modelRuntime.health() });
      return;
    }

    if (request.method === "GET" && segments[0] === "settings" && segments.length === 1) {
      sendJson(response, 200, modelRuntime.settings());
      return;
    }

    if (request.method === "PUT" && segments[0] === "settings" && segments.length === 1) {
      const body = await readBody(request);
      const previous = modelRuntime.settingsState();
      try {
        const result = modelRuntime.updateSettings(body);
        let reindexed = 0;
        if (result.embedding_changed) {
          await reindexStore(store, modelRuntime, { allowFallback: false });
          reindexed = store.cards.filter((card) => !card.deleted_at).length;
        }
        save();
        sendJson(response, 200, { status: "saved", settings: modelRuntime.settings(), reindexed_cards: reindexed });
      } catch (error) {
        modelRuntime.restoreSettingsState(previous);
        const status = error instanceof Error && /必須|位址|格式/u.test(error.message) ? 400 : 502;
        sendJson(response, status, { detail: error.message || "套用設定失敗" });
      }
      return;
    }

    if (request.method === "GET" && segments[0] === "models" && segments.length === 1) {
      sendJson(response, 200, modelRuntime.catalog());
      return;
    }

    if (request.method === "POST" && segments[0] === "models" && segments[1] && segments[1] !== "select" && segments.length === 2) {
      const model = modelRuntime.catalog().models.find((candidate) => candidate.id === segments[1]);
      if (!model) {
        sendJson(response, 404, { detail: "Model not found" });
        return;
      }
      void modelRuntime.download(segments[1]).catch(() => undefined);
      sendJson(response, 202, { status: "downloading", model: modelRuntime.catalog().models.find((candidate) => candidate.id === segments[1]) });
      return;
    }

    if (request.method === "POST" && segments[0] === "models" && segments[1] === "select" && segments.length === 2) {
      const body = await readBody(request);
      const kind = String(body.kind || "");
      const modelId = String(body.model_id || "");
      const previousEmbedding = modelRuntime.activeEmbeddingModelId();
      let selection;
      try {
        selection = await modelRuntime.select(kind, modelId);
        if (kind === "embedding" && selection.changed) {
          await reindexStore(store, modelRuntime, { allowFallback: false });
        }
        save();
        sendJson(response, 200, { status: "active", selection, models: modelRuntime.catalog() });
      } catch (error) {
        if (kind === "embedding" && selection?.changed) {
          try {
            await modelRuntime.select("embedding", previousEmbedding);
            store.embedding_model_id = previousEmbedding;
          } catch {
            // Keep the last persisted vector set if a rollback cannot be completed.
          }
        }
        const status = error?.code === "MODEL_NOT_INSTALLED" ? 409 : 500;
        sendJson(response, status, { detail: error instanceof Error ? error.message : String(error) });
      }
      return;
    }

    if (request.method === "GET" && segments[0] === "openapi.json") {
      sendJson(response, 200, {
        openapi: "3.0.0",
        info: { title: "Knowledge Card Cabinet Local API", version: "0.4.0" },
        security: [{ bearerLocal: [] }],
        components: { securitySchemes: { bearerLocal: { type: "http", scheme: "bearer", description: "由正在執行的桌面版 runtime manifest 提供，只限本機使用。" } } },
        paths: {
          "/cards": { get: {}, post: {} },
          "/cards/{id}": { get: {}, patch: {}, delete: {} },
          "/cards/{id}/related": { get: {} },
          "/cards/{id}/restore": { post: {} },
          "/cards/{id}/relations/{target_id}/confirm": { post: {} },
          "/search": { get: {} },
          "/trash": { get: {} },
          "/models": { get: {} },
          "/models/{id}": { post: {} },
          "/models/select": { post: {} },
          "/settings": { get: {}, put: {} }
        }
      });
      return;
    }

    if (request.method === "GET" && segments[0] === "docs") {
      sendText(response, 200, "<!doctype html><meta charset=\"utf-8\"><title>Knowledge Card Cabinet API</title><h1>Knowledge Card Cabinet Local API</h1><p>本機 API 已啟動。<a href=\"/openapi.json\">查看 OpenAPI JSON</a></p>", "text/html; charset=utf-8");
      return;
    }

    if (request.method === "GET" && segments[0] === "cards" && segments.length === 1) {
      sendJson(response, 200, store.cards.filter((card) => !card.deleted_at).sort((first, second) => first.number.localeCompare(second.number)).map((card) => publicCard(card)));
      return;
    }

    if (request.method === "GET" && segments[0] === "trash" && segments.length === 1) {
      sendJson(response, 200, store.cards.filter((card) => card.deleted_at).sort((first, second) => second.deleted_at.localeCompare(first.deleted_at)).map((card) => ({ ...publicCard(card), deleted_at: card.deleted_at })));
      return;
    }

    if (request.method === "GET" && segments[0] === "search") {
      const queryVector = await modelRuntime.embed(requestUrl.searchParams.get("q") || "");
      const limit = Math.min(50, Math.max(1, Number(requestUrl.searchParams.get("limit") || 10)));
      const results = store.cards.filter((card) => !card.deleted_at).map((card) => ({ card, score: cosine(queryVector, card.embedding) })).sort((first, second) => second.score - first.score).slice(0, limit);
      sendJson(response, 200, results.map(({ card, score }) => publicCard(card, score)));
      return;
    }

    if (request.method === "POST" && segments[0] === "cards" && segments[1] === "draft") {
      const body = await readBody(request);
      if (String(body.content || "").trim().length < 20) {
        sendJson(response, 422, { detail: "請先貼上至少 20 個字的筆記內容。" });
        return;
      }
      const result = await modelRuntime.draft(body.content, body.source);
      sendJson(response, 200, result);
      return;
    }

    if (request.method === "GET" && segments[0] === "cards" && segments[1] && segments[2] === "related") {
      const card = getCard(segments[1]);
      if (!card) {
        sendJson(response, 404, { detail: "Card not found" });
        return;
      }
      const related = store.relations.filter((relation) => relation.source_id === card.id || relation.target_id === card.id).map((relation) => {
        const relatedId = relation.source_id === card.id ? relation.target_id : relation.source_id;
        return { relation_type: relation.relation_type, score: relation.score, status: relation.status, card: getCard(relatedId) };
      }).filter((relation) => relation.card).sort((first, second) => second.score - first.score);
      sendJson(response, 200, related.map((relation) => ({ ...relation, card: publicCard(relation.card) })));
      return;
    }

    if (request.method === "POST" && segments[0] === "cards" && segments[1] && segments[2] === "restore") {
      const card = getCard(segments[1], true);
      if (!card || !card.deleted_at) {
        sendJson(response, 404, { detail: "Trashed card not found" });
        return;
      }
      card.deleted_at = null;
      card.updated_at = now();
      rebuildSemanticRelations(store);
      save();
      sendJson(response, 200, { status: "restored", card: publicCard(card) });
      return;
    }

    if (request.method === "POST" && segments[0] === "cards" && segments[1] && segments[2] === "relations" && segments[3] && segments[4] === "confirm") {
      const first = getCard(segments[1]);
      const second = getCard(segments[3]);
      if (!first || !second || first.id === second.id) {
        sendJson(response, 404, { detail: "Both cards must exist and be different" });
        return;
      }
      const [sourceId, targetId] = [first.id, second.id].sort();
      const existing = store.relations.find((relation) => relationKey(relation.source_id, relation.target_id, relation.relation_type) === relationKey(sourceId, targetId, "manual"));
      if (existing) existing.status = "confirmed";
      else store.relations.push({ source_id: sourceId, target_id: targetId, relation_type: "manual", score: 1, status: "confirmed", updated_at: now() });
      save();
      sendJson(response, 200, { source_id: sourceId, target_id: targetId, relation_type: "manual", score: 1, status: "confirmed" });
      return;
    }

    if (request.method === "POST" && segments[0] === "cards" && segments.length === 1) {
      const body = await readBody(request);
      if (!body.id || !body.number || !body.topic || !body.title) {
        sendJson(response, 422, { detail: "id、number、topic、title 為必要欄位" });
        return;
      }
      const existing = store.cards.find((card) => card.id === String(body.id).trim());
      const card = normalizeCard(body, existing);
      card.embedding = await modelRuntime.embed(embeddingText(card));
      card.cover = buildCover(card.embedding);
      if (existing) Object.assign(existing, card);
      else store.cards.push(card);
      rebuildSemanticRelations(store);
      save();
      sendJson(response, 200, { card: publicCard(card), embedding_model: modelRuntime.activeEmbeddingModelId(), suggested_relations: similarCards(card) });
      return;
    }

    if (request.method === "GET" && segments[0] === "cards" && segments[1] && segments.length === 2) {
      const card = getCard(segments[1]);
      if (!card) sendJson(response, 404, { detail: "Active card not found" });
      else sendJson(response, 200, publicCard(card));
      return;
    }

    if (request.method === "PATCH" && segments[0] === "cards" && segments[1] && segments.length === 2) {
      const existing = getCard(segments[1]);
      if (!existing) {
        sendJson(response, 404, { detail: "Active card not found" });
        return;
      }
      const changes = await readBody(request);
      const card = normalizeCard({ ...existing, ...changes, id: existing.id }, existing);
      card.embedding = await modelRuntime.embed(embeddingText(card));
      card.cover = buildCover(card.embedding);
      Object.assign(existing, card);
      rebuildSemanticRelations(store);
      save();
      sendJson(response, 200, { card: publicCard(card), embedding_model: modelRuntime.activeEmbeddingModelId(), suggested_relations: similarCards(card) });
      return;
    }

    if (request.method === "DELETE" && segments[0] === "cards" && segments[1] && segments.length === 2) {
      const card = getCard(segments[1]);
      if (!card) {
        sendJson(response, 404, { detail: "Active card not found" });
        return;
      }
      card.deleted_at = now();
      card.updated_at = now();
      rebuildSemanticRelations(store);
      save();
      sendJson(response, 200, { status: "trashed", card: { ...publicCard(card), deleted_at: card.deleted_at } });
      return;
    }

    if (request.method === "DELETE" && segments[0] === "trash" && segments[1] && segments.length === 2) {
      const index = store.cards.findIndex((card) => card.id === segments[1] && card.deleted_at);
      if (index < 0) {
        sendJson(response, 404, { detail: "Trashed card not found" });
        return;
      }
      store.cards.splice(index, 1);
      store.relations = store.relations.filter((relation) => relation.source_id !== segments[1] && relation.target_id !== segments[1]);
      save();
      sendJson(response, 200, { status: "deleted", id: segments[1] });
      return;
    }

    sendJson(response, 404, { detail: "Not found" });
  }

  return http.createServer((request, response) => {
    response.setHeader("Access-Control-Allow-Origin", "*");
    handle(request, response).catch((error) => sendJson(response, 500, { detail: error.message || "Local API error" }));
  });
}

async function startLocalApi({ dataFile, seedPath, migrateFromUrl, modelsDir, port = 0, authToken = "" }) {
  const modelRuntime = createModelRuntime({
    modelsDir: modelsDir || path.join(path.dirname(dataFile), "models"),
    hashEmbedding,
    templateDraft: draftFromContent,
  });
  const store = await loadStore({ dataFile, seedPath, migrateFromUrl });
  if (store.embedding_model_id !== modelRuntime.activeEmbeddingModelId()) {
    await reindexStore(store, modelRuntime, { allowFallback: false });
    writeStore(dataFile, store);
  }
  const resolvedAuthToken = authToken || crypto.randomBytes(32).toString("hex");
  const server = createApiServer(store, dataFile, modelRuntime, { authToken: resolvedAuthToken });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  return {
    server,
    port: actualPort,
    baseUrl: `http://127.0.0.1:${actualPort}`,
    authToken: resolvedAuthToken,
    modelRuntime,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

module.exports = { startLocalApi };
