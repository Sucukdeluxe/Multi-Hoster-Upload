const path = require("path");
const fs = require("fs");

module.exports = async function afterPack(context) {
  const rcedit = require("rcedit");

  const productFilename = context.packager?.appInfo?.productFilename;
  const version = context.packager?.appInfo?.version;
  if (!productFilename || !version) {
    throw new Error("Application metadata is unavailable");
  }

  const exePath = path.join(context.appOutDir, `${productFilename}.exe`);
  const iconPath = path.resolve(__dirname, "..", "assets", "app_icon.ico");

  if (!fs.existsSync(iconPath)) {
    throw new Error("Application icon is unavailable");
  }
  console.log(`  rcedit: branding executable -> ${exePath}`);
  await rcedit(exePath, {
    icon: iconPath,
    "file-version": version,
    "product-version": version,
    "version-string": {
      CompanyName: "Sucukdeluxe",
      FileDescription: "Multi Hoster Uploader",
      InternalName: productFilename,
      OriginalFilename: `${productFilename}.exe`,
      ProductName: "Multi Hoster Uploader"
    }
  });
};
