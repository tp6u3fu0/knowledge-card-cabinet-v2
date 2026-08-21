import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { buildCover, COVER_VERSION, hashEmbedding, coverState, coverNeedsRedraw, embeddingSourceHash } = require("../desktop/local-api.cjs");

/**
 * The glyph names the frontend can actually draw. A cover naming anything else
 * still renders — as the fallback glyph — so this mismatch is invisible at
 * runtime and produced a whole cabinet of identical covers once already.
 */
async function drawableGlyphs() {
  const source = await readFile(new URL("../app/cover-art.tsx", import.meta.url), "utf8");
  const union = source.match(/export type CoverGlyph =([\s\S]*?);/);
  assert.ok(union, "app/cover-art.tsx no longer declares a CoverGlyph union");
  const names = [...union[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  assert.ok(names.length > 1);

  // The union is the contract, but the library is what renders; they must agree.
  const library = source.match(/const glyphLibrary: Record<CoverGlyph, ReactNode> = \{([\s\S]*?)\n\};/);
  assert.ok(library, "app/cover-art.tsx no longer declares glyphLibrary");
  for (const name of names) {
    assert.ok(
      new RegExp(`(^|\\n)\\s+(${name}|"${name}"):`).test(library[1]),
      `CoverGlyph "${name}" has no entry in glyphLibrary`,
    );
  }
  return new Set(names);
}

test("every generated cover uses glyphs the frontend can draw", async () => {
  const glyphs = await drawableGlyphs();
  const seen = new Set();

  // Enough distinct vectors to exercise the shape-selection arithmetic rather
  // than whichever glyph one embedding happens to land on.
  for (let index = 0; index < 120; index += 1) {
    const cover = buildCover(hashEmbedding(`卡片內容 ${index} sample text`, 384));
    assert.equal(cover.version, COVER_VERSION);
    assert.ok(cover.motifs.length >= 8 && cover.motifs.length <= 12);
    for (const motif of cover.motifs) {
      assert.ok(glyphs.has(motif.shape), `cover used glyph "${motif.shape}", which the frontend cannot draw`);
      assert.ok(motif.opacity > 0 && motif.opacity <= 1);
      assert.ok(motif.size > 0);
      seen.add(motif.shape);
    }
  }

  // A cover set that only ever reaches a couple of glyphs carries no
  // information about the card, which is the bug this test exists for.
  assert.ok(seen.size >= 8, `only ${seen.size} distinct glyphs were ever produced: ${[...seen].join(", ")}`);
});

test("covers are stable for a given embedding", async () => {
  const embedding = hashEmbedding("穩定性測試", 384);
  assert.deepEqual(buildCover(embedding), buildCover(embedding));
  assert.notDeepEqual(buildCover(embedding), buildCover(hashEmbedding("另一張卡", 384)));
});

test("the settings glossary is coherent and draws only real glyphs", async () => {
  const drawable = await drawableGlyphs();
  const source = await readFile(new URL("../app/collection/glossary.ts", import.meta.url), "utf8");

  const glyphs = [...source.matchAll(/glyph: "([^"]+)"/gu)].map((match) => match[1]);
  assert.ok(glyphs.length >= 8, `expected a glossary of some size, found ${glyphs.length} entries`);
  for (const glyph of glyphs) {
    // A glossary card naming an unknown glyph silently falls back to the same
    // default shape as every other card, which is exactly the failure that made
    // a whole cabinet of covers identical once already.
    assert.ok(drawable.has(glyph), `glossary glyph "${glyph}" is not in the frontend glyph library`);
  }

  const numbers = [...source.matchAll(/number: "([^"]+)"/gu)].map((match) => match[1]);
  assert.equal(new Set(numbers).size, numbers.length, "two glossary cards share a number");

  const accents = [...source.matchAll(/accent: "([^"]+)"/gu)].map((match) => match[1]);
  const types = await readFile(new URL("../app/collection/types.ts", import.meta.url), "utf8");
  const known = new Set([...(types.match(/visualAccents = \[([^\]]+)\]/u)?.[1] ?? "").matchAll(/"([^"]+)"/gu)].map((match) => match[1]));
  for (const accent of accents) {
    assert.ok(known.has(accent), `glossary accent "${accent}" has no rule in globals.css`);
  }

  // Every settings tab has terms worth explaining; a scope with none means a
  // tab quietly lost its plain-language cards.
  for (const scope of ["local", "api", "data", "devices"]) {
    assert.ok(source.includes(`scope: "${scope}"`), `no glossary entry for the ${scope} tab`);
  }

  // Cards are placed by id now, not by scope. An id referenced from the panels
  // that no longer exists renders nothing at all — silently, and exactly where
  // the explanation was supposed to be.
  const panels = await readFile(new URL("../app/collection/panels.tsx", import.meta.url), "utf8");
  const ids = new Set([...source.matchAll(/^\s{4}id: "([^"]+)"/gmu)].map((match) => match[1]));
  // Both spellings: the ids reach a card either straight through GlossaryAside
  // or as a section's glossaryIds prop. Keep these as plain literal arrays —
  // an id built by an expression is one this check cannot see.
  const referenced = [...panels.matchAll(/(?:glossaryIds|ids)=\{\[([^\]]*)\]\}/gu)]
    .flatMap((match) => [...match[1].matchAll(/"([^"]+)"/gu)].map((inner) => inner[1]));
  assert.ok(referenced.length >= 6, `panels reference only ${referenced.length} glossary cards`);
  for (const id of referenced) {
    assert.ok(ids.has(id), `panels.tsx asks for glossary card "${id}", which glossary.ts does not define`);
  }
});

/**
 * Covers hold still when the model changes.
 *
 * A cabinet's covers are how a person finds a card by eye. Rebuilding them from
 * whatever vector is current means every upgrade repaints the whole shelf: the
 * categories are untouched, the colours are untouched, and yet nothing looks
 * like itself. The rule is that the art describes what the card *said*, so only
 * the writing changing — or the card never having had a real vector — earns a
 * redraw.
 */
const cardWithArt = (overrides = {}) => {
  const card = {
    id: "card", number: "K-1", title: "標題", question: "問題", summary: "摘要",
    analogy: "比喻", detail: "細節", topic: "主題", category: "分類", source: "", tags: [],
    embedding: hashEmbedding("原本的內容", 384),
    ...overrides,
  };
  card.embedding_source_hash = overrides.embedding_source_hash ?? embeddingSourceHash(card);
  // Mirrors coverVector(): a card with no model vector is still drawn, from the
  // hashed stand-in. `in` rather than `??` so an explicit null survives.
  const source = Array.isArray(card.embedding) && card.embedding.length > 0
    ? card.embedding
    : hashEmbedding("原本的內容", 384);
  card.cover = "cover" in overrides ? overrides.cover : buildCover(source, card.category);
  return card;
};

test("switching models does not redraw a cover", () => {
  const card = cardWithArt();
  const before = coverState(card);
  // What a model switch does: the same writing, a brand new vector.
  card.embedding = hashEmbedding("原本的內容", 512);
  assert.equal(coverNeedsRedraw(card, before), false);
});

test("editing what a card says does redraw its cover", () => {
  const card = cardWithArt();
  card.title = "改過的標題";
  const before = coverState(card);
  assert.equal(coverNeedsRedraw(card, before), true);
});

test("a card that never had a real vector gets its cover drawn once it does", () => {
  // Before a model answers, a card carries art from the hashed stand-in. That
  // art is a placeholder and must give way to the real thing.
  const card = cardWithArt({ embedding: null });
  const before = coverState(card);
  card.embedding = hashEmbedding("原本的內容", 384);
  assert.equal(coverNeedsRedraw(card, before), true);
});

test("a card with no cover at all always gets one", () => {
  const card = cardWithArt({ cover: null });
  const before = coverState(card);
  assert.equal(coverNeedsRedraw(card, before), true);
});
