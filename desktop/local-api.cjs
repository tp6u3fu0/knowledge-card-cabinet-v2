const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { URL } = require("node:url");
const { createModelRuntime } = require("./model-runtime.cjs");
const { createTaskManager } = require("./task-manager.cjs");

const EMBEDDING_DIMENSIONS = 384;
const STORE_VERSION = 2;
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
const RELATION_LIMIT = 6;
const RELATION_MIN_SCORE = 0.55;
const RELATION_KEYWORD_WEIGHT = 0.35;
const KEYWORD_WEIGHT = 0.25;

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
    `Category: ${card.category || card.topic}`,
    `Tags: ${(card.tags || []).join(", ")}`,
    `Source: ${card.source || ""}`,
  ].join("\n");
}

function embeddingSourceHash(card) {
  return crypto.createHash("sha256").update(embeddingText(card), "utf8").digest("hex");
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

function keywordScore(card, query) {
  const text = [card.title, card.category, card.topic, card.question, card.summary, card.analogy, card.detail, card.source, ...(card.tags || [])]
    .join(" ").toLocaleLowerCase();
  const normalized = String(query || "").trim().toLocaleLowerCase();
  if (!normalized) return 0;
  if (text.includes(normalized)) return 1;
  const tokens = normalized.split(/\s+/u).filter(Boolean);
  return tokens.length > 0 ? tokens.filter((token) => text.includes(token)).length / tokens.length : 0;
}

function relationKeywordScore(first, second) {
  const firstCategory = String(first.category || "").trim().toLocaleLowerCase();
  const secondCategory = String(second.category || "").trim().toLocaleLowerCase();
  if (firstCategory && firstCategory !== "待分類" && firstCategory === secondCategory) return 1;
  if (String(first.topic || "").trim().toLocaleLowerCase() === String(second.topic || "").trim().toLocaleLowerCase()) return 0.85;
  const firstTags = new Set((first.tags || []).map((tag) => String(tag).trim().toLocaleLowerCase()).filter(Boolean));
  const hasSharedTag = (second.tags || []).some((tag) => firstTags.has(String(tag).trim().toLocaleLowerCase()));
  return hasSharedTag ? 0.75 : 0;
}

function relationScore(first, second) {
  const semantic = cosine(first.embedding, second.embedding);
  const lexical = relationKeywordScore(first, second);
  return (1 - RELATION_KEYWORD_WEIGHT) * semantic + RELATION_KEYWORD_WEIGHT * lexical;
}

function normalizedTags(tags) {
  const result = [];
  const seen = new Set();
  for (const value of Array.isArray(tags) ? tags : []) {
    const tag = String(value || "").trim().replace(/\s+/gu, " ");
    const key = tag.toLocaleLowerCase();
    if (tag && !seen.has(key)) {
      seen.add(key);
      result.push(tag);
    }
  }
  return result;
}

function canonicalTagMap(cards) {
  const canonical = new Map();
  for (const card of cards) {
    for (const tag of normalizedTags(card.tags)) {
      const key = tag.toLocaleLowerCase();
      if (!canonical.has(key)) canonical.set(key, tag);
    }
  }
  return canonical;
}

function batchOrganize(store, cardIds = []) {
  const selected = new Set(cardIds);
  const cards = store.cards.filter((card) => !card.deleted_at && (selected.size === 0 || selected.has(card.id)));
  const canonicalTags = canonicalTagMap(cards);
  const suggestions = cards.map((card) => {
    const suggestedCategory = card.category && card.category !== "待分類" ? card.category : card.topic || "待分類";
    const suggestedTags = normalizedTags(card.tags).map((tag) => canonicalTags.get(tag.toLocaleLowerCase()) || tag);
    return {
      id: card.id,
      title: card.title,
      current_category: card.category || "待分類",
      suggested_category: suggestedCategory,
      current_tags: card.tags || [],
      suggested_tags: suggestedTags,
      changed: suggestedCategory !== (card.category || "待分類") || JSON.stringify(suggestedTags) !== JSON.stringify(card.tags || []),
    };
  });
  const duplicates = [];
  const relations = [];
  for (let firstIndex = 0; firstIndex < cards.length; firstIndex += 1) {
    for (let secondIndex = firstIndex + 1; secondIndex < cards.length; secondIndex += 1) {
      const first = cards[firstIndex];
      const second = cards[secondIndex];
      const score = cosine(first.embedding, second.embedding);
      const titleSame = String(first.title).replace(/\W+/gu, "").toLocaleLowerCase() === String(second.title).replace(/\W+/gu, "").toLocaleLowerCase();
      if (titleSame || score >= 0.9) duplicates.push({ source_id: first.id, target_id: second.id, score: Math.round(Math.max(score, titleSame ? 1 : score) * 10000) / 10000, reason: titleSame ? "標題相同" : "語意高度重複" });
      if (score >= RELATION_MIN_SCORE) {
        const sharedTag = normalizedTags(first.tags).some((tag) => normalizedTags(second.tags).some((item) => item.toLocaleLowerCase() === tag.toLocaleLowerCase()));
        const sameCategory = first.category && first.category !== "待分類" && first.category === second.category;
        relations.push({ source_id: first.id, target_id: second.id, score: Math.round(score * 10000) / 10000, reason: sameCategory ? "同分類 + 語意相似" : sharedTag ? "共享標籤 + 語意相似" : "語意相似" });
      }
    }
  }
  return { cards: suggestions, duplicates, relations: relations.sort((first, second) => second.score - first.score).slice(0, Math.max(RELATION_LIMIT * 2, 12)) };
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
  const topic = String(input.topic ?? previous.topic ?? "").trim();
  const category = String(input.category ?? previous.category ?? topic).trim() || topic || "待分類";
  const card = {
    id: String(input.id ?? previous.id ?? "").trim(),
    number: String(input.number ?? previous.number ?? "").trim(),
    topic,
    category,
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
  card.embedding_source_hash = embeddingSourceHash(card);
  card.cover = buildCover(card.embedding);
  return card;
}

function publicCard(card, score = 0) {
  const searchReasons = arguments[2] || [];
  return {
    id: card.id,
    number: card.number,
    topic: card.topic,
    category: card.category,
    title: card.title,
    question: card.question,
    summary: card.summary,
    analogy: card.analogy,
    detail: card.detail,
    source: card.source,
    tags: card.tags,
    score,
    search_reasons: searchReasons,
    created_at: card.created_at || null,
    updated_at: card.updated_at || null,
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

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function backupPayloadChecksum(payload) {
  const unsigned = { ...payload };
  delete unsigned.checksum_sha256;
  delete unsigned.exported_at;
  delete unsigned.conflict_strategy;
  return crypto.createHash("sha256").update(canonicalJson(unsigned), "utf8").digest("hex");
}

function exportStore(store) {
  const payload = {
    format_version: 2,
    cards: store.cards,
    relations: store.relations,
    categories: store.categories || [],
    runtime_settings: {},
    metadata: {
      card_count: store.cards.length,
      relation_count: store.relations.length,
      schema_version: STORE_VERSION,
      includes_embeddings: true,
      api_keys_included: false,
    },
  };
  return { ...payload, checksum_sha256: backupPayloadChecksum(payload), exported_at: now() };
}

function ensureCategories(store) {
  const names = new Map();
  for (const name of Array.isArray(store.categories) ? store.categories : []) {
    const normalized = String(name || "").trim();
    if (normalized) names.set(normalized.toLocaleLowerCase(), normalized);
  }
  for (const card of store.cards || []) {
    const normalized = String(card.category || card.topic || "待分類").trim() || "待分類";
    card.category = normalized;
    names.set(normalized.toLocaleLowerCase(), normalized);
  }
  if (!names.has("待分類")) names.set("待分類", "待分類");
  store.categories = [...names.values()].sort((first, second) => first.localeCompare(second, "zh-Hant"));
}

function migrateStore(store) {
  const before = JSON.stringify({ version: store.version, categories: store.categories });
  const previousVersion = Number(store.version || 1);
  ensureCategories(store);
  // Version 2 formalizes categories and keeps the local JSON store aligned
  // with the Docker schema. The migration is idempotent for old and partial
  // files, so a failed write can safely be retried at the next startup.
  store.version = Math.max(previousVersion, STORE_VERSION);
  return before !== JSON.stringify({ version: store.version, categories: store.categories });
}

function categoryList(store) {
  ensureCategories(store);
  return store.categories.map((name) => ({
    name,
    card_count: store.cards.filter((card) => !card.deleted_at && String(card.category).toLocaleLowerCase() === name.toLocaleLowerCase()).length,
    created_at: null,
    updated_at: null,
  }));
}

function validateImportedStore(payload) {
  if (!payload || ![1, 2].includes(Number(payload.format_version)) || !Array.isArray(payload.cards) || !Array.isArray(payload.relations)) {
    throw new Error("匯入檔案格式或版本不正確");
  }
  if (payload.checksum_sha256 && payload.checksum_sha256 !== backupPayloadChecksum(payload)) {
    throw new Error("備份檔案校驗碼不符，可能已損壞或被修改");
  }
  const ids = new Set();
  for (const card of payload.cards) {
    if (!card || !String(card.id || "").trim() || ids.has(String(card.id))) throw new Error("匯入卡片有缺少或重複的 id");
    if (!String(card.number || "").trim() || !String(card.topic || "").trim() || !String(card.title || "").trim()) throw new Error(`卡片 ${card.id} 缺少必要欄位`);
    ids.add(String(card.id));
  }
  const relationKeys = new Set();
  for (const relation of payload.relations) {
    const sourceId = String(relation.source_id || "");
    const targetId = String(relation.target_id || "");
    const key = `${sourceId}|${targetId}|${String(relation.relation_type || "semantic")}`;
    if (!ids.has(sourceId) || !ids.has(targetId) || sourceId === targetId || relationKeys.has(key)) throw new Error("匯入關聯引用了無效或重複的卡片");
    if (!Number.isFinite(Number(relation.score || 0)) || Number(relation.score || 0) < -1 || Number(relation.score || 0) > 1) throw new Error("匯入關聯的 score 必須介於 -1 與 1 之間");
    if (relation.relation_type && !["semantic", "manual"].includes(String(relation.relation_type))) throw new Error("匯入關聯的 relation_type 不受支援");
    relationKeys.add(key);
  }
}

function previewImportedStore(store, payload) {
  const strategy = String(payload.conflict_strategy || "replace");
  const current = new Map(store.cards.map((card) => [card.id, card]));
  const incoming = payload.cards.map((rawCard) => normalizeCard(rawCard));
  const added = incoming.filter((card) => !current.has(card.id));
  const conflicts = incoming.filter((card) => current.has(card.id));
  const changed = conflicts.map((card) => {
    const existing = current.get(card.id);
    const fields = ["number", "topic", "category", "title", "question", "summary", "analogy", "detail", "source", "tags"]
      .filter((field) => JSON.stringify(card[field]) !== JSON.stringify(existing[field]));
    return fields.length ? { id: card.id, title: card.title, fields } : null;
  }).filter(Boolean);
  const incomingIds = new Set(incoming.map((card) => card.id));
  const incomingCategories = new Set([...(payload.categories || []).map((item) => String(item.name || "").trim()).filter(Boolean), ...incoming.map((card) => card.category || card.topic || "待分類")]);
  const currentCategories = new Set(store.categories || []);
  return {
    valid: true,
    format_version: Number(payload.format_version),
    conflict_strategy: strategy,
    summary: {
      cards: incoming.length,
      relations: payload.relations.length,
      duplicate_ids: incoming.length - incomingIds.size,
      invalid_cards: 0,
      invalid_relations: 0,
      added_cards: added.length,
      updated_cards: strategy === "skip" ? 0 : conflicts.length,
      skipped_cards: strategy === "skip" ? conflicts.length : 0,
      removed_cards: strategy === "replace" ? store.cards.filter((card) => !incomingIds.has(card.id)).length : 0,
      changed_cards: strategy === "skip" ? 0 : changed.length,
      added_categories: [...incomingCategories].filter((name) => !currentCategories.has(name)).length,
      removed_categories: strategy === "replace" ? [...currentCategories].filter((name) => !incomingCategories.has(name)).length : 0,
    },
    changes: {
      added_cards: added.slice(0, 100).map((card) => ({ id: card.id, title: card.title })),
      updated_cards: strategy === "skip" ? [] : changed.slice(0, 100),
      skipped_cards: strategy === "skip" ? conflicts.slice(0, 100).map((card) => ({ id: card.id, title: card.title })) : [],
      removed_card_ids: strategy === "replace" ? store.cards.filter((card) => !incomingIds.has(card.id)).slice(0, 100).map((card) => card.id) : [],
      added_categories: [...incomingCategories].filter((name) => !currentCategories.has(name)),
      removed_categories: strategy === "replace" ? [...currentCategories].filter((name) => !incomingCategories.has(name)) : [],
    },
  };
}

function recoverStoreBackup(dataFile) {
  const backupDir = path.join(path.dirname(dataFile), "backups");
  try {
    const candidates = fs.readdirSync(backupDir).filter((name) => name.startsWith("cards-") && name.endsWith(".json"))
      .map((name) => path.join(backupDir, name)).sort((first, second) => fs.statSync(second).mtimeMs - fs.statSync(first).mtimeMs);
    for (const candidate of candidates) {
      const recovered = readJson(candidate, null);
      if (recovered?.cards && Array.isArray(recovered.cards)) return recovered;
    }
  } catch {
    // No recoverable backup is available.
  }
  return null;
}

function writeStore(filePath, store) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (fs.existsSync(filePath)) {
    const backupDir = path.join(path.dirname(filePath), "backups");
    fs.mkdirSync(backupDir, { recursive: true });
    const backupPath = path.join(backupDir, `cards-${new Date().toISOString().replace(/[.:]/gu, "-")}.json`);
    fs.copyFileSync(filePath, backupPath);
    const backups = fs.readdirSync(backupDir)
      .filter((name) => name.startsWith("cards-") && name.endsWith(".json"))
      .map((name) => path.join(backupDir, name))
      .sort((first, second) => fs.statSync(second).mtimeMs - fs.statSync(first).mtimeMs);
    for (const oldBackup of backups.slice(10)) fs.rmSync(oldBackup, { force: true });
  }
  const temporaryPath = `${filePath}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(store, null, 2), "utf8");
  fs.renameSync(temporaryPath, filePath);
}

function appendAudit(logPath, request, status, actor) {
  if (!logPath) return;
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, `${JSON.stringify({
      timestamp: now(),
      method: request.method,
      route: new URL(request.url || "/", "http://127.0.0.1").pathname,
      status,
      actor,
    })}\n`, "utf8");
  } catch {
    // Audit failures must never stop the local API.
  }
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
      const score = relationScore(first, second);
      if (score < RELATION_MIN_SCORE) continue;
      const [sourceId, targetId] = [first.id, second.id].sort();
      store.relations.push({ source_id: sourceId, target_id: targetId, relation_type: "semantic", score, status: "suggested", updated_at: now() });
    }
  }
  pruneSemanticRelations(store);
}

function pruneSemanticRelations(store) {
  const ranked = new Map();
  const cardsById = new Map(store.cards.map((card) => [card.id, card]));
  for (const relation of store.relations.filter((item) => item.relation_type === "semantic")) {
    for (const id of [relation.source_id, relation.target_id]) {
      const list = ranked.get(id) || [];
      list.push(relation);
      ranked.set(id, list);
    }
  }
  const keep = new Set();
  for (const [nodeId, list] of ranked.entries()) {
    const categoryCounts = new Map();
    const categoryLimit = Math.max(1, Math.floor(RELATION_LIMIT / 2));
    const selected = [];
    for (const relation of list.sort((first, second) => second.score - first.score)) {
      const otherId = relation.source_id === nodeId ? relation.target_id : relation.source_id;
      const other = cardsById.get(otherId);
      const category = String(other?.category || "").trim().toLocaleLowerCase();
      const limitedCategory = category && category !== "待分類";
      if (limitedCategory && (categoryCounts.get(category) || 0) >= categoryLimit) {
        continue;
      }
      selected.push(relation);
      if (limitedCategory) categoryCounts.set(category, (categoryCounts.get(category) || 0) + 1);
      if (selected.length >= RELATION_LIMIT) break;
    }
    selected.forEach((relation) => keep.add(relationKey(relation.source_id, relation.target_id, relation.relation_type)));
  }
  store.relations = store.relations.filter((relation) => relation.relation_type !== "semantic" || keep.has(relationKey(relation.source_id, relation.target_id, relation.relation_type)));
}

function rebuildSemanticRelationsFor(store, cardIds) {
  const changed = new Set(cardIds);
  store.relations = store.relations.filter((relation) => relation.relation_type !== "semantic" || (!changed.has(relation.source_id) && !changed.has(relation.target_id)));
  const activeCards = store.cards.filter((card) => !card.deleted_at);
  for (const first of activeCards.filter((card) => changed.has(card.id))) {
    for (const second of activeCards) {
      if (first.id === second.id) continue;
      const score = relationScore(first, second);
      if (score < RELATION_MIN_SCORE) continue;
      const [sourceId, targetId] = [first.id, second.id].sort();
      store.relations.push({ source_id: sourceId, target_id: targetId, relation_type: "semantic", score, status: "suggested", updated_at: now() });
    }
  }
  pruneSemanticRelations(store);
}

async function loadStore({ dataFile, seedPath, migrateFromUrl, migrateFromToken = "" }) {
  if (fs.existsSync(dataFile)) {
    const existing = readJson(dataFile, null);
    if (existing?.cards) {
      existing.cards = existing.cards.map((card) => ({
        ...card,
        category: String(card.category || card.topic || "待分類").trim(),
      }));
      existing.relations = Array.isArray(existing.relations) ? existing.relations : [];
      if (migrateStore(existing)) writeStore(dataFile, existing);
      return existing;
    }
    const recovered = recoverStoreBackup(dataFile);
    if (recovered?.cards) {
      recovered.cards = recovered.cards.map((card) => ({
        ...card,
        category: String(card.category || card.topic || "待分類").trim(),
      }));
      recovered.relations = Array.isArray(recovered.relations) ? recovered.relations : [];
      migrateStore(recovered);
      writeStore(dataFile, recovered);
      return recovered;
    }
  }

  let sourceCards = [];
  if (migrateFromUrl) {
    try {
      const response = await fetch(`${migrateFromUrl.replace(/\/$/, "")}/cards`, {
        headers: migrateFromToken ? { Authorization: `Bearer ${migrateFromToken}` } : {},
      });
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
    version: STORE_VERSION,
    cards: sourceCards.map((card) => normalizeCard(card)),
    relations: [],
    categories: [],
    embedding_model_id: "embedding-hash-384",
    summary_model_id: "summary-template",
  };
  ensureCategories(store);
  rebuildSemanticRelations(store);
  writeStore(dataFile, store);
  return store;
}

async function reindexStore(store, modelRuntime, { allowFallback = false, progress } = {}) {
  const currentModel = modelRuntime.activeEmbeddingModelId();
  const allCards = store.cards.filter((card) => !card.deleted_at);
  const cardsToUpdate = allCards.filter((card) => card.embedding_model_id !== currentModel || card.embedding_source_hash !== embeddingSourceHash(card));
  let completed = 0;
  for (const card of cardsToUpdate) {
    card.embedding = await modelRuntime.embed(embeddingText(card), { allowFallback });
    card.cover = buildCover(card.embedding);
    card.embedding_model_id = currentModel;
    card.embedding_source_hash = embeddingSourceHash(card);
    card.updated_at = now();
    completed += 1;
    progress?.(10 + Math.floor(completed / Math.max(1, cardsToUpdate.length) * 70), `已建立 ${completed}/${cardsToUpdate.length} 張卡片向量`);
  }
  store.embedding_model_id = modelRuntime.activeEmbeddingModelId();
  store.summary_model_id = modelRuntime.activeSummaryModelId();
  progress?.(85, "正在重建語意關聯");
  rebuildSemanticRelationsFor(store, cardsToUpdate.map((card) => card.id));
  progress?.(95, "正在保存索引");
  return cardsToUpdate.length;
}

function sendJson(response, status, payload) {
  if (response.headersSent || response.writableEnded) return;
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(payload));
}

function sendText(response, status, content, contentType = "text/plain; charset=utf-8") {
  if (response.headersSent || response.writableEnded) return;
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
    category: "待分類",
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

function createApiServer(store, dataFile, modelRuntime, {
  authToken = "",
  taskManager,
  auditLogPath = "",
  corsOrigins = ["http://localhost:3000", "http://127.0.0.1:3000"],
} = {}) {
  const save = () => {
    store.embedding_model_id = modelRuntime.activeEmbeddingModelId();
    store.summary_model_id = modelRuntime.activeSummaryModelId();
    writeStore(dataFile, store);
  };
  const getCard = (id, includeDeleted = false) => store.cards.find((card) => card.id === id && (includeDeleted || !card.deleted_at));
  const similarCards = (card) => store.cards
    .filter((candidate) => candidate.id !== card.id && !candidate.deleted_at)
    .map((candidate) => ({ id: candidate.id, score: relationScore(card, candidate) }))
    .filter((candidate) => candidate.score >= RELATION_MIN_SCORE)
    .sort((first, second) => second.score - first.score)
    .slice(0, RELATION_LIMIT);

  const startDownloadTask = (modelId) => {
    const model = modelRuntime.catalog().models.find((candidate) => candidate.id === modelId);
    if (!model) throw new Error("找不到指定模型");
    return taskManager.start("model_download", `下載 ${model.label}`, async (context) => {
      context.update(10, "正在下載並載入模型（會沿用既有快取）");
      const result = await modelRuntime.download(modelId);
      context.update(95, "模型已載入，正在檢查檔案");
      return { model: result, inspection: modelRuntime.inspect(modelId) };
    }, { retryPayload: { model_id: modelId } });
  };

  const startModelSelectTask = (kind, modelId, selection, previousEmbedding) => taskManager.start(
    "model_select",
    `啟用 ${modelId} 並重建 embedding`,
    async (context) => {
      try {
        await reindexStore(store, modelRuntime, { allowFallback: false, progress: (progress, message) => context.update(progress, message) });
        save();
        return { status: "active", selection, reindexed_cards: store.cards.filter((card) => !card.deleted_at).length, models: modelRuntime.catalog() };
      } catch (error) {
        try {
          await modelRuntime.select("embedding", previousEmbedding);
        } catch {
          // Preserve the last valid model selection if rollback fails.
        }
        throw error;
      }
    },
    { retryPayload: { kind, model_id: modelId, previous_model_id: previousEmbedding } },
  );

  async function handle(request, response) {
    const requestUrl = new URL(request.url || "/", "http://127.0.0.1");
    let segments = requestUrl.pathname.split("/").filter(Boolean).map((segment) => decodeURIComponent(segment));
    const isVersioned = segments[0] === "api" && segments[1] === "v1";
    if (isVersioned) segments = segments.slice(2);

    const requestOrigin = String(request.headers.origin || "");
    const allowOrigin = corsOrigins.includes("*") || corsOrigins.includes(requestOrigin) ? (requestOrigin || "*") : corsOrigins[0] || "";
    if (request.method === "OPTIONS") {
      response.writeHead(204, { "Access-Control-Allow-Origin": allowOrigin, "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS", "Access-Control-Allow-Headers": "Authorization, Content-Type" });
      response.end();
      return;
    }

    const isPublic = segments[0] === "health" || segments[0] === "docs" || segments[0] === "openapi.json";
    let actor = "anonymous";
    if (!isPublic && authToken) {
      const authorization = String(request.headers.authorization || "");
      const providedToken = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
      if (providedToken !== authToken) {
        response.setHeader("WWW-Authenticate", "Bearer");
        sendJson(response, 401, { detail: "需要本機 API 權杖" });
        return;
      }
      actor = "api-token";
    }

    if (segments.length === 0 && isVersioned) {
      sendJson(response, 200, { name: "Knowledge Card Cabinet API", version: "v1", authentication: "bearer-local", intended_use: "local desktop runtime", docs: "/docs", openapi: "/openapi.json", capabilities: ["cards", "search", "related", "trash", "models", "models.inspect", "models.remove", "tasks", "tasks.cancel", "tasks.retry", "settings", "database.export", "database.import", "database.reset"] });
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
        if (!result.embedding_changed) {
          save();
          sendJson(response, 200, { status: "saved", settings: modelRuntime.settings(), reindexed_cards: 0 });
          return;
        }
        const task = taskManager.start("settings_update", "套用模型設定並重建 embedding", async (context) => {
          try {
            await reindexStore(store, modelRuntime, { allowFallback: false, progress: (progress, message) => context.update(progress, message) });
            save();
            return { status: "saved", settings: modelRuntime.settings(), reindexed_cards: store.cards.filter((card) => !card.deleted_at).length };
          } catch (error) {
            modelRuntime.restoreSettingsState(previous);
            throw error;
          }
        });
        sendJson(response, 202, { status: "accepted", task_id: task.task_id, settings: modelRuntime.settings() });
      } catch (error) {
        modelRuntime.restoreSettingsState(previous);
        const status = error instanceof Error && /必須|位址|格式/u.test(error.message) ? 400 : 502;
        sendJson(response, status, { detail: error.message || "套用設定失敗" });
      }
      return;
    }

    if (request.method === "GET" && segments[0] === "database" && segments[1] === "export" && segments.length === 2) {
      sendJson(response, 200, exportStore(store));
      return;
    }

    if (request.method === "POST" && segments[0] === "database" && segments[1] === "import" && segments[2] === "preview" && segments.length === 3) {
      try {
        const payload = await readBody(request);
        validateImportedStore(payload);
        sendJson(response, 200, previewImportedStore(store, payload));
      } catch (error) {
        sendJson(response, 400, { valid: false, detail: error instanceof Error ? error.message : String(error) });
      }
      return;
    }

    if (request.method === "POST" && segments[0] === "database" && segments[1] === "import" && segments.length === 2) {
      try {
        const payload = await readBody(request);
        validateImportedStore(payload);
        const strategy = String(payload.conflict_strategy || "replace");
        if (!["replace", "skip", "update"].includes(strategy)) throw new Error("不支援的匯入衝突策略");
        const backup = exportStore(store);
        const importedCards = payload.cards.map((rawCard) => {
          const card = normalizeCard(rawCard);
          if (Array.isArray(rawCard.embedding) && rawCard.embedding.length === EMBEDDING_DIMENSIONS) card.embedding = rawCard.embedding.map(Number);
          card.cover = rawCard.cover || rawCard.cover_data || buildCover(card.embedding);
          card.embedding_model_id = rawCard.embedding_model_id || rawCard.embedding_model || modelRuntime.activeEmbeddingModelId();
          card.embedding_source_hash = rawCard.embedding_source_hash || embeddingSourceHash(card);
          return card;
        });
        if (strategy === "replace") store.cards = importedCards;
        else for (const card of importedCards) {
          const existingIndex = store.cards.findIndex((item) => item.id === card.id);
          if (existingIndex >= 0 && strategy === "skip") continue;
          if (existingIndex >= 0) store.cards[existingIndex] = card;
          else store.cards.push(card);
        }
        store.relations = payload.relations.map((relation) => ({
          source_id: String(relation.source_id),
          target_id: String(relation.target_id),
          relation_type: String(relation.relation_type || "semantic"),
          score: Number(relation.score || 0),
          status: String(relation.status || "suggested"),
          created_at: relation.created_at || now(),
          updated_at: relation.updated_at || now(),
        }));
        ensureCategories(store);
        save();
        sendJson(response, 200, { status: "imported", imported: { cards: store.cards.length, relations: store.relations.length, deleted_cards: store.cards.filter((card) => card.deleted_at).length }, backup });
      } catch (error) {
        sendJson(response, 400, { detail: error instanceof Error ? error.message : String(error) });
      }
      return;
    }

    if (request.method === "POST" && segments[0] === "database" && segments[1] === "reset" && segments.length === 2) {
      try {
        const body = await readBody(request);
        if (body.confirmation !== "RESET DATABASE") throw new Error("請輸入 RESET DATABASE 才能重置本機資料庫。");
        const backup = exportStore(store);
        const removed = { cards: store.cards.length, relations: store.relations.length };
        store.cards = [];
        store.relations = [];
        save();
        sendJson(response, 200, { status: "reset", removed, preserved: ["schema", "runtime_settings", "model_files"], backup });
      } catch (error) {
        sendJson(response, 400, { detail: error instanceof Error ? error.message : String(error) });
      }
      return;
    }

    if (request.method === "GET" && segments[0] === "models" && segments.length === 1) {
      sendJson(response, 200, modelRuntime.catalog());
      return;
    }

    if (request.method === "GET" && segments[0] === "tasks" && segments.length === 1) {
      const limit = Math.min(100, Math.max(1, Number(requestUrl.searchParams.get("limit") || 20)));
      sendJson(response, 200, taskManager.list(limit));
      return;
    }

    if (request.method === "GET" && segments[0] === "tasks" && segments[1] && segments.length === 2) {
      try {
        sendJson(response, 200, taskManager.get(segments[1]));
      } catch {
        sendJson(response, 404, { detail: "找不到指定背景任務" });
      }
      return;
    }

    if (request.method === "POST" && segments[0] === "tasks" && segments[1] && segments[2] === "cancel" && segments.length === 3) {
      try {
        sendJson(response, 200, await taskManager.cancel(segments[1]));
      } catch {
        sendJson(response, 404, { detail: "找不到指定背景任務" });
      }
      return;
    }

    if (request.method === "POST" && segments[0] === "tasks" && segments[1] && segments[2] === "retry" && segments.length === 3) {
      try {
        const previousTask = taskManager.rawGet(segments[1]);
        if (!["failed", "cancelled"].includes(previousTask.status)) throw new Error("只有失敗或已取消的任務可以重試");
        const payload = previousTask.retry_payload || {};
        let task;
        if (previousTask.operation === "model_download") {
          task = startDownloadTask(String(payload.model_id));
        } else if (previousTask.operation === "model_select") {
          const selection = await modelRuntime.select(String(payload.kind), String(payload.model_id));
          task = startModelSelectTask(String(payload.kind), String(payload.model_id), selection, String(payload.previous_model_id));
        } else {
          throw new Error("這個任務目前無法自動重試，請重新提交設定");
        }
        sendJson(response, 202, task);
      } catch (error) {
        const status = /找不到|無法|請先|目前|只有/u.test(error.message) ? 409 : 502;
        sendJson(response, status, { detail: error.message || "重新啟動任務失敗" });
      }
      return;
    }

    if (request.method === "POST" && segments[0] === "models" && segments[1] && segments[1] !== "select" && segments.length === 2) {
      try {
        const task = startDownloadTask(segments[1]);
        sendJson(response, 202, { status: "accepted", task_id: task.task_id, model: modelRuntime.catalog().models.find((candidate) => candidate.id === segments[1]) });
      } catch (error) {
        sendJson(response, 404, { detail: error.message || "Model not found" });
      }
      return;
    }

    if (request.method === "GET" && segments[0] === "models" && segments[1] && segments[2] === "inspect" && segments.length === 3) {
      try {
        sendJson(response, 200, modelRuntime.inspect(segments[1]));
      } catch (error) {
        sendJson(response, 404, { detail: error.message || "Model not found" });
      }
      return;
    }

    if (request.method === "DELETE" && segments[0] === "models" && segments[1] && segments.length === 2) {
      try {
        sendJson(response, 200, { status: "removed", model: modelRuntime.remove(segments[1]) });
      } catch (error) {
        sendJson(response, 409, { detail: error.message || "模型檔案清理失敗" });
      }
      return;
    }

    if (request.method === "POST" && segments[0] === "models" && segments[1] === "select" && segments.length === 2) {
      const body = await readBody(request);
      const kind = String(body.kind || "");
      const modelId = String(body.model_id || "");
      const previousEmbedding = modelRuntime.activeEmbeddingModelId();
      try {
        const selection = await modelRuntime.select(kind, modelId);
        if (kind !== "embedding" || !selection.changed) {
          save();
          sendJson(response, 200, { status: "active", selection, reindexed_cards: 0, models: modelRuntime.catalog() });
          return;
        }
        const task = startModelSelectTask(kind, modelId, selection, previousEmbedding);
        sendJson(response, 202, { status: "accepted", task_id: task.task_id, selection, models: modelRuntime.catalog() });
      } catch (error) {
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
          "/cards/{id}/relations/{target_id}": { delete: {} },
          "/cards/duplicates": { get: {} },
          "/cards/batch/organize": { post: {} },
          "/categories": { get: {}, post: {} },
          "/categories/{name}": { patch: {} },
          "/categories/merge": { post: {} },
          "/search": { get: {} },
          "/tasks": { get: {} },
          "/tasks/{task_id}": { get: {} },
          "/tasks/{task_id}/cancel": { post: {} },
          "/tasks/{task_id}/retry": { post: {} },
          "/database/export": { get: {} },
          "/database/import": { post: {} },
          "/database/import/preview": { post: {} },
          "/database/reset": { post: {} },
          "/trash": { get: {} },
          "/models": { get: {} },
          "/models/{id}/inspect": { get: {} },
          "/models/{id}": { post: {}, delete: {} },
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

    if (request.method === "GET" && segments[0] === "categories" && segments.length === 1) {
      sendJson(response, 200, categoryList(store));
      return;
    }

    if (request.method === "POST" && segments[0] === "categories" && segments.length === 1) {
      const body = await readBody(request);
      const name = String(body.name || "").trim().replace(/\s+/gu, " ");
      if (!name) {
        sendJson(response, 422, { detail: "分類名稱不可為空白" });
        return;
      }
      ensureCategories(store);
      if (store.categories.some((item) => item.toLocaleLowerCase() === name.toLocaleLowerCase())) {
        sendJson(response, 409, { detail: "已存在相同名稱的分類" });
        return;
      }
      store.categories.push(name);
      store.categories.sort((first, second) => first.localeCompare(second, "zh-Hant"));
      save();
      sendJson(response, 200, { name, card_count: 0, created_at: now(), updated_at: now() });
      return;
    }

    if (request.method === "POST" && segments[0] === "categories" && segments[1] === "merge" && segments.length === 2) {
      const body = await readBody(request);
      const source = String(body.source || "").trim();
      const target = String(body.target || "").trim();
      if (!source || !target || source.toLocaleLowerCase() === target.toLocaleLowerCase() || source.toLocaleLowerCase() === "待分類") {
        sendJson(response, 409, { detail: "合併需要兩個不同的分類，且待分類不能作為來源" });
        return;
      }
      ensureCategories(store);
      const sourceName = store.categories.find((item) => item.toLocaleLowerCase() === source.toLocaleLowerCase());
      let targetName = store.categories.find((item) => item.toLocaleLowerCase() === target.toLocaleLowerCase());
      if (!sourceName) {
        sendJson(response, 404, { detail: "找不到要合併的來源分類" });
        return;
      }
      if (!targetName) {
        targetName = target;
        store.categories.push(targetName);
      }
      let affected = 0;
      for (const card of store.cards.filter((item) => !item.deleted_at && item.category === sourceName)) {
        card.category = targetName;
        card.embedding = await modelRuntime.embed(embeddingText(card));
        card.cover = buildCover(card.embedding);
        card.embedding_model_id = modelRuntime.activeEmbeddingModelId();
        card.embedding_source_hash = embeddingSourceHash(card);
        card.updated_at = now();
        affected += 1;
      }
      store.categories = store.categories.filter((item) => item !== sourceName);
      rebuildSemanticRelations(store);
      save();
      sendJson(response, 200, { source: sourceName, name: targetName, affected_cards: affected });
      return;
    }

    if (request.method === "PATCH" && segments[0] === "categories" && segments[1] && segments.length === 2) {
      const source = decodeURIComponent(segments[1]);
      const body = await readBody(request);
      const target = String(body.name || "").trim().replace(/\s+/gu, " ");
      ensureCategories(store);
      const sourceName = store.categories.find((item) => item.toLocaleLowerCase() === source.toLocaleLowerCase());
      if (!sourceName) {
        sendJson(response, 404, { detail: "找不到指定分類" });
        return;
      }
      if (sourceName.toLocaleLowerCase() === "待分類" || !target) {
        sendJson(response, 409, { detail: "待分類不能重新命名，分類名稱也不可為空白" });
        return;
      }
      if (store.categories.some((item) => item !== sourceName && item.toLocaleLowerCase() === target.toLocaleLowerCase())) {
        sendJson(response, 409, { detail: "目標分類已存在，若要合併請使用合併功能" });
        return;
      }
      let affected = 0;
      for (const card of store.cards.filter((item) => !item.deleted_at && item.category === sourceName)) {
        card.category = target;
        card.embedding = await modelRuntime.embed(embeddingText(card));
        card.cover = buildCover(card.embedding);
        card.embedding_model_id = modelRuntime.activeEmbeddingModelId();
        card.embedding_source_hash = embeddingSourceHash(card);
        card.updated_at = now();
        affected += 1;
      }
      store.categories = store.categories.map((item) => item === sourceName ? target : item);
      rebuildSemanticRelations(store);
      save();
      sendJson(response, 200, { source: sourceName, name: target, affected_cards: affected });
      return;
    }

    if (request.method === "GET" && segments[0] === "cards" && segments[1] === "duplicates" && segments.length === 2) {
      sendJson(response, 200, { duplicates: batchOrganize(store).duplicates });
      return;
    }

    if (request.method === "POST" && segments[0] === "cards" && segments[1] === "batch" && segments[2] === "organize" && segments.length === 3) {
      const body = await readBody(request);
      const analysis = batchOrganize(store, Array.isArray(body.card_ids) ? body.card_ids.map(String) : []);
      if (!body.apply) {
        sendJson(response, 200, { status: "preview", ...analysis });
        return;
      }
      let changedCards = 0;
      for (const suggestion of analysis.cards) {
        if (!suggestion.changed) continue;
        const card = getCard(suggestion.id);
        if (!card) continue;
        card.category = suggestion.suggested_category;
        card.tags = suggestion.suggested_tags;
        card.embedding = await modelRuntime.embed(embeddingText(card));
        card.cover = buildCover(card.embedding);
        card.embedding_model_id = modelRuntime.activeEmbeddingModelId();
        card.embedding_source_hash = embeddingSourceHash(card);
        card.updated_at = now();
        changedCards += 1;
      }
      if (changedCards) rebuildSemanticRelations(store);
      save();
      sendJson(response, 200, { status: "applied", changed_cards: changedCards, ...analysis });
      return;
    }

    if (request.method === "GET" && segments[0] === "trash" && segments.length === 1) {
      sendJson(response, 200, store.cards.filter((card) => card.deleted_at).sort((first, second) => second.deleted_at.localeCompare(first.deleted_at)).map((card) => ({ ...publicCard(card), deleted_at: card.deleted_at })));
      return;
    }

    if (request.method === "GET" && segments[0] === "search") {
      const queryVector = await modelRuntime.embed(requestUrl.searchParams.get("q") || "");
      const limit = Math.min(50, Math.max(1, Number(requestUrl.searchParams.get("limit") || 10)));
      const query = requestUrl.searchParams.get("q") || "";
      const category = requestUrl.searchParams.get("category") || "";
      const tag = requestUrl.searchParams.get("tag") || "";
      const sort = requestUrl.searchParams.get("sort") || "relevance";
      const results = store.cards.filter((card) => !card.deleted_at)
        .filter((card) => !category || String(card.category).toLocaleLowerCase() === category.toLocaleLowerCase())
        .filter((card) => !tag || (card.tags || []).some((item) => String(item).toLocaleLowerCase() === tag.toLocaleLowerCase()))
        .map((card) => {
        const semantic = cosine(queryVector, card.embedding);
        const keyword = keywordScore(card, query);
        const reasons = [];
        if (keyword > 0) reasons.push("關鍵字命中");
        if (semantic >= 0.65) reasons.push("語意相似");
        if (category) reasons.push("同分類");
        if (tag) reasons.push("共享標籤");
        return { card, score: (1 - KEYWORD_WEIGHT) * semantic + KEYWORD_WEIGHT * keyword, reasons };
      }).sort((first, second) => sort === "updated" ? String(second.card.updated_at).localeCompare(String(first.card.updated_at)) : sort === "title" ? first.card.title.localeCompare(second.card.title) : second.score - first.score).slice(0, limit);
      sendJson(response, 200, results.map(({ card, score, reasons }) => publicCard(card, score, reasons)));
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
      const related = store.relations.filter((relation) => (relation.source_id === card.id || relation.target_id === card.id) && (relation.relation_type === "manual" || relation.score >= RELATION_MIN_SCORE)).map((relation) => {
        const relatedId = relation.source_id === card.id ? relation.target_id : relation.source_id;
        const relatedCard = getCard(relatedId);
        let reason = relation.relation_type === "manual" ? "自製關聯" : "語意相似";
        if (relation.relation_type !== "manual" && relatedCard) {
          if (String(relatedCard.category).toLocaleLowerCase() === String(card.category).toLocaleLowerCase() && String(card.category).toLocaleLowerCase() !== "待分類") reason = "同分類 + 語意相似";
          else if ((card.tags || []).some((tag) => (relatedCard.tags || []).some((item) => String(item).toLocaleLowerCase() === String(tag).toLocaleLowerCase()))) reason = "共享標籤 + 語意相似";
          else if (String(relatedCard.topic).toLocaleLowerCase() === String(card.topic).toLocaleLowerCase()) reason = "同主題 + 語意相似";
        }
        return { relation_type: relation.relation_type, score: relation.score, status: relation.status, reason, created_at: relation.created_at || null, updated_at: relation.updated_at || null, card: relatedCard };
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
      else store.relations.push({ source_id: sourceId, target_id: targetId, relation_type: "manual", score: 1, status: "confirmed", created_at: now(), updated_at: now() });
      save();
      sendJson(response, 200, { source_id: sourceId, target_id: targetId, relation_type: "manual", score: 1, status: "confirmed" });
      return;
    }

    if (request.method === "DELETE" && segments[0] === "cards" && segments[1] && segments[2] === "relations" && segments[3] && segments.length === 4) {
      const first = getCard(segments[1]);
      const second = getCard(segments[3]);
      if (!first || !second || first.id === second.id) {
        sendJson(response, 404, { detail: "Both cards must exist and be different" });
        return;
      }
      const [sourceId, targetId] = [first.id, second.id].sort();
      const index = store.relations.findIndex((relation) => relationKey(relation.source_id, relation.target_id, relation.relation_type) === relationKey(sourceId, targetId, "manual"));
      if (index < 0) {
        sendJson(response, 404, { detail: "找不到自製關聯" });
        return;
      }
      store.relations.splice(index, 1);
      save();
      sendJson(response, 200, { status: "deleted", source_id: sourceId, target_id: targetId, relation_type: "manual" });
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
      card.embedding_model_id = modelRuntime.activeEmbeddingModelId();
      card.embedding_source_hash = embeddingSourceHash(card);
      if (existing) Object.assign(existing, card);
      else store.cards.push(card);
      rebuildSemanticRelationsFor(store, [card.id]);
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
      card.embedding_model_id = modelRuntime.activeEmbeddingModelId();
      card.embedding_source_hash = embeddingSourceHash(card);
      Object.assign(existing, card);
      rebuildSemanticRelationsFor(store, [card.id]);
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
    const requestOrigin = String(request.headers.origin || "");
    const allowOrigin = corsOrigins.includes("*") || corsOrigins.includes(requestOrigin) ? (requestOrigin || "*") : corsOrigins[0] || "";
    response.setHeader("Access-Control-Allow-Origin", allowOrigin);
    const originalEnd = response.end.bind(response);
    response.end = (...args) => {
      appendAudit(auditLogPath, request, response.statusCode, request.headers.authorization ? "api-token" : "anonymous");
      return originalEnd(...args);
    };
    handle(request, response).catch((error) => sendJson(response, 500, { detail: error.message || "Local API error" }));
  });
}

async function startLocalApi({ dataFile, seedPath, migrateFromUrl, migrateFromToken = "", modelsDir, port = 0, authToken = "", corsOrigins } = {}) {
  const modelRuntime = createModelRuntime({
    modelsDir: modelsDir || path.join(path.dirname(dataFile), "models"),
    hashEmbedding,
    templateDraft: draftFromContent,
  });
  const store = await loadStore({ dataFile, seedPath, migrateFromUrl, migrateFromToken });
  const reindexedCards = await reindexStore(store, modelRuntime, { allowFallback: false });
  if (reindexedCards > 0 || store.embedding_model_id !== modelRuntime.activeEmbeddingModelId()) {
    writeStore(dataFile, store);
  }
  const resolvedAuthToken = authToken || crypto.randomBytes(32).toString("hex");
  const taskManager = createTaskManager({ storagePath: path.join(path.dirname(dataFile), "tasks.json") });
  const server = createApiServer(store, dataFile, modelRuntime, {
    authToken: resolvedAuthToken,
    taskManager,
    auditLogPath: path.join(path.dirname(dataFile), "audit.jsonl"),
    corsOrigins,
  });
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
    taskManager,
    close: async () => {
      await taskManager.close();
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

module.exports = { startLocalApi };
