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
const { cosine, hashEmbedding, hasUsableEmbedding, relationScore, comparable, semanticBaseline } = require("../desktop/local-api.cjs");

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
