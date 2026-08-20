import { readFile } from "node:fs/promises";

const root = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const desktop = JSON.parse(await readFile(new URL("../desktop/package.json", import.meta.url), "utf8"));
if (root.version !== desktop.version) {
  throw new Error(`root package version ${root.version} != desktop package version ${desktop.version}`);
}
if (root.version === "0.0.0" || !/^\d+\.\d+\.\d+$/u.test(root.version)) {
  throw new Error(`invalid release version: ${root.version}`);
}

// The update check reads the repository out of the desktop manifest to decide
// whose releases to compare against, so a fork that changes one and not the
// other would point its own users at this repository's downloads.
if (root.repository?.url !== desktop.repository?.url) {
  throw new Error(`root repository ${root.repository?.url} != desktop repository ${desktop.repository?.url}`);
}
if (!/^git\+https:\/\/github\.com\/[^/]+\/[^/]+\.git$/u.test(desktop.repository?.url ?? "")) {
  throw new Error(`desktop repository url is not a GitHub URL the update check can read: ${desktop.repository?.url}`);
}

// Any other version literal in the shipped sources is a copy that will drift.
// The MCP bridge carried one for a whole release before anyone noticed.
const sources = ["../desktop/mcp-server.cjs", "../desktop/main.cjs", "../desktop/local-api.cjs"];
for (const file of sources) {
  const text = await readFile(new URL(file, import.meta.url), "utf8");
  const literals = [...text.matchAll(/version:\s*"(\d+\.\d+\.\d+)"/gu)].map((match) => match[1]);
  const stale = literals.filter((literal) => literal !== root.version);
  if (stale.length > 0) {
    throw new Error(`${file} hardcodes version ${stale.join(", ")} instead of reading ${root.version}`);
  }
}

console.log(`Release metadata OK: Knowledge Card Cabinet ${root.version}`);
