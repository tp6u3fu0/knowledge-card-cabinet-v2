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
 * It costs the installer about 180 MB more than the 384-dim MiniLM that used to
 * ship here, and it is worth it — the whole point of a bundled model is that a
 * fresh cabinet has real semantics on day one, and MiniLM's day-one semantics
 * were the weakest of anything in the catalogue. Measured on this project's own
 * runtime: "汽車" and "轎車" score 0.96 despite sharing no character, which is
 * the case that separates a language model from word overlap.
 *
 * 570 MB BGE-M3 remains behind a deliberate download; 320 MB is the line.
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
