const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const path = require("node:path");
const { URL } = require("node:url");
const { createModelRuntime } = require("./model-runtime.cjs");
const { openStore, writeBackup } = require("./store.cjs");
const { createTaskManager } = require("./task-manager.cjs");
const { createDeviceAuth } = require("./device-auth.cjs");
const { ensureLanCertificate, lanAddresses, defaultLanAddress } = require("./lan-certificate.cjs");
const { advertiseKnowledgeCardHost } = require("./bonjour.cjs");
const { createUpdateCheck } = require("./update-check.cjs");
const desktopPackage = require("./package.json");

/** Width of the built-in hash embedding, and the width covers are drawn from. */
const HASH_EMBEDDING_DIMENSIONS = 384;

/** Fixed so a paired device can be told one port once, rather than re-paired. */
const LAN_PORT = 8443;
const STORE_VERSION = 2;
const COVER_VERSION = 13;
const MOTIF_COUNT = 12;
const MOTIF_MIN_COUNT = 8;
const MOTIF_SIZE = 13.5;
// These names are drawn by app/cover-art.tsx. A name that is not in that glyph
// library silently renders as "quad", so every cover collapses into the same
// grid of four-square marks — which is exactly what shipped in COVER_VERSION 8.
const MOTIF_SHAPES = [
  "steps", "quad", "nested", "crosshair-box", "link", "target",
  "triple-dot", "constellation", "folder", "stack", "arch", "lines",
  "corners", "diagonal", "pill", "brackets", "bars", "crosshair",
];
/** Rail patterns, drawn by `.collection-card__art--<name>` in app/globals.css. */
const MOTIF_PATTERNS = ["orbit", "grid", "ladder", "shelf"];
/** Slots hug the border band; the middle of the cover stays clear for the mark. */
const MOTIF_LAYOUT = [
  [12, 13], [38, 10], [64, 10],
  [88, 13], [90, 38], [90, 62],
  [88, 87], [64, 90], [38, 90],
  [12, 87], [10, 62], [10, 38],
];
/**
 * Card colour is category colour. Mirrors the accents in app/globals.css.
 *
 * Eight rather than the original four because colour is only useful for
 * grouping if the groups mostly differ; past eight categories some will share a
 * colour, which is a collision in the palette, not in the rule.
 */
const PALETTES = [
  { accent: "coral", color: "#c96f5f", soft_color: "#f0d5cc", background: "#fbf1eb" },
  { accent: "sky", color: "#4e91a8", soft_color: "#d7e8ed", background: "#eef7f8" },
  { accent: "lavender", color: "#8068a4", soft_color: "#e4dced", background: "#f5f0f8" },
  { accent: "mint", color: "#4d9b8e", soft_color: "#d7ebe5", background: "#eef8f4" },
  { accent: "amber", color: "#b8863b", soft_color: "#f0e2c4", background: "#fbf5e8" },
  { accent: "rose", color: "#b5567d", soft_color: "#f2d3e0", background: "#fbeef4" },
  { accent: "indigo", color: "#5566a8", soft_color: "#d9dcf0", background: "#eff1fb" },
  { accent: "moss", color: "#6f8f4a", soft_color: "#e0ead0", background: "#f3f8ea" },
];
const TOKEN_PATTERN = /[a-z0-9_]+|[\u4e00-\u9fff]/giu;
const RELATION_LIMIT = 6;
// Scores are measured against the collection's own spread (see semanticBaseline),
// so this is "how far above typical a pair has to sit", not a raw cosine. Tuned
// on a real cabinet: genuine cross-topic links land at 0.44–0.49 while pairs
// that merely share a generic tag fall to 0.26.
const RELATION_MIN_SCORE = 0.42;
// Duplicate detection is deliberately harder to trigger than a relation: the
// claim is "you wrote this card twice", and being wrong about that sends the
// reader looking for a difference that is not there. Measured on a real
// cabinet, no two different cards share more than 0.092 of their wording, while
// a card retyped under a new title shares 0.69–0.84 — so half is a wide, empty
// gap to put the line in.
const DUPLICATE_MIN_OVERLAP = 0.5;
const RELATION_KEYWORD_WEIGHT = 0.35;
// Retrieval is two pieces of evidence — what someone typed, and what the model
// understood — and neither is allowed to gate the other. The lexical half
// carries less weight because it cannot find a card worded differently from the
// question; it carries weight at all because it is the half that still answers
// when the model is missing, broken, or halfway through a rebuild.
const LEXICAL_WEIGHT = 0.4;
// How much of what was typed has to appear on a card before spelling it out
// counts as a hit. Chinese is matched by character bigram (see lexicalTerms),
// and one shared bigram out of eleven is noise rather than a match — the same
// trap §3.3 describes for cosine. Half is the line, because "at least half of
// what you typed is on this card" is a claim the reader can check by eye.
const LEXICAL_MIN_COVERAGE = 0.5;
// A card whose title *is* the question is the answer, and nothing the semantic
// side has to say should push it down the page. Added on top of the blend
// rather than folded into it, so it cannot be averaged away.
const EXACT_TITLE_BONUS = 0.5;

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

function hashEmbedding(text, dimensions = HASH_EMBEDDING_DIMENSIONS) {
  const width = Number(dimensions) || HASH_EMBEDDING_DIMENSIONS;
  const tokens = text.toLowerCase().match(TOKEN_PATTERN) || [];
  const expanded = tokens.concat(tokens.slice(0, -1).map((token, index) => `${token}_${tokens[index + 1]}`));
  const vector = Array.from({ length: width }, () => 0);

  for (const token of expanded) {
    const digest = crypto.createHash("sha256").update(token, "utf8").digest();
    const bucket = digest.readUInt32BE(0) % width;
    vector[bucket] += digest[4] & 1 ? 1 : -1;
  }

  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map((value) => value / norm);
}

/**
 * Cosine similarity of two vectors of the same width.
 *
 * Truncating to the shorter of the two — which is what a Math.min guard does —
 * turns a mismatch into a plausible-looking number instead of an error, so a
 * single wrong-width vector silently poisons search and relations. Callers are
 * expected to have filtered with `hasUsableEmbedding` first; reaching here with
 * a mismatch is a bug, and it should say so.
 */
function cosine(first, second) {
  if (!Array.isArray(first) || !Array.isArray(second) || first.length !== second.length) {
    throw new Error(`embedding 維度不符：${first?.length ?? "無"} 對 ${second?.length ?? "無"}`);
  }
  let score = 0;
  for (let index = 0; index < first.length; index += 1) score += first[index] * second[index];
  return score;
}

/** A card can be compared only if it carries a vector of the width in use now. */
/**
 * The width this library's vectors actually are, read from the cards.
 *
 * Deliberately not taken from the active model's declared dimensions: the
 * question a dimension probe answers is "will this API's output be comparable
 * to what I already have", and the only authority on that is the stored data.
 * The most common width wins, so one stray card cannot misreport the library.
 */
function storeEmbeddingDimensions(store) {
  const counts = new Map();
  for (const card of store.cards) {
    if (!Array.isArray(card.embedding) || card.embedding.length === 0) continue;
    counts.set(card.embedding.length, (counts.get(card.embedding.length) || 0) + 1);
  }
  let width = 0;
  let seen = 0;
  for (const [candidate, count] of counts) {
    if (count > seen) {
      width = candidate;
      seen = count;
    }
  }
  return width;
}

function hasUsableEmbedding(card, dimensions) {
  if (!Array.isArray(card?.embedding) || card.embedding.length === 0) return false;
  return !dimensions || card.embedding.length === dimensions;
}

/**
 * The units a query is matched by.
 *
 * Splitting on whitespace turns a Chinese query into one enormous term that
 * only an exact substring can satisfy, which is why the literal test almost
 * never fired: "為什麼需要多數決" and "為什麼共識需要過半數？" are the same
 * question and share no whole word. Latin runs stay whole words — "aop" should
 * not match "aopen" — while CJK runs become character bigrams, the same unit
 * duplicate detection already counts in.
 */
function lexicalTerms(query) {
  const normalized = String(query || "").normalize("NFKC").toLocaleLowerCase();
  const terms = new Set();
  for (const run of normalized.match(/[\u3040-\u30ff\u4e00-\u9fff]+|[\p{L}\p{N}_]+/gu) || []) {
    if (!/[\u3040-\u30ff\u4e00-\u9fff]/u.test(run)) terms.add(run);
    else if (run.length === 1) terms.add(run);
    else for (const gram of bigrams(run)) terms.add(gram);
  }
  return [...terms];
}

/**
 * Where a hit is worth more.
 *
 * A query answered by the title is a different quality of answer from one
 * buried in the detail, and scoring them the same is how "here are fifty
 * results" happens. The ordering is the product decision; nothing here is
 * compared against a threshold, so these are weights and not thresholds.
 */
const LEXICAL_FIELDS = [
  { weight: 1, text: (card) => card.title },
  { weight: 0.85, text: (card) => card.question },
  { weight: 0.7, text: (card) => card.summary },
  { weight: 0.55, text: (card) => [card.category, card.topic, ...(card.tags || [])].join(" ") },
  { weight: 0.4, text: (card) => [card.analogy, card.detail, card.source].join(" ") },
];

function searchable(value) {
  return String(value ?? "").normalize("NFKC").toLocaleLowerCase();
}

/** What fraction of the query's terms this text spells out. */
function termCoverage(text, terms) {
  if (!text || terms.length === 0) return 0;
  return terms.filter((term) => text.includes(term)).length / terms.length;
}

/**
 * What a card says about a query in its own words. No vector is involved, and
 * none is required — this is the half of retrieval that has to keep working
 * when the model does not (§P-02).
 *
 * `found` is coverage across the whole card and answers "is this a hit at
 * all"; `score` is the best weighted field and answers "how good a hit". They
 * are deliberately separate: a full match down in the detail is still a match,
 * while one incidental bigram in the title is not.
 */
function lexicalMatch(card, query) {
  const terms = lexicalTerms(query);
  if (terms.length === 0) return { score: 0, found: 0, title: 0, exact: false };

  const key = titleKey(String(query));
  const exact = key.length > 0 && titleKey(card.title) === key;
  const fields = LEXICAL_FIELDS.map((field) => ({ weight: field.weight, text: searchable(field.text(card)) }));
  const found = termCoverage(fields.map((field) => field.text).join(" "), terms);
  const score = fields.reduce((best, field) => Math.max(best, field.weight * termCoverage(field.text, terms)), 0);
  return { score: exact ? 1 : score, found: exact ? 1 : found, title: termCoverage(fields[0].text, terms), exact };
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

/** True when two cards carry vectors that can meaningfully be compared. */
function comparable(first, second) {
  return hasUsableEmbedding(first) && hasUsableEmbedding(second)
    && first.embedding.length === second.embedding.length;
}

/**
 * How similar two cards have to be before similarity means anything.
 *
 * A strong multilingual model packs every pair into a narrow high band — on a
 * real cabinet BGE-M3 never scores two cards below 0.698 — so raw cosine says
 * more about "both of these are prose" than about the cards. Measured against
 * the collection's own median it separates again: the median is what unrelated
 * looks like here, and the top of the range is what related looks like.
 *
 * Sampled rather than exhaustive because a full pass is O(n²) and the shape of
 * the distribution settles long before every pair has been counted.
 */
function scoreRange(scores) {
  if (scores.length < 6) return null;
  const sorted = [...scores].sort((a, b) => a - b);
  const lo = sorted[Math.floor(sorted.length * 0.5)];
  const hi = sorted[Math.floor(sorted.length * 0.99)];
  // Values packed into a single point have no spread to normalise against.
  return hi - lo < 0.01 ? null : { lo, hi };
}

function semanticBaseline(cards) {
  const usable = cards.filter((card) => hasUsableEmbedding(card));
  if (usable.length < 4) return null;

  const scores = [];
  const step = Math.max(1, Math.floor(usable.length / 40));
  for (let i = 0; i < usable.length; i += 1) {
    for (let j = i + 1; j < usable.length; j += step) {
      if (usable[i].embedding.length === usable[j].embedding.length) {
        scores.push(cosine(usable[i].embedding, usable[j].embedding));
      }
    }
  }
  return scoreRange(scores);
}

/**
 * How far above the cabinet's ordinary similarity a card has to sit before it
 * is *about* the query, rather than merely the closest thing on the shelf.
 *
 * Ranking alone cannot answer that. Every query has a top card, and the score
 * shown is a position within the query's own range, so the best match scores
 * 1.0 whether someone typed "為什麼需要多數決" or "asdfghjkl". Searching a
 * ninety-seven card cabinet for "橘子" filled the screen with fifty results,
 * every one of them about databases and distributed systems.
 *
 * Measured, not guessed. Over thirty queries against a real cabinet — eighteen
 * it could answer, twelve it could not — the separating quantity was how far
 * the best match rises above the median of that query's own scores, counted in
 * units of `semantic_baseline` (the cabinet's own p99-minus-median spread,
 * card against card):
 *
 *     answerable      0.98 – 3.08
 *     unanswerable    0.31 – 0.85
 *
 * The line is drawn at 0.9, inside that gap and nearer the lower side: not
 * finding a card you know you wrote is a worse failure than being shown one
 * card too many, so the doubt is spent on keeping results rather than cutting
 * them. Nothing here compares a cosine to a constant (§3.3) — the unit is the
 * cabinet's own spread, so it moves when the model does.
 *
 * Null means "no opinion": too few cards to have a distribution, or a cabinet
 * whose cards are all alike. The caller then filters nothing.
 */
const SEMANTIC_STANDOUT = 0.9;
function standoutFloor(scores, baseline) {
  if (!baseline || scores.length < 6) return null;
  const spread = baseline.hi - baseline.lo;
  if (!(spread > 0)) return null;
  const sorted = [...scores].sort((first, second) => first - second);
  return sorted[Math.floor(sorted.length * 0.5)] + SEMANTIC_STANDOUT * spread;
}

/** Where this pair sits in the collection's own range of similarity. */
function relativeSemantic(value, baseline) {
  if (!baseline) return value;
  return Math.min(1, Math.max(0, (value - baseline.lo) / (baseline.hi - baseline.lo)));
}

/**
 * Blended semantic + lexical score, or null when the pair cannot be compared —
 * a card still waiting to be embedded is skipped rather than scored, and the
 * next reindex brings it back in.
 */
function relationScore(first, second, baseline = null) {
  if (!comparable(first, second)) return null;
  const semantic = relativeSemantic(cosine(first.embedding, second.embedding), baseline);
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

/**
 * The spelling each tag already has in this cabinet.
 *
 * "RAG" and "rag" are one tag to a reader and two to a filter, which is what
 * the batch organiser existed to clean up after. Cards now adopt the spelling
 * on the way in, so there is nothing to clean up later.
 */
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

/**
 * Pairs that look like the same card twice.
 *
 * The rest of what the batch organiser reported is either automatic now (tag
 * spelling, the category falling back to the topic) or was already on screen
 * elsewhere: its "relation suggestions" were a copy of the relations the
 * cabinet rebuilds by itself after every change. Duplicates are the one thing
 * that needs a person to look, so they are all that is left — and they are
 * surfaced without being asked for.
 */
/**
 * A title with its spacing and punctuation taken out.
 *
 * `\W` looked like the way to do this and is not: with `\w` meaning
 * [A-Za-z0-9_], every Chinese character counts as punctuation, so an all-Chinese
 * title normalised to the empty string and every pair of them matched. A
 * cabinet written in Chinese reported itself as entirely duplicate.
 */
function titleKey(title) {
  return String(title).normalize("NFKC").replace(/[\s\p{P}\p{S}]+/gu, "").toLocaleLowerCase();
}

/** Everything a reader would compare, with spacing and punctuation taken out. */
function duplicateText(card) {
  return [card.title, card.question, card.summary, card.analogy, card.detail]
    .join("")
    .normalize("NFKC")
    .replace(/[\s\p{P}\p{S}]+/gu, "")
    .toLocaleLowerCase();
}

/** Character bigrams: the unit that works for a language without spaces. */
function bigrams(text) {
  const grams = new Set();
  for (let index = 0; index + 1 < text.length; index += 1) grams.add(text.slice(index, index + 2));
  return grams;
}

/** How much of the two cards' actual wording is the same, 0 to 1. */
function wordingOverlap(first, second) {
  if (first.size === 0 || second.size === 0) return 0;
  let shared = 0;
  for (const gram of first) if (second.has(gram)) shared += 1;
  return shared / (first.size + second.size - shared);
}

function findDuplicates(store) {
  const cards = store.cards.filter((card) => !card.deleted_at);
  const grams = new Map(cards.map((card) => [card.id, bigrams(duplicateText(card))]));
  const duplicates = [];

  for (let firstIndex = 0; firstIndex < cards.length; firstIndex += 1) {
    for (let secondIndex = firstIndex + 1; secondIndex < cards.length; secondIndex += 1) {
      const first = cards[firstIndex];
      const second = cards[secondIndex];
      // Two cards with the same title are the same card twice however they are
      // written — that is what a title is for.
      if (titleKey(first.title) === titleKey(second.title)) {
        duplicates.push({
          source_id: first.id, source_title: first.title,
          target_id: second.id, target_title: second.title,
          score: 1, reason: "標題相同",
        });
        continue;
      }

      // Otherwise the evidence is the wording, and only the wording.
      //
      // Similarity was tried as a second condition and had to go: a cabinet
      // measures similarity against its own spread (§3.3), and on a small one
      // that spread is noise — measured on four cards, a card retyped under a
      // new title scored 0.29 while two unrelated cards scored 1.00. The model
      // also reads "檢索增強生成" and "RAG" as fairly different titles, so it
      // votes against the very case this is looking for. Two cards that are
      // about the same thing in different words are a relation, and the
      // relation view already draws those.
      const overlap = wordingOverlap(grams.get(first.id), grams.get(second.id));
      if (overlap < DUPLICATE_MIN_OVERLAP) continue;

      duplicates.push({
        source_id: first.id, source_title: first.title,
        target_id: second.id, target_title: second.title,
        score: Math.round(overlap * 10000) / 10000,
        reason: "內容幾乎相同",
      });
    }
  }
  return duplicates.sort((first, second) => second.score - first.score);
}

/**
 * As many independent values in [0, 1) as a cover needs, from one string.
 *
 * Each SHA-256 block yields eight non-overlapping 32-bit words, and blocks are
 * numbered so the stream can be as long as the drawing needs. The previous
 * reader took overlapping eight-character windows out of a single digest, which
 * correlates choices that are supposed to be independent — invisible while the
 * embedding supplied most of a cover's variation, and not invisible now that it
 * supplies none.
 */
function coverValues(identity, count) {
  const values = [];
  for (let block = 0; values.length < count; block += 1) {
    const digest = crypto.createHash("sha256").update(`${identity}/${block}`, "utf8").digest("hex");
    for (let offset = 0; offset < digest.length; offset += 8) {
      values.push(Number.parseInt(digest.slice(offset, offset + 8), 16) / 0x100000000);
    }
  }
  return values;
}

function categoryName(category) {
  return String(category || "").trim() || "待分類";
}

/**
 * Fallback colour for a category nothing has assigned one to yet.
 *
 * Hashing alone was the first attempt and it grouped badly: over a real
 * fourteen-category cabinet it put five categories on one accent and left
 * others alone, which defeats the point of colouring by category at all. So the
 * hash is only the starting point — assignCategoryAccents spreads them evenly
 * and then records the result so it never moves again.
 */
function hashedPalette(category) {
  const name = categoryName(category);
  let hash = 2166136261;
  for (const character of name) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  hash ^= hash >>> 15;
  hash = Math.imul(hash, 2246822519);
  hash ^= hash >>> 13;
  return PALETTES[(hash >>> 0) % PALETTES.length];
}

/**
 * The palette a category owns, from the store's recorded assignment.
 *
 * Recorded rather than recomputed because a card's colour is part of how it is
 * recognised: deriving it from the current category list would repaint cards
 * that had nothing to do with the category someone just added or deleted.
 */
function categoryPalette(category, accents = null) {
  const name = categoryName(category);
  const assigned = accents?.[name];
  return PALETTES.find((palette) => palette.accent === assigned) || hashedPalette(name);
}

/**
 * Give every category a colour, spreading them across the palette.
 *
 * Existing assignments are never revisited. New categories take the least-used
 * accent, so the first eight categories in a cabinet are all different colours
 * and later ones double up as evenly as the palette allows.
 */
function assignCategoryAccents(store) {
  const accents = store.category_accents && typeof store.category_accents === "object" ? store.category_accents : {};
  const names = new Set([
    ...(store.categories || []).map(categoryName),
    ...(store.cards || []).map((card) => categoryName(card.category)),
  ]);

  // Drop assignments for categories that no longer exist, so a cabinet that has
  // churned through many categories does not look permanently full.
  for (const name of Object.keys(accents)) {
    if (!names.has(name)) delete accents[name];
  }

  const counts = new Map(PALETTES.map((palette) => [palette.accent, 0]));
  for (const accent of Object.values(accents)) {
    if (counts.has(accent)) counts.set(accent, counts.get(accent) + 1);
  }

  let changed = false;
  // Sorted so the assignment order does not depend on Set iteration order.
  for (const name of [...names].sort()) {
    if (counts.has(accents[name])) continue;
    const [accent] = [...counts.entries()].sort((left, right) => left[1] - right[1] || PALETTES.findIndex((palette) => palette.accent === left[0]) - PALETTES.findIndex((palette) => palette.accent === right[0]))[0];
    accents[name] = accent;
    counts.set(accent, counts.get(accent) + 1);
    changed = true;
  }

  store.category_accents = accents;
  return changed;
}

/**
 * A card's cover, drawn from the one thing about the card that never changes.
 *
 * It used to be drawn from the card's embedding, so that the art would "keep
 * tracking meaning". Measured against this cabinet's own model, it never did:
 * every choice on a cover passes through a SHA-256 of the vector, so two cards
 * that say the same thing in different words (cosine 0.99) agree on about as
 * many glyphs as two cards with nothing in common — 7%, against 6% for picking
 * at random. The art was always a hash. It was simply hashing something that
 * moves.
 *
 * And it moved in the way that costs most. The source hash spans title,
 * question, summary, analogy, detail, topic, category, tags and source, so
 * deleting one full stop redrew a card into a picture its owner had never seen
 * — no glyph in common with the one they had learned to recognise. Finding a
 * card by eye is what a cover is for, so it now hangs on the card's id: stable
 * across an edit, across a model change, across a rewrite.
 *
 * Colour is the exception and comes from the category, so that cards in one
 * category read as one group. Two cards in a category are then the same colour
 * without being the same picture.
 */
function buildCover(identity, category, accents = null) {
  const key = String(identity ?? "");
  // Four values for the cover itself, one per slot to decide which slots are
  // kept, then five per slot for the glyph drawn there.
  const values = coverValues(key, 4 + MOTIF_COUNT * 6);
  const palette = categoryPalette(category, accents);
  // 8-12 glyphs per cover: sparser cards read as calmer, denser ones as busier.
  const motifCount = MOTIF_MIN_COUNT + Math.floor(values[1] * (MOTIF_COUNT - MOTIF_MIN_COUNT + 1));
  const keptSlots = Array.from({ length: MOTIF_COUNT }, (_, index) => index)
    .sort((left, right) => values[4 + left] - values[4 + right])
    .slice(0, motifCount)
    .sort((left, right) => left - right);

  const motifs = keptSlots.map((index) => {
    const [x, y] = MOTIF_LAYOUT[index];
    const at = 4 + MOTIF_COUNT + index * 5;
    return {
      shape: MOTIF_SHAPES[Math.floor(values[at] * MOTIF_SHAPES.length)],
      x: Number((x + (values[at + 1] - 0.5) * 4).toFixed(2)),
      y: Number((y + (values[at + 2] - 0.5) * 4).toFixed(2)),
      size: MOTIF_SIZE,
      opacity: Number((0.42 + values[at + 3] * 0.38).toFixed(3)),
      weight: Number(values[at + 4].toFixed(3)),
    };
  });

  return {
    version: COVER_VERSION,
    seed: crypto.createHash("sha256").update(key, "utf8").digest("hex").slice(0, 16),
    pattern: MOTIF_PATTERNS[Math.floor(values[0] * MOTIF_PATTERNS.length)],
    ...palette,
    // These two place the gradient focus in app/card-face.tsx. Drawn from the
    // vector they were dead: a chunk mean of a *normalised* vector sits at
    // zero by construction, so density held four distinct values across two
    // hundred cards and moved the focus by a fifth of a percent. The ranges
    // here are the ones the consuming formulas were written for.
    density: Number((0.55 + values[2] * 0.45).toFixed(3)),
    orbit: Number(values[3].toFixed(3)),
    motifs,
  };
}

/**
 * Crockford base32, for card ids that survive being read aloud or copied out
 * of a log: no I, L, O or U, so nothing can be confused with 1, 0 or a swear.
 */
const CARD_ID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * The id for a card the runtime is creating on someone's behalf.
 *
 * A card id is an implementation detail (CLAUDE.md §2). Nobody who wants to
 * keep an understanding has a reason to first decide between `attention-v2`
 * and `attention-mechanism`, and being asked to is exactly the friction that
 * turns "keep this" into "I will organise it later" — which is how a cabinet
 * dies. Callers that own their own identifiers (imports, backups, MCP clients
 * carrying data in from elsewhere) still pass one and are still obeyed.
 *
 * ULID-shaped rather than a UUID so ids sort by creation time and a raw dump
 * of the table reads in order. It seeds the cover (§3.6), so it has to be
 * unique and stable — and, just as importantly, never derived from what the
 * card says, or editing a typo would redraw the card.
 */
function generateCardId(at = Date.now()) {
  let time = "";
  let value = at;
  for (let index = 0; index < 10; index += 1) {
    time = CARD_ID_ALPHABET[value % 32] + time;
    value = Math.floor(value / 32);
  }
  // 256 is a whole number of alphabets, so the modulo here is not biased.
  const random = Array.from(crypto.randomBytes(16), (byte) => CARD_ID_ALPHABET[byte % 32]).join("");
  return `${time}${random}`;
}

const CARD_NUMBER_PATTERN = /^KC-(\d+)$/i;

/**
 * The next unused `KC-000123`.
 *
 * One scheme for the whole cabinet rather than a per-category prefix. The
 * category is already on the card twice — in words and in colour — so a prefix
 * would be the same fact spelled a third way, and it could not be derived
 * honestly anyway: most categories here are Chinese, and there is no
 * defensible way to turn 人工智慧 into three Latin letters.
 *
 * Trashed cards are counted too, so restoring one never collides with a number
 * handed out since. Numbers that do not follow the scheme are left out of the
 * count and left alone on their cards: a number is assigned once and never
 * recomputed, for the same reason a colour is (§3.5).
 */
function nextCardNumber(cards) {
  const highest = cards.reduce((best, card) => {
    const match = CARD_NUMBER_PATTERN.exec(String(card.number ?? "").trim());
    return match ? Math.max(best, Number(match[1])) : best;
  }, 0);
  return `KC-${String(highest + 1).padStart(6, "0")}`;
}

function normalizeCard(input, previous = {}, canonicalTags = null) {
  const requestedTopic = String(input.topic ?? previous.topic ?? "").trim();
  const category = String(input.category ?? previous.category ?? requestedTopic).trim() || requestedTopic || "待分類";
  // Topic used to be the field category fell back to. It now falls back the
  // other way as well, because quick capture asks where a card lives exactly
  // once. Without this a card captured in twenty seconds reads as "KC-000004 ·"
  // everywhere the topic is shown, with nothing after the dot.
  const topic = requestedTopic || category;
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
    // Deduplicated case-insensitively, and spelled the way this cabinet
    // already spells them when the caller knows what that is.
    tags: normalizedTags(Array.isArray(input.tags) ? input.tags : (previous.tags || []))
      .map((tag) => canonicalTags?.get(tag.toLocaleLowerCase()) || tag),
    cover: input.cover ?? previous.cover ?? null,
    created_at: previous.created_at ?? input.created_at ?? now(),
    updated_at: now(),
    deleted_at: input.deleted_at ?? previous.deleted_at ?? null,
  };
  // The real vector is the caller's job — normalising a card must not invent
  // one, or a hash embedding ends up standing in for a model embedding.
  card.embedding = Array.isArray(input.embedding) ? input.embedding.map(Number)
    : Array.isArray(previous.embedding) ? previous.embedding : null;
  card.embedding_source_hash = embeddingSourceHash(card);
  // Provisional: the colour here is the hashed fallback, because a lone card
  // has no view of the cabinet's colour assignments. refreshStaleCovers runs
  // after every mutation and settles it.
  card.cover = card.cover ?? buildCover(card.id, card.category);
  return card;
}

/** A cover is current when it was drawn by this version *and* in this card's category colour. */
function coverIsCurrent(card, accents) {
  if ((card.cover?.version ?? 0) !== COVER_VERSION) return false;
  return card.cover?.accent === categoryPalette(card.category, accents).accent;
}

/**
 * The shape a card leaves the runtime in.
 *
 * `ranking` is filled in only by search. Both halves of the hybrid score ride
 * along even though the interface shows neither number: without them a search
 * that ranks badly can only be argued about, never measured, and the weights
 * are meant to be tuned against real cabinets rather than guessed at (CLAUDE.md §1).
 */
function publicCard(card, ranking = null) {
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
    score: ranking?.score ?? 0,
    lexical_score: ranking?.lexical_score ?? 0,
    // Null, not zero: "this card carries no comparable vector" and "the model
    // saw it and was unimpressed" are different answers, and only one of them
    // means the search ran with both halves.
    semantic_score: ranking?.semantic_score ?? null,
    search_reasons: ranking?.reasons ?? [],
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

/**
 * Fingerprint of a backup's contents, ignoring the fields that describe the
 * backup rather than the data.
 *
 * This detects a damaged or edited file; it is NOT comparable across runtimes.
 * The retired Python service serialised small floats in exponent form
 * (`4.92e-05`) where JavaScript writes them out in full, so the same data
 * hashes differently there. A payload from another implementation should
 * therefore arrive without a checksum rather than with a foreign one — import
 * skips the check when the field is absent.
 */
function backupPayloadChecksum(payload) {
  const unsigned = { ...payload };
  delete unsigned.checksum_sha256;
  delete unsigned.exported_at;
  delete unsigned.conflict_strategy;
  delete unsigned.backup_reason;
  delete unsigned.backed_up_at;
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
  // Version 2 formalises categories as their own list rather than deriving them
  // from cards. The migration is idempotent for old and partial stores, so a
  // failed write can safely be retried at the next startup.
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

function appendAudit(logPath, request, status, actor, durationMs = 0) {
  if (!logPath) return;
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, `${JSON.stringify({
      timestamp: now(),
      method: request.method,
      route: new URL(request.url || "/", "http://127.0.0.1").pathname,
      status,
      actor,
      duration_ms: durationMs,
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
  const baseline = semanticBaseline(activeCards);
  store.semantic_baseline = baseline;
  for (let firstIndex = 0; firstIndex < activeCards.length; firstIndex += 1) {
    for (let secondIndex = firstIndex + 1; secondIndex < activeCards.length; secondIndex += 1) {
      const first = activeCards[firstIndex];
      const second = activeCards[secondIndex];
      const score = relationScore(first, second, baseline);
      if (score === null || score < RELATION_MIN_SCORE) continue;
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
  // Reuse the collection's measured range so a single edited card is scored on
  // the same scale as everything already in the graph.
  const baseline = store.semantic_baseline ?? semanticBaseline(store.cards.filter((card) => !card.deleted_at));
  store.relations = store.relations.filter((relation) => relation.relation_type !== "semantic" || (!changed.has(relation.source_id) && !changed.has(relation.target_id)));
  const activeCards = store.cards.filter((card) => !card.deleted_at);
  // When both ends of a pair are in the changed set — which is every pair once
  // a reindex touches the whole cabinet — the inner loop reaches it from both
  // directions. The store's primary key hides that on write, so the duplicate
  // only ever showed up in what the API served until the next restart.
  const emitted = new Set(store.relations.map((relation) => relationKey(relation.source_id, relation.target_id, relation.relation_type)));
  for (const first of activeCards.filter((card) => changed.has(card.id))) {
    for (const second of activeCards) {
      if (first.id === second.id) continue;
      const [sourceId, targetId] = [first.id, second.id].sort();
      if (emitted.has(relationKey(sourceId, targetId, "semantic"))) continue;
      const score = relationScore(first, second, baseline);
      if (score === null || score < RELATION_MIN_SCORE) continue;
      emitted.add(relationKey(sourceId, targetId, "semantic"));
      store.relations.push({ source_id: sourceId, target_id: targetId, relation_type: "semantic", score, status: "suggested", updated_at: now() });
    }
  }
  pruneSemanticRelations(store);
}

/** Cards arriving from an older store may predate the category field. */
function normalizeLoadedStore(store) {
  store.cards = (store.cards || []).map((card) => ({
    ...card,
    category: String(card.category || card.topic || "待分類").trim(),
  }));
  store.relations = Array.isArray(store.relations) ? store.relations : [];
  return store;
}

async function loadStore({ dataFile, seedPath, migrateFromUrl, migrateFromToken = "", loadSeed = false, db }) {
  if (!db.isEmpty()) {
    const existing = normalizeLoadedStore(db.load());
    if (migrateStore(existing)) db.replaceAll(existing);
    return existing;
  }

  // First run against SQLite: adopt whatever the JSON store held. The JSON file
  // is deliberately left in place — if this migration is wrong, the old data is
  // still sitting there untouched.
  if (fs.existsSync(dataFile)) {
    const legacy = readJson(dataFile, null) ?? recoverStoreBackup(dataFile);
    if (legacy?.cards?.length) {
      const adopted = normalizeLoadedStore(legacy);
      migrateStore(adopted);
      ensureCategories(adopted);
      db.replaceAll(adopted);
      return adopted;
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
      // The old service is optional; an empty cabinet is a fine starting point.
    }
  }
  // A fresh install starts empty. The sample cards ship with the app but are
  // only loaded when something explicitly asks for them — a cabinet that
  // arrives full of someone else's cards is not an empty cabinet.
  if (sourceCards.length === 0 && loadSeed) sourceCards = readJson(seedPath, []);

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
  db.replaceAll(store);
  return store;
}

/**
 * Give a card its vector, and record honestly when that could not be done.
 *
 * A failed embedding leaves the card without one rather than with a hash
 * stand-in: search and relations then skip it, instead of scoring it against
 * real vectors as though the result meant something. Clearing the model id is
 * what lets reindexStore find the card and try again later.
 */
async function applyEmbedding(card, modelRuntime) {
  try {
    card.embedding = await modelRuntime.embed(embeddingText(card), { allowFallback: false });
    card.embedding_model_id = modelRuntime.activeEmbeddingModelId();
  } catch {
    card.embedding = null;
    card.embedding_model_id = null;
  }
  card.embedding_source_hash = embeddingSourceHash(card);
  return card;
}

/**
 * A cover is derived data, so changing how covers are drawn has to reach the
 * cards already on disk. Nothing else notices a stale cover — the embedding and
 * its hash are unchanged — so reindexStore walks straight past them and a
 * cabinet keeps rendering whatever scheme it was written under.
 */
function refreshStaleCovers(store) {
  // The single place category colour is settled: assign first, then repaint
  // whatever no longer matches. Every mutation that can introduce or move a
  // category ends here, so a card never keeps a colour it is not entitled to.
  assignCategoryAccents(store);
  const stale = store.cards.filter((card) => !coverIsCurrent(card, store.category_accents));
  for (const card of stale) card.cover = buildCover(card.id, card.category, store.category_accents);
  return stale.map((card) => card.id);
}

/** A cancelled task should stop working, not finish and then be ignored. */
function abortIfCancelled(cancelled) {
  if (!cancelled?.()) return;
  throw Object.assign(new Error("已取消"), { name: "AbortError" });
}

/**
 * Rebuild every vector with an incoming model, putting none of them into
 * service.
 *
 * The new vectors land in `embedding_pending`, a field the store's schema does
 * not know about and therefore never writes to disk. Meanwhile the vectors
 * already on the cards keep answering searches, from the model that is still
 * active. The cabinet stays whole for the entire rebuild.
 *
 * What this replaces: switching the active model first and converting
 * afterwards. `/search` embeds the query with the active model and then drops
 * every card whose vector is a different width, so each unconverted card was
 * invisible. Measured on a 91-card cabinet moving from BGE-M3 to
 * EmbeddingGemma, the first search after the switch returned **one** card, and
 * it took fifteen seconds to come back — on a cabinet of two thousand it would
 * be most of ten minutes of a cabinet that looks like it has been emptied.
 *
 * A crash in the middle is also better this way: nothing was applied, so the
 * cabinet is still consistently on the old model. Switching first left half the
 * cards on each side of a boundary nothing would have repaired on its own.
 */
async function stageEmbeddings(store, embedder, { progress, cancelled } = {}) {
  const cards = store.cards.filter((card) => !card.deleted_at);
  let completed = 0;
  for (const card of cards) {
    abortIfCancelled(cancelled);
    card.embedding_pending = await embedder.embed(embeddingText(card));
    // Recorded with the vector: a card edited during the rebuild must not end
    // up claiming that this vector describes the new wording.
    card.embedding_pending_hash = embeddingSourceHash(card);
    completed += 1;
    progress?.(5 + Math.floor(completed / Math.max(1, cards.length) * 75), `已重算 ${completed}/${cards.length} 張卡片向量`);
  }
  return cards.length;
}

/** Put every staged vector into service at once, so no search sees a half-built index. */
function commitStagedEmbeddings(store, modelId) {
  const committed = [];
  for (const card of store.cards) {
    if (!Array.isArray(card.embedding_pending)) continue;
    card.embedding = card.embedding_pending;
    card.embedding_model_id = modelId;
    card.embedding_source_hash = card.embedding_pending_hash;
    delete card.embedding_pending;
    delete card.embedding_pending_hash;
    committed.push(card.id);
  }
  store.embedding_model_id = modelId;
  return committed;
}

function discardStagedEmbeddings(store) {
  for (const card of store.cards) {
    delete card.embedding_pending;
    delete card.embedding_pending_hash;
  }
}

async function reindexStore(store, modelRuntime, { allowFallback = false, progress } = {}) {
  const currentModel = modelRuntime.activeEmbeddingModelId();
  const allCards = store.cards.filter((card) => !card.deleted_at);
  const cardsToUpdate = allCards.filter((card) => card.embedding_model_id !== currentModel || card.embedding_source_hash !== embeddingSourceHash(card));
  let completed = 0;
  for (const card of cardsToUpdate) {
    if (allowFallback) {
      card.embedding = await modelRuntime.embed(embeddingText(card), { allowFallback });
      card.embedding_model_id = currentModel;
      card.embedding_source_hash = embeddingSourceHash(card);
    } else {
      // One card the model chokes on must not abort the whole rebuild; it keeps
      // a null model id and gets picked up by the next pass.
      await applyEmbedding(card, modelRuntime);
    }
    // `updated_at` is deliberately not touched. It says when a person last
    // changed the card; a reindex is the machine's work, not theirs. Stamping
    // it here made a model switch mark the entire cabinet as just-edited, which
    // silently reordered every "recently updated" view on both the desktop and
    // the phone — the cabinet's history rewritten by a maintenance job.
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

/**
 * What a paired phone is allowed to ask for.
 *
 * Cards and the things that organise them are the phone's whole job, so those
 * are open to it. Host administration is not: a phone that is lost or unlocked
 * must not be able to repoint the model, open the cabinet to the network, hand
 * out or revoke other devices, or export the database.
 *
 * The three read-only exceptions exist because without them the phone's
 * settings page could only ever be a page about the phone. Being able to see
 * which model the host is running, how far a long job has got, and which build
 * the host is, changes nothing on the host and answers the questions people
 * actually open that page to ask. GET only, and named one by one rather than
 * by prefix — `/app/version` is readable, a future `/app/anything` is not
 * until someone decides it is.
 */
const DEVICE_ROUTES = ["cards", "categories", "search", "trash"];

function deviceMayReach(method, segments) {
  if (DEVICE_ROUTES.includes(segments[0])) return true;
  if (method !== "GET") return false;
  if (segments[0] === "settings" && segments.length === 1) return true;
  if (segments[0] === "tasks" && segments.length <= 2) return true;
  if (segments[0] === "app" && segments[1] === "version" && segments.length === 2) return true;
  return false;
}

function createApiServer(store, dataFile, modelRuntime, {
  authToken = "",
  taskManager,
  auditLogPath = "",
  corsOrigins = ["http://localhost:3000", "http://127.0.0.1:3000"],
  deviceAuth,
  networkController,
  updateCheck,
  serverFactory = (handler) => http.createServer(handler),
  db,
} = {}) {
  /**
   * Persist the store. `changedCards` names the ids that were touched so only
   * those rows are rewritten; calling it bare rewrites every card, which is
   * correct but is exactly the cost this store was built to avoid.
   */
  const save = (changedCards) => {
    store.embedding_model_id = modelRuntime.activeEmbeddingModelId();
    store.summary_model_id = modelRuntime.activeSummaryModelId();
    // Category colour is settled here rather than at each call site: every
    // mutation funnels through save(), so a new or moved category can never be
    // written out still wearing the wrong colour. Cards repainted as a result
    // are added to the write set, or the repaint would be lost.
    const repainted = refreshStaleCovers(store);
    const cards = changedCards ? [...new Set([...changedCards, ...repainted])] : null;
    db.save(store, { cards });
  };
  const getCard = (id, includeDeleted = false) => store.cards.find((card) => card.id === id && (includeDeleted || !card.deleted_at));
  const similarCards = (card) => store.cards
    .filter((candidate) => candidate.id !== card.id && !candidate.deleted_at)
    .map((candidate) => ({ id: candidate.id, score: relationScore(card, candidate, store.semantic_baseline) }))
    .filter((candidate) => candidate.score !== null && candidate.score >= RELATION_MIN_SCORE)
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

  /**
   * Rebuild with the incoming model, then switch — never the other way round.
   *
   * Because nothing is applied until every card is converted, there is no
   * rollback to get wrong: a failure part-way through leaves the cabinet
   * exactly as it was, still searchable, still on the model it was on.
   */
  const applyEmbeddingPlan = async (context, plan, label) => {
    try {
      const embedder = modelRuntime.embedderFor(plan.embedding_plan);
      context.update(5, `正在以${label}重算向量，搜尋期間照常可用`);
      await stageEmbeddings(store, embedder, {
        progress: (progress, message) => context.update(progress, message),
        cancelled: context.cancelled,
      });
      abortIfCancelled(context.cancelled);
    } catch (error) {
      discardStagedEmbeddings(store);
      throw error;
    }
    const applied = plan.apply();
    context.update(84, "正在切換到新的向量");
    commitStagedEmbeddings(store, modelRuntime.activeEmbeddingModelId());
    store.summary_model_id = modelRuntime.activeSummaryModelId();
    context.update(88, "正在重建語意關聯");
    rebuildSemanticRelations(store);
    // A card written while the rebuild was running carries a vector from the
    // model that has just been retired, and a card edited during it carries one
    // that describes the old wording. Usually there are none of either.
    context.update(95, "正在處理重建期間的異動");
    await reindexStore(store, modelRuntime, { allowFallback: false });
    save();
    return applied;
  };

  const startModelSelectTask = (kind, modelId, plan) => taskManager.start(
    "model_select",
    `啟用 ${modelId} 並重建 embedding`,
    async (context) => {
      const selection = await applyEmbeddingPlan(context, plan, "新模型");
      return { status: "active", selection, reindexed_cards: store.cards.filter((card) => !card.deleted_at).length, models: modelRuntime.catalog() };
    },
    // No previous model to record: a failed switch never took effect, so
    // retrying is just asking for the same switch again.
    { retryPayload: { kind, model_id: modelId } },
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

    const isPairingExchange = request.method === "POST" && segments[0] === "devices" && segments[1] === "pair" && segments.length === 2;
    const isPublic = segments[0] === "health" || segments[0] === "docs" || segments[0] === "openapi.json" || isPairingExchange || (isVersioned && segments.length === 0);
    // Recorded on the request so the audit hook on response.end can read the
    // actor we actually authenticated, not just guess from the header.
    let actor = "anonymous";
    let authScope = "public";
    if (!isPublic && authToken) {
      const authorization = String(request.headers.authorization || "");
      const providedToken = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
      if (providedToken === authToken) {
        // Keep the established audit label stable; external tools use it when
        // distinguishing desktop activity from a paired device below.
        actor = "api-token";
        authScope = "local";
      } else {
        const device = deviceAuth?.authenticate(providedToken);
        if (device) {
          actor = `device:${device.id}`;
          authScope = "device";
        }
      }
      if (authScope === "public") {
        response.setHeader("WWW-Authenticate", "Bearer");
        sendJson(response, 401, { detail: "需要有效的 API 或裝置權杖" });
        return;
      }
    }
    request.kccActor = actor;

    if (authScope === "device" && !deviceMayReach(request.method, segments)) {
      sendJson(response, 403, { detail: "裝置權杖沒有這項主機管理權限。" });
      return;
    }

    if (segments.length === 0 && isVersioned) {
      sendJson(response, 200, { name: "Knowledge Card Cabinet API", version: "v1", authentication: "bearer-local-and-device", intended_use: "local desktop runtime; remote transport disabled", docs: "/docs", openapi: "/openapi.json", capabilities: ["cards", "cards.auto_identity", "search", "search.hybrid", "related", "trash", "models", "models.inspect", "models.remove", "models.custom", "models.api.probe", "models.api.probe_embedding", "tasks", "tasks.cancel", "tasks.retry", "settings", "database.export", "database.import", "database.reset", "devices.pairing", "devices.revoke", "devices.host_status", "app.version"] });
      return;
    }

    if (request.method === "POST" && segments[0] === "devices" && segments[1] === "pairing-code" && segments.length === 2) {
      if (!deviceAuth) {
        sendJson(response, 503, { detail: "裝置配對服務尚未啟動。" });
        return;
      }
      sendJson(response, 200, deviceAuth.issuePairingCode());
      return;
    }

    if (isPairingExchange) {
      if (!deviceAuth) {
        sendJson(response, 503, { detail: "裝置配對服務尚未啟動。" });
        return;
      }
      const result = deviceAuth.pair(await readBody(request));
      if (!result.ok) {
        sendJson(response, 422, { detail: result.detail });
        return;
      }
      sendJson(response, 200, { token: result.token, device: result.device });
      return;
    }

    if (request.method === "GET" && segments[0] === "devices" && segments.length === 1) {
      sendJson(response, 200, deviceAuth?.list() || []);
      return;
    }

    if (request.method === "DELETE" && segments[0] === "devices" && segments.length === 2) {
      // ?purge=1 removes the record; without it the device is only revoked.
      // Two steps, because only the first one is what actually locks a phone
      // out, and it should stay visible that it happened.
      if (requestUrl.searchParams.get("purge") === "1") {
        const result = deviceAuth?.forget(segments[1]) || { ok: false, code: "not_found" };
        if (result.code === "not_found") {
          sendJson(response, 404, { detail: "找不到裝置。" });
          return;
        }
        if (result.code === "still_active") {
          sendJson(response, 409, { detail: "請先撤銷這台裝置，再刪除紀錄。" });
          return;
        }
        sendJson(response, 200, { status: "removed", device: result.device });
        return;
      }
      const device = deviceAuth?.revoke(segments[1]);
      if (!device) {
        sendJson(response, 404, { detail: "找不到裝置。" });
        return;
      }
      sendJson(response, 200, { status: "revoked", device });
      return;
    }

    if (request.method === "GET" && segments[0] === "network" && segments[1] === "lan" && segments.length === 2) {
      sendJson(response, 200, networkController?.status() || { enabled: false, transport: "unavailable" });
      return;
    }

    if (request.method === "POST" && segments[0] === "network" && segments[1] === "lan" && segments.length === 2) {
      try {
        sendJson(response, 200, await networkController.enable());
      } catch (error) {
        sendJson(response, 500, { detail: error instanceof Error ? error.message : String(error) });
      }
      return;
    }

    if (request.method === "DELETE" && segments[0] === "network" && segments[1] === "lan" && segments.length === 2) {
      await networkController.disable();
      sendJson(response, 200, networkController.status());
      return;
    }

    if (request.method === "GET" && segments[0] === "health") {
      // The data directory is reported so the app can show people where their
      // cards actually live rather than leaving them to guess. The version
      // goes with it so a bug report can name a build without the reporter
      // having to remember which installer they ran.
      sendJson(response, 200, {
        status: "ok",
        version: updateCheck ? updateCheck.status().version : "",
        data_dir: path.dirname(dataFile),
        ...modelRuntime.health(),
      });
      return;
    }

    // Behind the token on purpose: this is the one route that can cause an
    // outbound request, and a paired phone has no business updating the host.
    if (request.method === "GET" && segments[0] === "app" && segments[1] === "version" && segments.length === 2) {
      if (!updateCheck) {
        sendJson(response, 503, { detail: "版本資訊尚未就緒。" });
        return;
      }
      // A device reads the last answer; it does not get to make the host go
      // and ask for a new one. Updating is the desktop's business either way.
      sendJson(response, 200, authScope === "device" ? updateCheck.status() : await updateCheck.check());
      return;
    }

    if (request.method === "GET" && segments[0] === "settings" && segments.length === 1) {
      sendJson(response, 200, modelRuntime.settings());
      return;
    }

    if (request.method === "PUT" && segments[0] === "settings" && segments.length === 1) {
      const body = await readBody(request);
      try {
        const plan = modelRuntime.planSettings(body);
        if (!plan.embedding_changed) {
          plan.apply();
          save();
          sendJson(response, 200, { status: "saved", settings: modelRuntime.settings(), reindexed_cards: 0 });
          return;
        }
        // Pointing at a different embedding API is a rebuild like any other, so
        // it waits the same way. Nothing is applied until it succeeds, which is
        // why there is no settings state to restore here any more.
        const task = taskManager.start("settings_update", "套用模型設定並重建 embedding", async (context) => {
          await applyEmbeddingPlan(context, plan, "新設定");
          return { status: "saved", settings: modelRuntime.settings(), reindexed_cards: store.cards.filter((card) => !card.deleted_at).length };
        });
        sendJson(response, 202, { status: "accepted", task_id: task.task_id });
      } catch (error) {
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
        // Written to disk, not just handed back: the old JSON store rotated a
        // copy on every save, so replacing it must keep an explicit escape hatch.
        const backup = exportStore(store);
        const backupFile = writeBackup(dataFile, backup, "before-import");
        const importedCards = payload.cards.map((rawCard) => {
          const card = normalizeCard(rawCard);
          // A backup taken with a different embedding model carries vectors of
          // another width. Keeping them would mean this store held two
          // incompatible kinds of vector at once, so they are dropped and the
          // card is left for the reindex — which is why the model id is only
          // carried over when the vector was.
          const width = modelRuntime.expectedEmbeddingDimensions();
          const usable = Array.isArray(rawCard.embedding) && rawCard.embedding.length > 0
            && (!width || rawCard.embedding.length === width);
          card.embedding = usable ? rawCard.embedding.map(Number) : null;
          card.cover = rawCard.cover || rawCard.cover_data || buildCover(card.id, card.category);
          card.embedding_model_id = usable
            ? (rawCard.embedding_model_id || rawCard.embedding_model || modelRuntime.activeEmbeddingModelId())
            : null;
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
        // Vectors from another runtime or another model are not carried over,
        // so the imported cards arrive without one. Rebuilding here rather than
        // waiting for the next restart is what keeps search working: a card
        // with no vector is deliberately invisible to it.
        const rebuilt = await reindexStore(store, modelRuntime, { allowFallback: false });
        // An import replaces the working set wholesale, so rows that vanished
        // have to be cleared rather than merely not rewritten.
        db.replaceAll(store);
        sendJson(response, 200, { status: "imported", imported: { cards: store.cards.length, relations: store.relations.length, deleted_cards: store.cards.filter((card) => card.deleted_at).length, reindexed_cards: rebuilt }, backup, backup_file: backupFile });
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
        const backupFile = writeBackup(dataFile, backup, "before-reset");
        const removed = { cards: store.cards.length, relations: store.relations.length };
        store.cards = [];
        store.relations = [];
        db.replaceAll(store);
        sendJson(response, 200, { status: "reset", removed, preserved: ["schema", "runtime_settings", "model_files"], backup, backup_file: backupFile });
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
          task = startModelSelectTask(String(payload.kind), String(payload.model_id), modelRuntime.planSelect(String(payload.kind), String(payload.model_id)));
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

    // Adding a model reaches out to Hugging Face, so it can fail slowly and for
    // reasons worth reading; the messages come back verbatim rather than as a
    // generic 400.
    if (request.method === "POST" && segments[0] === "models" && segments[1] === "custom" && segments.length === 2) {
      const body = await readBody(request);
      try {
        const model = await modelRuntime.addCustomModel({
          kind: String(body.kind || ""),
          model_id: String(body.model_id || ""),
          label: String(body.label || ""),
          dimensions: Number(body.dimensions || 0),
        });
        sendJson(response, 201, { status: "added", model, models: modelRuntime.catalog() });
      } catch (error) {
        sendJson(response, 400, { detail: error instanceof Error ? error.message : String(error) });
      }
      return;
    }

    if (request.method === "DELETE" && segments[0] === "models" && segments[1] === "custom" && segments[2] && segments.length === 3) {
      try {
        sendJson(response, 200, { status: "removed", ...modelRuntime.removeCustomModel(segments[2]), models: modelRuntime.catalog() });
      } catch (error) {
        sendJson(response, 409, { detail: error instanceof Error ? error.message : String(error) });
      }
      return;
    }

    // Lists what an OpenAI-compatible service (Ollama, LM Studio, anything
    // else) actually has loaded, so the model name can be chosen rather than
    // typed from memory.
    if (request.method === "POST" && segments[0] === "models" && segments[1] === "api" && segments[2] === "probe" && segments.length === 3) {
      const body = await readBody(request);
      try {
        sendJson(response, 200, await modelRuntime.probeApi({ api_url: String(body.api_url || ""), api_key: String(body.api_key || "") }));
      } catch (error) {
        sendJson(response, 400, { detail: error instanceof Error ? error.message : String(error) });
      }
      return;
    }

    // Embeds one short string and counts the result, so the width of a custom
    // API is a fact the user can check before saving rather than something the
    // first stored card discovers. See storeEmbeddingDimensions below for why
    // the comparison is against the cards rather than against the setting.
    if (request.method === "POST" && segments[0] === "models" && segments[1] === "api" && segments[2] === "probe-embedding" && segments.length === 3) {
      const body = await readBody(request);
      try {
        const result = await modelRuntime.probeApiEmbedding({
          api_url: String(body.api_url || ""),
          api_key: String(body.api_key || ""),
          model: String(body.model || ""),
          api_format: String(body.api_format || "openai"),
        });
        const stored = storeEmbeddingDimensions(store);
        sendJson(response, 200, {
          ...result,
          store_dimensions: stored,
          // No stored vectors yet means nothing can clash: whatever the API
          // returns simply becomes this library's width.
          matches_store: !result.ok || !stored ? null : result.dimensions === stored,
          card_count: store.cards.length,
        });
      } catch (error) {
        sendJson(response, 400, { detail: error instanceof Error ? error.message : String(error) });
      }
      return;
    }

    if (request.method === "POST" && segments[0] === "models" && segments[1] && !["select", "custom", "api"].includes(segments[1]) && segments.length === 2) {
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
      try {
        // Planned, not applied: a switch that needs a rebuild must not take
        // effect until the rebuild finishes, or every card not yet converted
        // disappears from search while it runs.
        const plan = modelRuntime.planSelect(kind, modelId);
        if (kind !== "embedding" || !plan.changed) {
          const selection = plan.apply();
          save();
          sendJson(response, 200, { status: "active", selection, reindexed_cards: 0, models: modelRuntime.catalog() });
          return;
        }
        const task = startModelSelectTask(kind, modelId, plan);
        sendJson(response, 202, { status: "accepted", task_id: task.task_id, models: modelRuntime.catalog() });
      } catch (error) {
        const status = error?.code === "MODEL_NOT_INSTALLED" ? 409 : 500;
        sendJson(response, status, { detail: error instanceof Error ? error.message : String(error) });
      }
      return;
    }

    if (request.method === "GET" && segments[0] === "openapi.json") {
      sendJson(response, 200, {
        openapi: "3.0.0",
        // The app's version, not a number of its own: the compatibility
        // contract is the "v1" in the route prefix, so a second independent
        // version here only ever drifted away from both.
        info: { title: "Knowledge Card Cabinet Local API", version: require("./package.json").version },
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
          "/models/custom": { post: {} },
          "/models/custom/{id}": { delete: {} },
          "/models/api/probe": { post: {} },
          "/models/api/probe-embedding": { post: {} },
          "/app/version": { get: {} },
          "/settings": { get: {}, put: {} },
          "/devices": { get: {} },
          "/devices/pairing-code": { post: {} },
          "/devices/pair": { post: {} },
          "/devices/{id}": { delete: {} }
          ,"/network/lan": { get: {}, post: {}, delete: {} }
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
        await applyEmbedding(card, modelRuntime);
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
        await applyEmbedding(card, modelRuntime);
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
      sendJson(response, 200, { duplicates: findDuplicates(store) });
      return;
    }

    if (request.method === "GET" && segments[0] === "trash" && segments.length === 1) {
      sendJson(response, 200, store.cards.filter((card) => card.deleted_at).sort((first, second) => second.deleted_at.localeCompare(first.deleted_at)).map((card) => ({ ...publicCard(card), deleted_at: card.deleted_at })));
      return;
    }

    if (request.method === "GET" && segments[0] === "search") {
      const query = requestUrl.searchParams.get("q") || "";
      const limit = Math.min(50, Math.max(1, Number(requestUrl.searchParams.get("limit") || 10)));
      const category = requestUrl.searchParams.get("category") || "";
      const tag = requestUrl.searchParams.get("tag") || "";
      const sort = requestUrl.searchParams.get("sort") || "relevance";

      const candidates = store.cards.filter((card) => !card.deleted_at)
        .filter((card) => !category || String(card.category).toLocaleLowerCase() === category.toLocaleLowerCase())
        .filter((card) => !tag || (card.tags || []).some((item) => String(item).toLocaleLowerCase() === tag.toLocaleLowerCase()));

      const ordered = (entries, scoreOf) => [...entries].sort((first, second) => sort === "updated"
        ? String(second.card.updated_at).localeCompare(String(first.card.updated_at))
        : sort === "title"
          ? first.card.title.localeCompare(second.card.title)
          : scoreOf(second) - scoreOf(first)).slice(0, limit);

      // Nothing was asked, so there is nothing to rank: the filters are the
      // whole answer, and the cabinet in its own order is what a reader expects
      // to get back.
      if (!query.trim()) {
        sendJson(response, 200, ordered(candidates.map((card) => ({ card })), () => 0)
          .map(({ card }) => publicCard(card)));
        return;
      }

      /*
       * Two pipelines over one candidate set.
       *
       * The lexical one sees every card. The semantic one sees only cards
       * carrying a vector of the query's own width. Neither may remove a card
       * from the other's reach — that is the whole of "AI enhances retrieval,
       * AI does not gate retrieval", and it is why the embed call sits inside a
       * try. A model that is missing, broken, still downloading, or halfway
       * through a rebuild costs the search its ability to match different
       * wording. It must not cost the search its ability to find "Spring AOP"
       * when somebody types "Spring AOP".
       *
       * This used to filter on hasUsableEmbedding *before* scoring anything, so
       * a single failed embedding took a card out of every search including the
       * ones that spelled its title out in full.
       */
      let queryVector = null;
      try {
        queryVector = await modelRuntime.embed(query, { kind: "query" });
      } catch {
        queryVector = null;
      }

      const measured = candidates.map((card) => ({
        card,
        lexical: lexicalMatch(card, query),
        semantic: queryVector && hasUsableEmbedding(card, queryVector.length)
          ? cosine(queryVector, card.embedding)
          : null,
      }));
      const semanticScores = measured.filter((entry) => entry.semantic !== null).map((entry) => entry.semantic);

      // How far above this query's own median a card has to sit before it is
      // *about* the query rather than merely the nearest thing on the shelf.
      // Without it every query returned the whole cabinet in ranked order.
      const floor = standoutFloor(semanticScores, store.semantic_baseline);
      // A query's similarities sit in their own band — lower than card-to-card,
      // and narrower still for a strong model — so "語意相似" has to mean "high
      // for this query", not a fixed cosine. Against BGE-M3 a fixed 0.65 either
      // labelled every result or none of them.
      const queryRange = scoreRange(semanticScores);

      // Kept when either pipeline vouches for it. A card that spells the query
      // out is never dropped for being semantically ordinary, and a card that
      // means the query in different words is never dropped for not containing
      // it — those two failures are the reason this endpoint was rewritten.
      const results = measured.filter((entry) => entry.lexical.found >= LEXICAL_MIN_COVERAGE
        || (entry.semantic !== null && (floor === null || entry.semantic >= floor)));

      const scored = ordered(results.map((entry) => {
        const relative = entry.semantic === null ? null : relativeSemantic(entry.semantic, queryRange);
        const reasons = [];
        if (entry.lexical.found >= LEXICAL_MIN_COVERAGE) {
          reasons.push(entry.lexical.exact || entry.lexical.title >= 1 ? "標題命中" : "關鍵字命中");
        }
        // Too few results to have a distribution means there is no honest way
        // to say a card stands out, so the label is simply withheld.
        if (queryRange && relative !== null && relative >= 0.5) reasons.push("語意相似");
        if (category) reasons.push("同分類");
        if (tag) reasons.push("共享標籤");

        // With no vector there is nothing to blend, so what the card says
        // stands for both halves instead of being halved. Halving it would rank
        // a card the model failed on below cards it merely half-matches, which
        // is the same bug in a different costume.
        const blended = relative === null
          ? entry.lexical.score
          : (1 - LEXICAL_WEIGHT) * relative + LEXICAL_WEIGHT * entry.lexical.score;
        return {
          card: entry.card,
          ranking: {
            score: blended + (entry.lexical.exact ? EXACT_TITLE_BONUS : 0),
            lexical_score: Math.round(entry.lexical.score * 10000) / 10000,
            semantic_score: relative === null ? null : Math.round(relative * 10000) / 10000,
            reasons,
          },
        };
      }), (entry) => entry.ranking.score);

      sendJson(response, 200, scored.map(({ card, ranking }) => publicCard(card, ranking)));
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
      }).filter((relation) => relation.card)
        // A pair can hold both a hand-made relation and a suggested one. They
        // are one neighbour, and the hand-made one is the answer — it was
        // chosen, not inferred — so it wins ties rather than appearing twice.
        .sort((first, second) => (second.score - first.score)
          || (first.relation_type === "manual" ? -1 : second.relation_type === "manual" ? 1 : 0))
        .filter((relation, index, all) => all.findIndex((other) => other.card.id === relation.card.id) === index)
        .slice(0, RELATION_LIMIT);
      // Capped like the server runtime: pruning bounds semantic edges per card,
      // but a relation kept for its *other* endpoint still shows up here, and
      // manual relations are not pruned at all. Without this slice one card can
      // return far more edges than the canvas is laid out for.
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
      save([card.id]);
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
      save([]);
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
      save([]);
      sendJson(response, 200, { status: "deleted", source_id: sourceId, target_id: targetId, relation_type: "manual" });
      return;
    }

    if (request.method === "POST" && segments[0] === "cards" && segments.length === 1) {
      const body = await readBody(request);
      // The title is the only thing asked for. An untitled card cannot be
      // recognised in any list, so it is the one field the cabinet genuinely
      // needs; the id and the number are bookkeeping, and bookkeeping must not
      // stand between someone and a card they are willing to spend twenty
      // seconds on (CLAUDE.md §1 P-04). Anything the caller does supply wins.
      if (!String(body.title ?? "").trim()) {
        sendJson(response, 422, { detail: "title 為必要欄位" });
        return;
      }
      const requestedId = String(body.id ?? "").trim();
      const existing = requestedId ? store.cards.find((card) => card.id === requestedId) : undefined;
      const identity = existing ? {} : {
        id: requestedId || generateCardId(),
        number: String(body.number ?? "").trim() || nextCardNumber(store.cards),
      };
      const card = normalizeCard({ ...body, ...identity }, existing, canonicalTagMap(store.cards.filter((item) => !item.deleted_at)));
      await applyEmbedding(card, modelRuntime);
      // Reply with the object the store holds, not the local copy: save() can
      // still change it — repainting a card that introduced a new category —
      // and the caller must be told the colour it actually got.
      let stored = card;
      if (existing) {
        Object.assign(existing, card);
        stored = existing;
      } else {
        store.cards.push(card);
      }
      rebuildSemanticRelationsFor(store, [stored.id]);
      save([stored.id]);
      sendJson(response, 200, { card: publicCard(stored), embedding_model: modelRuntime.activeEmbeddingModelId(), suggested_relations: similarCards(stored) });
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
      const card = normalizeCard({ ...existing, ...changes, id: existing.id }, existing, canonicalTagMap(store.cards.filter((item) => !item.deleted_at && item.id !== existing.id)));
      await applyEmbedding(card, modelRuntime);
      Object.assign(existing, card);
      rebuildSemanticRelationsFor(store, [existing.id]);
      save([existing.id]);
      // `existing`, not `card`: moving a card to another category repaints it
      // inside save(), and that repaint lands on the stored object.
      sendJson(response, 200, { card: publicCard(existing), embedding_model: modelRuntime.activeEmbeddingModelId(), suggested_relations: similarCards(existing) });
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
      save([card.id]);
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
      save([]);
      sendJson(response, 200, { status: "deleted", id: segments[1] });
      return;
    }

    sendJson(response, 404, { detail: "Not found" });
  }

  return serverFactory((request, response) => {
    const requestOrigin = String(request.headers.origin || "");
    const allowOrigin = corsOrigins.includes("*") || corsOrigins.includes(requestOrigin) ? (requestOrigin || "*") : corsOrigins[0] || "";
    response.setHeader("Access-Control-Allow-Origin", allowOrigin);
    const startedAt = Date.now();
    const originalEnd = response.end.bind(response);
    response.end = (...args) => {
      // A rejected request carries an Authorization header too, so trusting the
      // header alone would log a failed attempt as an authenticated one.
      appendAudit(auditLogPath, request, response.statusCode, request.kccActor ?? "anonymous", Date.now() - startedAt);
      return originalEnd(...args);
    };
    handle(request, response).catch((error) => sendJson(response, 500, { detail: error.message || "Local API error" }));
  });
}

async function startLocalApi({ dataFile, seedPath, migrateFromUrl, migrateFromToken = "", loadSeed = false, modelsDir, port = 0, authToken = "", corsOrigins,
  // Both default to what the desktop package declares, so nothing has a
  // second copy of the version to keep in step (scripts/release-check.mjs
  // fails the build on any version literal that could drift).
  appVersion = desktopPackage.version, repository = desktopPackage.repository } = {}) {
  // The store is opened first so the model runtime can start out knowing the
  // width the existing cards already use. Without that, a custom embedding API
  // returning a different width after a restart would be adopted as the new
  // truth instead of being rejected.
  const db = openStore(dataFile);
  const modelRuntime = createModelRuntime({
    modelsDir: modelsDir || path.join(path.dirname(dataFile), "models"),
    hashEmbedding,
    templateDraft: draftFromContent,
    apiDimensions: db.storedDimensions(),
  });
  const store = await loadStore({ dataFile, seedPath, migrateFromUrl, migrateFromToken, loadSeed, db });
  // Relations saved before scores became relative were measured on a different
  // scale, so they cannot be compared with new ones. The missing baseline is
  // what identifies them, and one rebuild puts the whole graph back on one scale.
  const rescored = !store.semantic_baseline && store.cards.some((card) => hasUsableEmbedding(card));
  if (rescored) rebuildSemanticRelations(store);
  const refreshedCovers = refreshStaleCovers(store).length;
  const reindexedCards = await reindexStore(store, modelRuntime, { allowFallback: false });
  if (rescored || refreshedCovers > 0 || reindexedCards > 0 || store.embedding_model_id !== modelRuntime.activeEmbeddingModelId()) {
    store.embedding_model_id = modelRuntime.activeEmbeddingModelId();
    store.summary_model_id = modelRuntime.activeSummaryModelId();
    db.save(store);
  }
  const resolvedAuthToken = authToken || crypto.randomBytes(32).toString("hex");
  const taskManager = createTaskManager({ storagePath: path.join(path.dirname(dataFile), "tasks.json") });
  const deviceAuth = createDeviceAuth({ storagePath: path.join(path.dirname(dataFile), "devices.json") });
  let lanRuntime = null;
  let bonjourAdvertisement = null;
  let lanCertificate = null;
  // Resolved from the routing table when sharing is switched on, then reused so
  // status() stays synchronous and always names the same host the QR code did.
  let lanPreferredAddress = "";
  const networkController = {
    status: () => ({
      enabled: Boolean(lanRuntime),
      transport: "lan-https",
      port: lanRuntime?.port || null,
      api_urls: lanRuntime
        ? lanAddresses({ preferredAddress: lanPreferredAddress }).map((address) => `https://${address}:${lanRuntime.port}/api/v1`)
        : [],
      certificate_fingerprint_sha256: lanCertificate?.fingerprint_sha256 || "",
      pairing_requires_fingerprint: true,
      // Discovery is a convenience, not a requirement: the QR code carries the
      // address outright. Reported so the interface can say which one applies
      // instead of promising Bonjour on a machine that has none.
      discovery_active: Boolean(bonjourAdvertisement?.active),
      discovery_detail: bonjourAdvertisement?.detail || "",
    }),
    enable: async () => {
      if (lanRuntime) return networkController.status();
      lanPreferredAddress = await defaultLanAddress();
      const addresses = lanAddresses({ preferredAddress: lanPreferredAddress });
      if (addresses.length === 0) throw new Error("找不到可分享的區域網路位址，請先連上 Wi‑Fi 或有線網路。");
      lanCertificate = ensureLanCertificate({ directory: path.join(path.dirname(dataFile), "lan-tls"), addresses });
      await startLanApi({ keyPath: lanCertificate.key_path, certPath: lanCertificate.cert_path, port: LAN_PORT })
        .catch((error) => {
          if (error?.code === "EADDRINUSE") throw new Error(`連接埠 ${LAN_PORT} 已被其他程式使用，請關閉該程式後再試。`);
          if (error?.code === "EACCES") throw new Error(`沒有權限開啟連接埠 ${LAN_PORT}，請確認防火牆或系統原則設定。`);
          throw error;
        });
      bonjourAdvertisement = advertiseKnowledgeCardHost({ port: lanRuntime.port, fingerprint: lanCertificate.fingerprint_sha256 });
      await bonjourAdvertisement.ready;
      return networkController.status();
    },
    disable: async () => stopLanApi(),
  };
  const updateCheck = createUpdateCheck({
    currentVersion: appVersion,
    repository,
    statePath: path.join(path.dirname(dataFile), "update-check.json"),
    enabled: String(process.env.KCC_UPDATE_CHECK || "").toLowerCase() !== "off",
  });
  const server = createApiServer(store, dataFile, modelRuntime, {
    authToken: resolvedAuthToken,
    taskManager,
    auditLogPath: path.join(path.dirname(dataFile), "audit.jsonl"),
    corsOrigins,
    deviceAuth,
    networkController,
    updateCheck,
    db,
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  const startLanApi = async ({ keyPath, certPath, port: lanPort = 8443, hostname = "" } = {}) => {
    if (!keyPath || !certPath) throw new Error("LAN 分享需要 TLS 憑證與私鑰。");
    if (lanRuntime) await lanRuntime.close();
    const lanServer = createApiServer(store, dataFile, modelRuntime, {
      authToken: resolvedAuthToken,
      taskManager,
      auditLogPath: path.join(path.dirname(dataFile), "audit.jsonl"),
      corsOrigins,
      deviceAuth,
      networkController,
      updateCheck,
      serverFactory: (handler) => https.createServer({ key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath), minVersion: "TLSv1.2" }, handler),
      db,
    });
    await new Promise((resolve, reject) => {
      lanServer.once("error", reject);
      lanServer.listen(lanPort, "0.0.0.0", resolve);
    });
    const lanAddress = lanServer.address();
    const actualLanPort = typeof lanAddress === "object" && lanAddress ? lanAddress.port : lanPort;
    lanRuntime = {
      server: lanServer,
      port: actualLanPort,
      baseUrl: hostname ? `https://${hostname}${actualLanPort === 443 ? "" : `:${actualLanPort}`}` : "",
      close: async () => new Promise((resolve) => {
        // A phone holding a keep-alive connection would otherwise keep close()
        // pending indefinitely, leaving "停止分享" spinning with the port open.
        lanServer.closeAllConnections();
        lanServer.close(() => resolve());
      }),
    };
    return lanRuntime;
  };

  const stopLanApi = async () => {
    bonjourAdvertisement?.stop();
    bonjourAdvertisement = null;
    if (!lanRuntime) return;
    const current = lanRuntime;
    lanRuntime = null;
    await current.close();
  };
  return {
    server,
    port: actualPort,
    baseUrl: `http://127.0.0.1:${actualPort}`,
    authToken: resolvedAuthToken,
    modelRuntime,
    taskManager,
    databaseFile: db.databaseFile,
    startLanApi,
    stopLanApi,
    get lanRuntime() { return lanRuntime; },
    close: async () => {
      await stopLanApi();
      await taskManager.close();
      await new Promise((resolve) => server.close(() => resolve()));
      db.close();
    },
  };
}

// The vector helpers are exported for tests: they carry the invariants that
// keep incompatible embeddings out of the store, and those are worth checking
// directly rather than only through an HTTP round trip.
module.exports = { startLocalApi, deviceMayReach, cosine, lexicalMatch, lexicalTerms, generateCardId, nextCardNumber, hashEmbedding, hasUsableEmbedding, relationScore, comparable, semanticBaseline, buildCover, embeddingSourceHash, standoutFloor, categoryPalette, assignCategoryAccents, COVER_VERSION };
