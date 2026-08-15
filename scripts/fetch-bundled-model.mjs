// Downloads the embedding model that ships inside the installer.
//
// A fresh install used to have no semantic embedding at all: the built-in
// Hash 384 is a lexical stand-in, not a language model, so search and the
// relation graph were only word overlap until someone found the settings page
// and waited for a download. Bundling one real model means the app is useful
// the moment it opens, offline, with no first-run download.
//
//   node scripts/fetch-bundled-model.mjs
//
// Skipped silently if the files are already present, so repeat builds are free.
// If it is never run, the app falls back to exactly the old behaviour — the
// bundle is an optimisation, not a requirement.

import { mkdir, stat, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

/**
 * 384 dimensions and ~135 MB. The 1024-dim BGE-M3 is the better model, but at
 * 570 MB it belongs behind a deliberate download rather than inside every
 * installer — see DIMENSION_GUIDE in desktop/model-runtime.cjs.
 */
const MODEL_ID = "Xenova/paraphrase-multilingual-MiniLM-L12-v2";
const FILES = [
  "config.json",
  "tokenizer.json",
  "tokenizer_config.json",
  "special_tokens_map.json",
  "onnx/model_quantized.onnx",
];

const target = new URL(`../build/models/${MODEL_ID}/`, import.meta.url);

async function alreadyThere(path) {
  try {
    const info = await stat(path);
    return info.size > 0;
  } catch {
    return false;
  }
}

let downloaded = 0;
for (const file of FILES) {
  const destination = new URL(file, target);
  await mkdir(new URL(".", destination), { recursive: true });
  if (await alreadyThere(destination)) {
    console.log(`have  ${file}`);
    continue;
  }

  const response = await fetch(`https://huggingface.co/${MODEL_ID}/resolve/main/${file}`);
  if (!response.ok) throw new Error(`${file} → HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  await writeFile(destination, bytes);
  downloaded += bytes.length;
  console.log(`saved ${file} (${(bytes.length / 1024 / 1024).toFixed(1)} MB)`);
}

console.log(
  downloaded
    ? `bundled model ready at ${fileURLToPath(target)} (+${(downloaded / 1024 / 1024).toFixed(1)} MB)`
    : `bundled model already present at ${fileURLToPath(target)}`,
);
