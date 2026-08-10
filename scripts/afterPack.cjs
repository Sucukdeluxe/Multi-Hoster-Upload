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
  const version = context.packager?.appInfo?.version;
  if (!productFilename || !version) {
    console.warn("  rcedit: skipped - application metadata not available");
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
    console.log(`  rcedit: branding executable -> ${exePath}`);
    await rcedit(exePath, {
      icon: iconPath,
      "file-version": version,
      "product-version": version,
      "version-string": {
        FileDescription: "Multi Hoster Uploader",
        InternalName: productFilename,
        OriginalFilename: `${productFilename}.exe`,
        ProductName: "Multi Hoster Uploader"
      }
    });
  } catch (error) {
    console.warn(`  rcedit: failed - ${String(error)}`);
  }
};
