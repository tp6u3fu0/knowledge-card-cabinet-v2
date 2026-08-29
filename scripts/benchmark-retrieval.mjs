/**
 * How good is the search, not whether it is broken.
 *
 * The unit tests answer "does retrieval still work" — they are regression
 * guards and they run against a stand-in embedding service so they need no
 * weights and no network. They cannot answer the question this product lives
 * or dies on: when someone types what they half-remember, does the right card
 * come back near the top?
 *
 * This is that measurement. It is a development tool, deliberately not part of
 * the app: nothing here is shipped, and no analytics are added to the runtime
 * to produce it (CLAUDE.md §3.22).
 *
 *   npm run benchmark:retrieval                 # the real bundled model
 *   npm run benchmark:retrieval -- --lexical    # the model broken, text only
 *   npm run benchmark:retrieval -- --json out.json
 *   npm run benchmark:retrieval -- --failures   # print every miss
 *   npm run benchmark:retrieval -- --gate       # fail on a regression
 *   npm run benchmark:retrieval -- --update-baseline
 *
 * A run against a cabinet of 58 cards costs one embedding pass over all of
 * them plus one per query, so it takes minutes rather than seconds. That is the
 * price of measuring the real model rather than a fixture (spec §16).
 */

import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { startLocalApi } = require("../desktop/local-api.cjs");

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "..", "tests", "fixtures", "retrieval-benchmark");

const argv = process.argv.slice(2);
const lexicalOnly = argv.includes("--lexical");
const showFailures = argv.includes("--failures");
const gating = argv.includes("--gate");
const updatingBaseline = argv.includes("--update-baseline");
const baselineAt = join(fixtures, "baseline.json");
/**
 * How far Recall@3 may fall before a change has to argue for itself.
 *
 * Two points, from the spec: below that is inside the noise of a 114-query set
 * (one query is 0.9 points), above it is a real loss of retrieval that has to
 * be paid for with something — usually no-result accuracy, which is the metric
 * most often traded against it.
 */
const RECALL_AT_3_TOLERANCE = 0.02;
/** No-result accuracy is allowed less slack: it only moves when something real changed. */
const NO_RESULT_TOLERANCE = 0.05;

const jsonAt = argv.includes("--json")
  ? (argv[argv.indexOf("--json") + 1] || join(here, "..", "artifacts", "retrieval-benchmark.json"))
  : "";

/** A "model" that refuses everything, which is what a broken one looks like. */
async function refusingEmbeddingService() {
  const server = createServer((request, response) => {
    response.statusCode = 503;
    response.end("embedding unavailable");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}/embed`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

function percentile(sorted, fraction) {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index];
}

function pad(text, width) {
  const cells = [...String(text)];
  // Chinese renders double-width in a terminal, so count columns not characters
  // or every table in this report comes out ragged.
  const columns = cells.reduce((sum, ch) => sum + (/[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹯＀-｠￠-￦]/u.test(ch) ? 2 : 1), 0);
  return `${text}${" ".repeat(Math.max(0, width - columns))}`;
}

async function main() {
  const cards = JSON.parse(await readFile(join(fixtures, "cards.json"), "utf8"));
  const queries = JSON.parse(await readFile(join(fixtures, "queries.json"), "utf8"));

  const root = await mkdtemp(join(tmpdir(), "kcc-benchmark-"));
  process.env.KCC_UPDATE_CHECK = "off";
  const service = lexicalOnly ? await refusingEmbeddingService() : null;

  const runtime = await startLocalApi({
    dataFile: join(root, "data", "cards.json"),
    modelsDir: join(root, "models"),
    seedPath: "",
    migrateFromUrl: "",
  });
  const headers = { Authorization: `Bearer ${runtime.authToken}`, "Content-Type": "application/json" };
  const call = async (method, path, body) => {
    const response = await fetch(`${runtime.baseUrl}/api/v1${path}`, {
      method, headers, body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  };

  try {
    if (service) {
      const switched = await call("PUT", "/settings", {
        summary: { source: "local" },
        embedding: { source: "api", api_url: service.url, api_format: "tei", model: "unavailable" },
      });
      if (switched.status !== 202 && switched.status !== 200) {
        throw new Error(`could not break the model on purpose: ${JSON.stringify(switched.body)}`);
      }
    }

    const models = await call("GET", "/models");
    const active = (models.body?.models ?? []).find((model) => model.kind === "embedding" && model.active);
    const modelLabel = lexicalOnly ? "(refused — lexical only)" : `${active?.label ?? "unknown"} · ${active?.dimensions ?? "?"}d`;

    process.stderr.write(`載入 ${cards.length} 張卡（模型：${modelLabel}）…\n`);
    const indexStarted = Date.now();
    for (const card of cards) {
      const result = await call("POST", "/cards", { ...card, number: card.id.toUpperCase(), topic: card.category, source: "benchmark-fixture" });
      if (result.status !== 200) throw new Error(`could not add ${card.id}: ${JSON.stringify(result.body)}`);
    }
    const indexMs = Date.now() - indexStarted;

    const rows = [];
    let cold = null;
    for (const entry of queries) {
      const started = Date.now();
      const result = await call("GET", `/search?q=${encodeURIComponent(entry.query)}&limit=10`);
      const ms = Date.now() - started;
      if (cold === null) cold = ms;
      if (result.status !== 200) throw new Error(`search failed: ${JSON.stringify(result.body)}`);
      const returned = result.body.map((card) => card.id);
      // The best position any acceptable answer reached, 1-based; 0 for a miss.
      const rank = returned.findIndex((id) => entry.expected.includes(id)) + 1;
      rows.push({ ...entry, returned, rank, ms });
    }

    const answerable = rows.filter((row) => row.expected.length > 0);
    const absent = rows.filter((row) => row.expected.length === 0);
    const recallAt = (k) => answerable.filter((row) => row.rank > 0 && row.rank <= k).length / (answerable.length || 1);
    const mrr = answerable.reduce((sum, row) => sum + (row.rank > 0 ? 1 / row.rank : 0), 0) / (answerable.length || 1);
    const noResult = absent.filter((row) => row.returned.length === 0).length / (absent.length || 1);

    // The first query pays for loading the model; every later one does not, and
    // reporting them together hides both numbers.
    const warm = rows.slice(1).map((row) => row.ms).sort((a, b) => a - b);
    const percent = (value) => `${(value * 100).toFixed(1)}%`;

    const byIntent = new Map();
    for (const row of answerable) {
      const bucket = byIntent.get(row.intent) ?? { total: 0, at1: 0, at3: 0 };
      bucket.total += 1;
      if (row.rank === 1) bucket.at1 += 1;
      if (row.rank > 0 && row.rank <= 3) bucket.at3 += 1;
      byIntent.set(row.intent, bucket);
    }

    const report = [
      "",
      "Retrieval Benchmark",
      "────────────────────────",
      "",
      `Cards      ${cards.length}`,
      `Queries    ${rows.length}  (${answerable.length} answerable, ${absent.length} should return nothing)`,
      `Model      ${modelLabel}`,
      "",
      `Recall@1   ${percent(recallAt(1))}`,
      `Recall@3   ${percent(recallAt(3))}`,
      `Recall@5   ${percent(recallAt(5))}`,
      `MRR        ${mrr.toFixed(3)}`,
      "",
      "No-result accuracy",
      `           ${percent(noResult)}`,
      "",
      "By intent            Recall@1   Recall@3",
      ...[...byIntent.entries()].map(([intent, bucket]) => `  ${pad(intent, 19)}${pad(percent(bucket.at1 / bucket.total), 11)}${percent(bucket.at3 / bucket.total)}`),
      "",
      "Latency",
      `  cold      ${cold} ms   (first query; includes loading the model)`,
      `  warm p50  ${percentile(warm, 0.5)} ms`,
      `  warm p95  ${percentile(warm, 0.95)} ms`,
      `  warm max  ${warm[warm.length - 1] ?? 0} ms`,
      `  indexing  ${(indexMs / 1000).toFixed(1)} s for ${cards.length} cards`,
      "",
    ];
    process.stdout.write(`${report.join("\n")}\n`);

    if (showFailures) {
      const missed = answerable.filter((row) => row.rank === 0 || row.rank > 3);
      const noisy = absent.filter((row) => row.returned.length > 0);
      process.stdout.write(`Misses (not in top 3): ${missed.length}\n`);
      for (const row of missed) {
        process.stdout.write(`  [${row.intent}] ${row.query}\n    want ${row.expected.join(", ")} · got ${row.returned.slice(0, 3).join(", ") || "(nothing)"}\n`);
      }
      process.stdout.write(`\nShould have returned nothing: ${noisy.length}\n`);
      for (const row of noisy) {
        process.stdout.write(`  ${row.query}\n    got ${row.returned.slice(0, 3).join(", ")}\n`);
      }
      process.stdout.write("\n");
    }

    const summary = {
      generated_at: new Date().toISOString(),
      mode: lexicalOnly ? "lexical-only" : "hybrid",
      model: modelLabel,
      cards: cards.length,
      queries: rows.length,
      recall_at_1: recallAt(1),
      recall_at_3: recallAt(3),
      recall_at_5: recallAt(5),
      mrr,
      no_result_accuracy: noResult,
    };

    if (updatingBaseline) {
      await writeFile(baselineAt, `${JSON.stringify({
        ...summary,
        note: "Recorded by `npm run benchmark:retrieval -- --update-baseline`. "
          + "Moving this file down is a product decision, not a chore: say in the commit what was bought with it.",
      }, null, 2)}\n`, "utf8");
      process.stderr.write(`基準線已更新：${baselineAt}\n`);
    }

    if (gating) {
      const baseline = JSON.parse(await readFile(baselineAt, "utf8"));
      if (baseline.mode !== summary.mode) {
        throw new Error(`baseline is ${baseline.mode}, this run is ${summary.mode}; they are not comparable`);
      }
      const points = (value) => `${(value * 100).toFixed(1)}%`;
      const checks = [
        ["Recall@3", baseline.recall_at_3, summary.recall_at_3, RECALL_AT_3_TOLERANCE],
        ["No-result accuracy", baseline.no_result_accuracy, summary.no_result_accuracy, NO_RESULT_TOLERANCE],
      ];
      const lost = checks.filter(([, before, after, tolerance]) => after < before - tolerance);
      process.stdout.write("Gate\n");
      for (const [name, before, after, tolerance] of checks) {
        const verdict = after < before - tolerance ? "REGRESSION" : after < before ? "within tolerance" : "ok";
        process.stdout.write(`  ${pad(name, 22)}${pad(points(before), 10)}→ ${pad(points(after), 10)}${verdict}\n`);
      }
      process.stdout.write("\n");
      if (lost.length > 0) {
        process.stderr.write(
          "搜尋品質下降超過容許範圍。這不是自動失敗就該改回去——\n"
          + "如果這個交換是划算的（例如 no-result 大幅提升），在 commit 訊息裡寫出前後數字與理由，\n"
          + "再用 --update-baseline 把基準線移下來。\n",
        );
        process.exitCode = 1;
      }
    }

    if (jsonAt) {
      await mkdir(dirname(jsonAt), { recursive: true });
      await writeFile(jsonAt, `${JSON.stringify({
        ...summary,
        latency_ms: { cold, warm_p50: percentile(warm, 0.5), warm_p95: percentile(warm, 0.95), warm_max: warm[warm.length - 1] ?? 0 },
        by_intent: Object.fromEntries([...byIntent].map(([intent, b]) => [intent, { recall_at_1: b.at1 / b.total, recall_at_3: b.at3 / b.total, queries: b.total }])),
        results: rows.map(({ query, intent, expected, rank, returned, ms }) => ({ query, intent, expected, rank, returned: returned.slice(0, 5), ms })),
      }, null, 2)}\n`, "utf8");
      process.stderr.write(`寫入 ${jsonAt}\n`);
    }
  } finally {
    await runtime.close();
    if (service) await service.close();
    await rm(root, { recursive: true, force: true });
  }
}

await main();
