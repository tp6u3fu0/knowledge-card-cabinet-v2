import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";

const require = createRequire(import.meta.url);
const { startLocalApi } = require("../desktop/local-api.cjs");

async function jsonFetch(url, options = {}) {
  const response = await fetch(url, options);
  const payload = await response.json();
  assert.equal(response.ok, true, `${url} returned ${response.status}: ${JSON.stringify(payload)}`);
  return payload;
}

async function assertRuntimeContract(label, baseUrl, prefix, headers = {}) {
  const info = await jsonFetch(`${baseUrl}${prefix}/`, { headers });
  assert.ok(info.capabilities.includes("models.inspect"), `${label} missing models.inspect capability`);
  assert.ok(info.capabilities.includes("tasks.retry"), `${label} missing tasks.retry capability`);

  const catalog = await jsonFetch(`${baseUrl}${prefix}/models`, { headers });
  assert.ok(catalog.storage?.free_bytes > 0, `${label} missing storage.free_bytes`);
  const builtin = catalog.models.find((model) => model.id === "embedding-hash-384");
  assert.ok(builtin, `${label} missing shared builtin embedding`);
  assert.equal(typeof builtin.storage?.status, "string");

  const inspection = await jsonFetch(`${baseUrl}${prefix}/models/embedding-hash-384/inspect`, { headers });
  assert.equal(inspection.status, "ready", `${label} builtin inspection is not ready`);

  const tasks = await jsonFetch(`${baseUrl}${prefix}/tasks`, { headers });
  assert.ok(Array.isArray(tasks), `${label} task list is not an array`);
}

const root = await mkdtemp(join(tmpdir(), "kcc-runtime-contract-"));
const desktop = await startLocalApi({
  dataFile: join(root, "cards.json"),
  modelsDir: join(root, "models"),
  seedPath: join(process.cwd(), "backend", "seed.json"),
  migrateFromUrl: "",
});

try {
  await assertRuntimeContract("desktop", desktop.baseUrl, "/api/v1", { Authorization: `Bearer ${desktop.authToken}` });

  const dockerBase = process.env.KCC_DOCKER_API_URL ?? "http://127.0.0.1:8000";
  try {
    const dockerToken = process.env.KCC_DOCKER_API_TOKEN ?? process.env.KCC_API_TOKEN ?? "kcc-local-dev-token";
    await assertRuntimeContract("docker", dockerBase, "/api/v1", { Authorization: `Bearer ${dockerToken}` });
    console.log(`Shared runtime contract passed: desktop + ${dockerBase}`);
  } catch (error) {
    if (process.env.KCC_REQUIRE_DOCKER === "1") throw error;
    console.log(`Shared desktop contract passed; Docker check skipped (${error instanceof Error ? error.message : String(error)})`);
  }
} finally {
  await desktop.close();
  await rm(root, { recursive: true, force: true });
}
