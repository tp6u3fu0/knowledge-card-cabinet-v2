// The packaging exclusions in desktop/electron-builder.yml drop onnxruntime-web
// and the transformers browser half wholesale and add their Node entries back
// by name. That is safe exactly as long as the names still match what the
// packages resolve to in Node — and if they stop matching, the app breaks only
// once packaged, where nothing else looks.
//
// This needs desktop/node_modules, so it runs after `npm run desktop:prepare`
// rather than in the ordinary test suite (see the release workflow).
import { readdir, readFile } from "node:fs/promises";

const configUrl = new URL("../desktop/electron-builder.yml", import.meta.url);

/** Conditions live under "." in some packages and at the root in others. */
function conditionsOf(manifest) {
  return manifest.exports?.["."] ?? manifest.exports ?? {};
}

/**
 * The packaged application, looked at rather than assumed.
 *
 * The 1.0.0 Windows installer went out 337 MB heavier than the same build made
 * by hand, because `npm install --prefix desktop` on the runner left a link to
 * the repo root in desktop/node_modules and the packer followed it — into
 * release/, where the half-built application was. Nothing in the build failed;
 * the installer simply carried a second copy of Electron.
 */
async function inspectPackagedApp() {
  const problems = [];
  const releaseDir = new URL("../release/", import.meta.url);
  let entries = [];
  try {
    entries = await readdir(releaseDir, { withFileTypes: true });
  } catch {
    return problems; // Nothing packaged in this working copy.
  }

  for (const entry of entries.filter((item) => item.isDirectory() && /unpacked|mac/u.test(item.name))) {
    const appDir = new URL(`${entry.name}/`, releaseDir);
    const found = [];
    const walk = async (dir, depth = 0) => {
      if (depth > 8 || found.length > 0) return;
      let children = [];
      try {
        children = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const child of children) {
        if (!child.isDirectory()) continue;
        if (child.name === "knowledge-card-cabinet" || child.name === "release" || child.name === "dist-site") {
          found.push(`${entry.name}: contains ${child.name}/ — the project packed inside its own package`);
          return;
        }
        await walk(new URL(`${child.name}/`, dir), depth + 1);
      }
    };
    await walk(appDir);
    problems.push(...found);
  }
  return problems;
}

export async function checkPackaging() {
  const config = await readFile(configUrl, "utf8");
  const problems = [];

  const ortWeb = JSON.parse(await readFile(new URL("../desktop/node_modules/onnxruntime-web/package.json", import.meta.url), "utf8"));
  const nodeEntries = Object.values(conditionsOf(ortWeb).node ?? {}).map((entry) => entry.replace(/^\.\//u, ""));
  if (nodeEntries.length === 0) problems.push("onnxruntime-web no longer declares a node export");
  for (const entry of nodeEntries) {
    if (!config.includes(`- "node_modules/onnxruntime-web/${entry}"`)) {
      problems.push(`onnxruntime-web resolves to ${entry} in Node, and the package excludes it`);
    }
  }

  const transformers = JSON.parse(await readFile(new URL("../desktop/node_modules/@huggingface/transformers/package.json", import.meta.url), "utf8"));
  const resolved = Object.values(conditionsOf(transformers).node ?? {}).map((entry) => entry?.default ?? entry);
  if (resolved.length === 0) problems.push("@huggingface/transformers no longer declares a node export");
  for (const entry of resolved) {
    const relative = String(entry).replace(/^\.\//u, "");
    if (!relative.includes("transformers.node.")) {
      problems.push(`transformers now resolves to ${relative} in Node, which the exclusions were not written for`);
    }
    if (config.includes(`!node_modules/@huggingface/transformers/${relative}`)) {
      problems.push(`the package excludes ${relative}, which is what Node loads`);
    }
  }

  problems.push(...await inspectPackagedApp());

  if (problems.length > 0) {
    throw new Error(`packaging exclusions no longer match the installed packages:\n- ${problems.join("\n- ")}`);
  }
  return { onnxruntimeWeb: nodeEntries, transformers: resolved };
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("check-packaging.mjs")) {
  const kept = await checkPackaging();
  console.log(`Packaging exclusions OK: keeping ${kept.onnxruntimeWeb.join(", ")} and ${kept.transformers.join(", ")}`);
}
