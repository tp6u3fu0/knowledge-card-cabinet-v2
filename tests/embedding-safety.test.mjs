/**
 * Guards against mixing incompatible embeddings.
 *
 * A store holds one kind of vector at a time. The failure this suite exists to
 * prevent is not a crash — it is the quiet one: a vector of the wrong width, or
 * from the wrong kind of model, scoring against real ones as though the number
 * meant something. Every check here is about making that impossible or loud.
 *
 * Run with:  node --test tests/embedding-safety.test.mjs
 */

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { cosine, hashEmbedding, hasUsableEmbedding, relationScore, comparable, semanticBaseline, standoutFloor, refreshSemanticBaseline } = require("../desktop/local-api.cjs");

const card = (embedding, overrides = {}) => ({
  id: "card", title: "標題", topic: "主題", category: "分類", tags: [], embedding, ...overrides,
});

test("cosine refuses vectors of different widths instead of truncating", () => {
  // Truncating to the shorter vector is the dangerous behaviour: it returns a
  // number in the normal range, so a 384-dim card mixed into a 1024-dim store
  // would rank in search with a score that means nothing.
  assert.throws(() => cosine(new Array(384).fill(0.1), new Array(1024).fill(0.1)), /維度不符/);
  assert.throws(() => cosine([1, 0], [1, 0, 0]), /維度不符/);
});

test("cosine rejects a missing vector rather than treating it as empty", () => {
  assert.throws(() => cosine(null, [1, 0]), /維度不符/);
  assert.throws(() => cosine([1, 0], undefined), /維度不符/);
});

test("cosine still computes similarity for matching widths", () => {
  assert.equal(cosine([1, 0, 0], [1, 0, 0]), 1);
  assert.equal(cosine([1, 0, 0], [0, 1, 0]), 0);
  assert.equal(cosine([1, 0, 0], [-1, 0, 0]), -1);
});

test("hashEmbedding produces the width it is asked for", () => {
  // The fallback has to be able to match whatever model is active, otherwise
  // it is itself a source of width drift.
  assert.equal(hashEmbedding("內容", 384).length, 384);
  assert.equal(hashEmbedding("內容", 1024).length, 1024);
  assert.equal(hashEmbedding("內容").length, 384, "defaults to the built-in width");
});

test("hashEmbedding stays deterministic and normalised at any width", () => {
  const first = hashEmbedding("同樣的內容", 1024);
  const second = hashEmbedding("同樣的內容", 1024);
  assert.deepEqual(first, second);
  const norm = Math.sqrt(first.reduce((sum, value) => sum + value * value, 0));
  assert.ok(Math.abs(norm - 1) < 1e-9, `expected a unit vector, got ${norm}`);
});

test("hasUsableEmbedding rejects what cannot be compared", () => {
  assert.equal(hasUsableEmbedding(card(null)), false, "a card awaiting reindex is not usable");
  assert.equal(hasUsableEmbedding(card([])), false, "an empty vector is not usable");
  assert.equal(hasUsableEmbedding(card([1, 0, 0])), true);
  assert.equal(hasUsableEmbedding(card([1, 0, 0]), 3), true);
  assert.equal(hasUsableEmbedding(card([1, 0, 0]), 1024), false, "wrong width for the store in use");
});

test("comparable requires both sides to carry the same width", () => {
  assert.equal(comparable(card([1, 0]), card([0, 1])), true);
  assert.equal(comparable(card([1, 0]), card([0, 1, 0])), false);
  assert.equal(comparable(card([1, 0]), card(null)), false);
});

test("relationScore skips an unscorable pair instead of inventing a number", () => {
  // null is distinguishable from a genuine 0 score, so callers can drop the
  // pair rather than record a relation that was never really measured.
  assert.equal(relationScore(card(null), card([1, 0])), null);
  assert.equal(relationScore(card([1, 0]), card([1, 0, 0])), null);
  assert.notEqual(relationScore(card([1, 0]), card([1, 0])), null);
});

/**
 * Vectors fanned along one arc, so every pair is similar but by varying amounts
 * — the shape a strong multilingual model actually produces, where nothing ever
 * scores low and the interesting signal is the spread, not the absolute value.
 */
function crowdedCollection(count = 10) {
  return Array.from({ length: count }, (_, index) => {
    const angle = index / (count - 1);
    const norm = Math.sqrt(1 + angle * angle);
    return card([1 / norm, angle / norm, 0], {
      id: `c${index}`,
      topic: `主題${index}`,
      category: `分類${index}`,
    });
  });
}

test("semanticBaseline measures the collection's own range", () => {
  const baseline = semanticBaseline(crowdedCollection());
  assert.ok(baseline, "a collection with spread produces a baseline");
  assert.ok(baseline.hi > baseline.lo, `expected a range, got ${JSON.stringify(baseline)}`);
  assert.ok(baseline.lo > 0.7, "these vectors really are crowded together");
});

test("semanticBaseline declines when there is nothing to measure", () => {
  assert.equal(semanticBaseline([]), null);
  assert.equal(semanticBaseline([card([1, 0]), card([0, 1])]), null, "too few cards to have a distribution");
  // Identical vectors have no spread, so normalising against them would divide
  // a zero range — the raw score has to stand.
  assert.equal(semanticBaseline(Array.from({ length: 8 }, (_, i) => card([1, 0, 0], { id: `x${i}` }))), null);
});

test("a pair only slightly above typical scores below a genuinely close pair", () => {
  // The failure this prevents: a strong model puts every pair above 0.7, so on
  // raw cosine a weak pair sharing a generic tag outranks a strongly related
  // pair that shares nothing. Measured against the collection, it must not.
  const collection = crowdedCollection();
  const baseline = semanticBaseline(collection);

  // Neighbours on the arc: very close, but sharing no category, topic or tag.
  const close = relationScore(collection[0], collection[1], baseline);
  // Opposite ends of the arc: the least similar pair there is, but filed
  // together — the shared label is the only thing they have in common.
  const distantButTagged = relationScore(
    { ...collection[0], category: "甲" },
    { ...collection.at(-1), id: "z", category: "甲" },
    baseline,
  );
  assert.ok(close > 0, "a near-identical pair still scores");
  assert.ok(
    close > distantButTagged,
    `closeness must beat a shared label: ${close} vs ${distantButTagged}`,
  );
});

test("relationScore blends semantic and lexical parts for a comparable pair", () => {
  // Identical vectors, but one pair shares a category and the other does not:
  // the lexical half must move the result, or the weighting is not applied.
  const shared = relationScore(card([1, 0], { category: "同" }), card([1, 0], { id: "b", category: "同" }));
  const apart = relationScore(card([1, 0], { category: "甲" }), card([1, 0], { id: "b", category: "乙" }));
  assert.ok(shared > apart, `sharing a category should score higher: ${shared} vs ${apart}`);
  assert.ok(shared <= 1 && apart >= 0);
});

/**
 * "Nothing here is about that" has to be an answer the search can give.
 *
 * Ranking cannot give it: every query has a best match, and the score shown is
 * a position inside the query's own range, so the top card reads 1.0 whatever
 * was typed. Searching a ninety-seven card cabinet for "橘子" returned fifty
 * cards about databases and distributed systems, each looking like a hit.
 *
 * The floor asks a different question — how far does the best match rise above
 * this query's median, measured in the cabinet's own units? Nothing is compared
 * against a constant cosine (§3.3): the unit is `semantic_baseline`, which is
 * this cabinet measured with this model.
 */
const spread = (lo, hi) => ({ lo, hi });

test("a query nothing in the cabinet answers clears no cards", () => {
  // What an unanswerable query looks like: every card equally, mildly close.
  const flat = [0.44, 0.45, 0.45, 0.46, 0.46, 0.46, 0.47, 0.47, 0.48, 0.50];
  const floor = standoutFloor(flat, spread(0.68, 0.79));
  assert.ok(floor !== null);
  assert.equal(flat.filter((score) => score >= floor).length, 0, "a flat distribution let something through");
});

test("a query the cabinet answers clears the cards that answer it", () => {
  // And what an answerable one looks like: the same crowd, plus a standout.
  const peaked = [0.44, 0.45, 0.45, 0.46, 0.46, 0.46, 0.47, 0.47, 0.62, 0.74];
  const floor = standoutFloor(peaked, spread(0.68, 0.79));
  const kept = peaked.filter((score) => score >= floor);
  assert.deepEqual(kept, [0.62, 0.74], `kept ${kept.join(", ")}`);
});

test("the floor is measured in the cabinet's units, not the query's", () => {
  const scores = [0.44, 0.45, 0.45, 0.46, 0.46, 0.46, 0.47, 0.47, 0.62, 0.74];
  // A cabinet whose own cards spread widely demands a bigger rise to stand out.
  const narrow = standoutFloor(scores, spread(0.68, 0.73));
  const wide = standoutFloor(scores, spread(0.60, 0.90));
  assert.ok(wide > narrow, "a wider cabinet did not demand more");
  assert.ok(scores.filter((s) => s >= wide).length < scores.filter((s) => s >= narrow).length);
});

test("the floor declines to have an opinion when it cannot have one", () => {
  const scores = [0.44, 0.45, 0.45, 0.46, 0.46, 0.46, 0.47, 0.47, 0.62, 0.74];
  assert.equal(standoutFloor(scores, null), null, "no baseline is still an opinion");
  assert.equal(standoutFloor(scores.slice(0, 5), spread(0.68, 0.79)), null, "five scores are not a distribution");
  assert.equal(standoutFloor(scores, spread(0.7, 0.7)), null, "a cabinet with no spread has no unit to measure in");
});

test("the cabinet's own similarity scale is kept, and remeasured as it grows", () => {
  // The scale is what standoutFloor measures against, and there is nowhere else
  // it comes from. It used to be computed inside the incremental relation
  // rebuild, used for the pair being scored, and dropped — so a cabinet built
  // one card at a time never had one, the floor took its `!baseline` exit for
  // every query, and search answered "橘子的種植與採收季節" with a full page of
  // cards about databases. Measured on 58 real cards: no-result accuracy 0%.
  const spread = (index) => {
    // Vectors far enough apart to give the collection an actual distribution;
    // a cabinet whose cards are all alike has no scale and is allowed none.
    const angle = (index % 12) * 0.22;
    return [Math.cos(angle), Math.sin(angle), (index % 5) * 0.03];
  };
  const card = (index) => ({ id: `c${index}`, embedding: spread(index), deleted_at: null });

  const store = { cards: Array.from({ length: 12 }, (_, index) => card(index)) };
  const first = refreshSemanticBaseline(store);
  assert.ok(first, "a cabinet with a real spread produced no scale at all");
  assert.equal(store.semantic_baseline, first, "the scale was computed and then thrown away");
  assert.equal(store.semantic_baseline_cards, 12);

  // Called again with nothing changed, it does not recompute.
  const sameObject = store.semantic_baseline;
  refreshSemanticBaseline(store);
  assert.equal(store.semantic_baseline, sameObject, "the scale is remeasured on every single save");

  // Grown by a fifth, it does.
  store.cards.push(...Array.from({ length: 4 }, (_, index) => card(100 + index)));
  refreshSemanticBaseline(store);
  assert.equal(store.semantic_baseline_cards, 16, "a growing cabinet is still measured against its first few cards");

  // And a forced rebuild always remeasures, whatever the counts say.
  store.semantic_baseline_cards = 16;
  store.cards.push(card(200));
  refreshSemanticBaseline(store, { force: true });
  assert.equal(store.semantic_baseline_cards, 17);
});
