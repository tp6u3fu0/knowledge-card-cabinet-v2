/**
 * The local API on its own, for frontend development.
 *
 * `npm run serve` starts the API together with a production build of the
 * frontend, which is what a real install does but has no HMR. During
 * development the frontend runs from Vite instead, so it needs the API on a
 * predictable address rather than the random port the app normally picks.
 *
 *   npm run dev:api     # this, in one terminal
 *   npm run dev         # the frontend, in another
 *
 * Environment:
 *   KCC_DATA_DIR    where the development cabinet lives (default ./data)
 *   KCC_API_PORT    port to listen on (default 8000)
 *   KCC_API_TOKEN   token the frontend must present (default kcc-local-dev-token)
 */

import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);
const { startLocalApi } = require("../desktop/local-api.cjs");

const root = path.resolve(import.meta.dirname, "..");
const dataDir = process.env.KCC_DATA_DIR || path.join(root, "data");
const port = Number(process.env.KCC_API_PORT || 8000);
// A fixed token in development only: run-vinext.mjs hands the frontend the same
// default, so the two halves line up without any setup.
const authToken = process.env.KCC_API_TOKEN || "kcc-local-dev-token";

mkdirSync(dataDir, { recursive: true });

const runtime = await startLocalApi({
  dataFile: path.join(dataDir, "cards.json"),
  modelsDir: process.env.KCC_MODELS_DIR || path.join(dataDir, "models"),
  seedPath: path.join(root, "desktop", "seed.json"),
  migrateFromUrl: "",
  authToken,
  port,
});

console.log(`本機 API  ${runtime.baseUrl}`);
console.log(`資料庫    ${runtime.databaseFile}`);
console.log(`權杖      ${authToken}`);
console.log("在另一個終端機執行 npm run dev 啟動前端。");

const shutdown = async () => {
  await runtime.close();
  process.exit(0);
};
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => void shutdown());
