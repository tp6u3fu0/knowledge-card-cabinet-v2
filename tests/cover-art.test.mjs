import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const { buildCover, COVER_VERSION } = require("../desktop/local-api.cjs");
const { startLocalApi } = await import("../desktop/local-api.cjs");

const projectRoot = new URL("../", import.meta.url);
const seedPath = join(projectRoot.pathname.slice(1), "desktop", "seed.json");

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

  // Enough distinct cards to exercise the shape-selection arithmetic rather
  // than whichever glyph one id happens to land on.
  for (let index = 0; index < 120; index += 1) {
    const cover = buildCover(`card-${index}`);
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

test("covers are stable for a given card, and differ between cards", async () => {
  assert.deepEqual(buildCover("card-1"), buildCover("card-1"));
  assert.notDeepEqual(buildCover("card-1"), buildCover("card-2"));
});

/**
 * The gradient focus in app/card-face.tsx reads these two, and drawing them
 * from the embedding left them dead: a chunk mean of a normalised vector sits
 * at zero by construction, so across two hundred cards `density` took four
 * distinct values and moved the focus by a fifth of a percent. Nothing failed;
 * the covers simply all shared a highlight.
 */
test("density and orbit actually vary between cards", async () => {
  const covers = Array.from({ length: 200 }, (_, index) => buildCover(`spread-${index}`));
  for (const field of ["density", "orbit"]) {
    const values = new Set(covers.map((cover) => cover[field]));
    assert.ok(values.size > 100, `${field} took only ${values.size} distinct values across 200 cards`);
  }
  // The ranges the consuming formulas were written for.
  for (const cover of covers) {
    assert.ok(cover.density >= 0.55 && cover.density <= 1);
    assert.ok(cover.orbit >= 0 && cover.orbit <= 1);
  }
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
 * A cover holds still.
 *
 * The art used to be drawn from the card's embedding, on the theory that it
 * would then track what the card means. It never did — every value passes
 * through a SHA-256 of the vector, so two cards that say the same thing in
 * different words agreed on about as many glyphs as two unrelated ones. What it
 * did do was move: the source hash spans nine fields, so correcting a typo
 * repainted the card into something its owner had never seen, and a model
 * upgrade repainted the whole shelf at once.
 *
 * It now hangs on the card's id, which is the one thing that does not change.
 * These tests drive the real API, because the guarantee is about what happens
 * to a card that someone edits — not about any one function.
 */
async function cabinet(t) {
  const root = await mkdtemp(join(tmpdir(), "kcc-cover-"));
  const runtime = await startLocalApi({
    dataFile: join(root, "cards.json"),
    modelsDir: join(root, "models"),
    seedPath,
    migrateFromUrl: "",
  });
  t.after(async () => {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  });
  const headers = { Authorization: `Bearer ${runtime.authToken}`, "Content-Type": "application/json" };
  return {
    add: async (id, fields) => {
      const response = await fetch(`${runtime.baseUrl}/cards`, {
        method: "POST", headers,
        body: JSON.stringify({ id, number: id.toUpperCase(), topic: "測試", category: "測試", ...fields }),
      });
      assert.equal(response.status, 200);
      return (await response.json()).card;
    },
    patch: async (id, changes) => {
      const response = await fetch(`${runtime.baseUrl}/cards/${id}`, { method: "PATCH", headers, body: JSON.stringify(changes) });
      assert.equal(response.status, 200);
      return (await response.json()).card;
    },
  };
}

test("rewriting a card does not repaint it", async (t) => {
  const { add, patch } = await cabinet(t);
  const before = await add("hold-still", { title: "B+ 樹", summary: "所有資料在葉節點且相連，適合範圍查詢。" });

  // A typo fix — the smallest edit there is, and the one that used to cost a
  // card every glyph it had.
  const nudged = await patch("hold-still", { summary: "所有資料在葉節點且相連，適合範圍查詢" });
  assert.deepEqual(nudged.cover, before.cover, "deleting one character redrew the cover");

  // And a rewrite of every field the source hash covers.
  const rewritten = await patch("hold-still", {
    title: "完全不同的標題", question: "另一個問題", summary: "另一段摘要",
    analogy: "另一個比喻", detail: "另一段細節", source: "另一個出處", tags: ["新標籤"],
  });
  assert.deepEqual(rewritten.cover, before.cover, "rewriting a card redrew the cover");
});

test("two cards with identical writing still look different", async (t) => {
  const { add } = await cabinet(t);
  const twin = { title: "一模一樣", summary: "一模一樣的內容" };
  const left = await add("twin-a", twin);
  const right = await add("twin-b", twin);
  assert.equal(left.cover.accent, right.cover.accent, "same category, so same colour");
  assert.notDeepEqual(left.cover.motifs, right.cover.motifs, "two cards were given the same picture");
});
