import { readFile } from "node:fs/promises";

const root = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const desktop = JSON.parse(await readFile(new URL("../desktop/package.json", import.meta.url), "utf8"));
if (root.version !== desktop.version) {
  throw new Error(`root package version ${root.version} != desktop package version ${desktop.version}`);
}
if (root.version === "0.0.0" || !/^\d+\.\d+\.\d+$/u.test(root.version)) {
  throw new Error(`invalid release version: ${root.version}`);
}
console.log(`Release metadata OK: Knowledge Card Cabinet ${root.version}`);
