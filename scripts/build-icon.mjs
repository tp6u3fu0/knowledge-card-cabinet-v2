// Renders public/app-icon.svg into the multi-size Windows icon that
// electron-builder stamps onto the installer, the .exe and the shortcuts.
//
// The result (build/icon.ico) is committed, so a normal `npm run desktop:dist`
// never has to run this. Re-run it only when the source mark changes:
//
//   node scripts/build-icon.mjs
//
// sharp is resolved from desktop/node_modules because it already ships there as
// a transformers.js dependency — the icon is not worth a root-level dependency.

import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const projectRoot = new URL("../", import.meta.url);
const require = createRequire(new URL("../desktop/package.json", import.meta.url));
const sharp = require("sharp");

// 256 must be present: electron-builder rejects icons without it.
const SIZES = [16, 24, 32, 48, 64, 128, 256];

function icoFrom(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // 1 = icon
  header.writeUInt16LE(images.length, 4);

  const directory = Buffer.alloc(images.length * 16);
  let offset = header.length + directory.length;

  images.forEach(({ size, data }, index) => {
    const entry = index * 16;
    directory.writeUInt8(size === 256 ? 0 : size, entry); // 0 means 256
    directory.writeUInt8(size === 256 ? 0 : size, entry + 1);
    directory.writeUInt8(0, entry + 2); // palette size
    directory.writeUInt8(0, entry + 3); // reserved
    directory.writeUInt16LE(1, entry + 4); // colour planes
    directory.writeUInt16LE(32, entry + 6); // bits per pixel
    directory.writeUInt32LE(data.length, entry + 8);
    directory.writeUInt32LE(offset, entry + 12);
    offset += data.length;
  });

  return Buffer.concat([header, directory, ...images.map((image) => image.data)]);
}

const source = await readFile(new URL("public/app-icon.svg", projectRoot));
const images = await Promise.all(
  SIZES.map(async (size) => ({
    size,
    // density scales the SVG rasterisation; the source is drawn at 512px.
    data: await sharp(source, { density: (72 * size) / 512 })
      .resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png({ compressionLevel: 9 })
      .toBuffer(),
  })),
);

const outputDir = new URL("build/", projectRoot);
await mkdir(outputDir, { recursive: true });
const target = new URL("icon.ico", outputDir);
await writeFile(target, icoFrom(images));

// A 512px PNG for the Linux/headless side and for README or store listings.
await writeFile(
  new URL("icon.png", outputDir),
  await sharp(source, { density: 72 }).resize(512, 512).png({ compressionLevel: 9 }).toBuffer(),
);

console.log(`wrote ${fileURLToPath(target)} (${SIZES.join(", ")})`);
