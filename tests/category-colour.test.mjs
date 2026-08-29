import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

const require = createRequire(import.meta.url);
const { assignCategoryAccents, buildCover, categoryPalette } = require("../desktop/local-api.cjs");
const { startLocalApi } = await import("../desktop/local-api.cjs");

const projectRoot = new URL("../", import.meta.url);
const seedPath = join(projectRoot.pathname.slice(1), "desktop", "seed.json");

test("a category owns exactly one colour, whatever the card says", () => {
  const cards = ["card-attention", "card-vector-db", "card-backprop"];
  const accents = cards.map((id) => buildCover(id, "人工智慧").accent);
  assert.equal(new Set(accents).size, 1, `same category produced ${accents.join(", ")}`);

  // ...and the rest of the cover still varies, or every card would look alike.
  const covers = cards.map((id) => buildCover(id, "人工智慧"));
  assert.ok(new Set(covers.map((cover) => cover.seed)).size > 1);
  assert.ok(new Set(covers.map((cover) => JSON.stringify(cover.motifs))).size > 1);
});

test("the colour follows the category, and blank means uncategorised", () => {
  const store = { categories: ["人工智慧", "烹飪"], cards: [], category_accents: {} };
  assignCategoryAccents(store);
  assert.notEqual(
    categoryPalette("人工智慧", store.category_accents).accent,
    categoryPalette("烹飪", store.category_accents).accent,
  );
  assert.equal(categoryPalette("", store.category_accents).accent, categoryPalette("待分類", store.category_accents).accent);
});

test("colours spread evenly instead of piling onto one accent", () => {
  // The real cabinet's categories. Hashing alone put five of these on one
  // accent, which is the failure this assignment exists to avoid.
  const categories = ["人工智慧", "分散式系統", "天文學", "生成式 AI", "生物學", "生活科學", "物理與資訊", "待分類", "推理方法", "程式設計", "經濟學", "資料庫", "學習科學", "測試"];
  const store = { categories, cards: [], category_accents: {} };
  assignCategoryAccents(store);

  const counts = new Map();
  for (const name of categories) {
    const accent = categoryPalette(name, store.category_accents).accent;
    counts.set(accent, (counts.get(accent) ?? 0) + 1);
  }
  assert.equal(counts.size, 8, `used ${counts.size} of 8 accents`);
  // 14 categories over 8 accents: the best possible spread is 6 pairs and 2
  // singles, so nothing may carry three.
  assert.equal(Math.max(...counts.values()), 2, `most-used accent carries ${Math.max(...counts.values())}`);
});

test("an existing category never changes colour when the cabinet does", () => {
  const store = { categories: ["人工智慧", "烹飪", "經濟學"], cards: [], category_accents: {} };
  assignCategoryAccents(store);
  const before = { ...store.category_accents };

  // Add several, remove one: the survivors must keep exactly what they had.
  store.categories = ["人工智慧", "烹飪", "天文學", "生物學", "資料庫"];
  assignCategoryAccents(store);
  for (const name of ["人工智慧", "烹飪"]) {
    assert.equal(store.category_accents[name], before[name], `${name} was repainted`);
  }
  // The removed category releases its accent rather than holding it forever.
  assert.equal(Object.hasOwn(store.category_accents, "經濟學"), false);
});

test("backend palette, stylesheet and frontend list agree", async () => {
  const css = await readFile(new URL("app/globals.css", projectRoot), "utf8");
  const types = await readFile(new URL("app/collection/types.ts", projectRoot), "utf8");

  const declared = types.match(/visualAccents = \[([^\]]+)\]/u);
  assert.ok(declared, "types.ts no longer declares visualAccents");
  const frontend = [...declared[1].matchAll(/"([^"]+)"/gu)].map((match) => match[1]);

  // Everything the backend can hand the frontend, by filling the palette.
  const store = { categories: Array.from({ length: 32 }, (_, index) => `probe-${index}`), cards: [], category_accents: {} };
  assignCategoryAccents(store);
  const backendAccents = [...new Set(Object.values(store.category_accents))];
  assert.equal(backendAccents.length, 8);

  for (const accent of backendAccents) {
    assert.ok(frontend.includes(accent), `backend can emit "${accent}", which types.ts does not list`);
    // Without the CSS rule the card falls back to an unstyled accent, which is
    // the silent kind of breakage this whole file exists to prevent.
    assert.match(css, new RegExp(`--accent-${accent}:`), `globals.css defines no --accent-${accent}`);
    assert.match(css, new RegExp(`\\.collection-card--${accent}`), `globals.css has no rule for .collection-card--${accent}`);
  }
});

test("moving a card to another category repaints it", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "kcc-colour-"));
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

  const auth = { Authorization: `Bearer ${runtime.authToken}`, "Content-Type": "application/json" };
  const add = async (id, category, title) => {
    const response = await fetch(`${runtime.baseUrl}/cards`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ id, number: id.toUpperCase(), topic: category, category, title, summary: `${title} 的內容` }),
    });
    assert.equal(response.status, 200);
    return (await response.json()).card;
  };

  const first = await add("colour-1", "人工智慧", "測試卡片");
  const sibling = await add("colour-2", "人工智慧", "同分類的另一張");
  const cook = await add("colour-3", "烹飪", "另一個分類");

  // The rule itself: one category, one colour.
  assert.equal(first.cover.accent, sibling.cover.accent, "cards in one category differ in colour");
  assert.notEqual(first.cover.accent, cook.cover.accent, "two categories share a colour while accents are free");

  const moved = await fetch(`${runtime.baseUrl}/cards/colour-1`, {
    method: "PATCH",
    headers: auth,
    body: JSON.stringify({ category: "烹飪" }),
  });
  assert.equal(moved.status, 200);
  const after = (await moved.json()).card.cover.accent;
  assert.equal(after, cook.cover.accent, "a moved card kept its old category's colour");

  // The card it left behind must not have been dragged along with it.
  const remaining = await (await fetch(`${runtime.baseUrl}/cards/colour-2`, { headers: auth })).json();
  assert.equal(remaining.cover.accent, sibling.cover.accent);
});
