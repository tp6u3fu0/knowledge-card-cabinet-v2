const { createPackage, extractAll, uncache } = require("@electron/asar");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

function packagedResourcesDirectory(context) {
  if (context.electronPlatformName === "darwin") {
    return path.join(
      context.appOutDir,
      `${context.packager.appInfo.productFilename}.app`,
      "Contents",
      "Resources",
    );
  }
  return path.join(context.appOutDir, "resources");
}

module.exports = async function repairApplicationManifest(context) {
  const asarPath = path.join(packagedResourcesDirectory(context), "app.asar");
  const sourcePackagePath = path.join(context.packager.info.appDir, "package.json");
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "kcc-app-"));

  try {
    await extractAll(asarPath, temporaryDirectory);
    await fs.copyFile(sourcePackagePath, path.join(temporaryDirectory, "package.json"));
    await fs.rm(asarPath, { force: true });
    // @electron/asar 3.x returns a Promise; treating it as a stream leaves a
    // packaged app without app.asar on current Electron Builder releases.
    await createPackage(temporaryDirectory, asarPath);
    uncache(asarPath);
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
};
