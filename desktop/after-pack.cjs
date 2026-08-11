const { createPackage, extractAll, uncache } = require("@electron/asar");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

module.exports = async function repairApplicationManifest(context) {
  const asarPath = path.join(context.appOutDir, "resources", "app.asar");
  const sourcePackagePath = path.join(context.packager.info.appDir, "package.json");
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "kcc-app-"));

  try {
    await extractAll(asarPath, temporaryDirectory);
    await fs.copyFile(sourcePackagePath, path.join(temporaryDirectory, "package.json"));
    await fs.rm(asarPath, { force: true });
    const archiveStream = await createPackage(temporaryDirectory, asarPath);
    await new Promise((resolve, reject) => {
      archiveStream.once("close", resolve);
      archiveStream.once("error", reject);
    });
    uncache(asarPath);
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
};
