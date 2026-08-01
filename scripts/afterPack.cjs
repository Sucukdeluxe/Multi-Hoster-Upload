const path = require("path");

module.exports = async function afterPack(context) {
  let rcedit;
  try {
    rcedit = require("rcedit");
  } catch {
    console.warn("  rcedit: skipped - rcedit not installed");
    return;
  }

  const productFilename = context.packager?.appInfo?.productFilename;
  if (!productFilename) {
    console.warn("  rcedit: skipped - productFilename not available");
    return;
  }

  const exePath = path.join(context.appOutDir, `${productFilename}.exe`);
  const iconPath = path.resolve(__dirname, "..", "assets", "app_icon.ico");

  try {
    const fs = require("fs");
    if (!fs.existsSync(iconPath)) {
      console.warn("  rcedit: skipped - app_icon.ico not found");
      return;
    }
    console.log(`  rcedit: patching icon -> ${exePath}`);
    await rcedit(exePath, { icon: iconPath });
  } catch (error) {
    console.warn(`  rcedit: failed - ${String(error)}`);
  }
};
