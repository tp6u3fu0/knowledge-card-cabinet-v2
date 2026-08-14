import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { buildCover, COVER_VERSION, hashEmbedding } = require("../desktop/local-api.cjs");

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
