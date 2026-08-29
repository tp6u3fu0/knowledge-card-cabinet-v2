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
 * 768 dimensions and ~320 MB: EmbeddingGemma at q8.
 *
 * Chosen by the retrieval benchmark, not by reputation — the full table is in
 * CLAUDE.md §3.23, measured against the MiniLM that used to ship here, a much
 * cheaper Chinese model, and the much larger BGE-M3:
 *
 *   Recall@3          MiniLM 78.1   BGE-Small-ZH 89.5   Gemma 98.2   BGE-M3 93.0
 *   forgotten-name    MiniLM 50.0   BGE-Small-ZH 81.3   Gemma 93.8   BGE-M3 81.3
 *   natural-recall    MiniLM 35.7   BGE-Small-ZH 85.7   Gemma 92.9   BGE-M3 71.4
 *
 * All four find an exactly-typed title. They separate on the two intents this
 * product exists for, which is where the extra megabytes go. Note that BGE-M3
 * is 244 MB larger and loses on every quality metric: bigger is not the same
 * question. Re-run `npm run benchmark:retrieval -- --model <id>` before
 * changing this line, and put the before/after numbers in the commit.
 *
 * Note the paired files. This export keeps its weights in a `.onnx_data`
 * sidecar, so fetching only the `.onnx` produces a directory that looks
 * complete and fails to load.
 */
const MODEL_ID = "onnx-community/embeddinggemma-300m-ONNX";
const FILES = [
  "config.json",
  "tokenizer.json",
  "tokenizer_config.json",
  "special_tokens_map.json",
  "added_tokens.json",
  "onnx/model_quantized.onnx",
  "onnx/model_quantized.onnx_data",
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
