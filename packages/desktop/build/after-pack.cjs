/**
 * An ad-hoc signature, because there is no Developer ID yet: an Apple silicon Mac
 * refuses to run a bundle carrying none at all, and electron-builder was told to
 * sign nothing (mac.identity). The app still arrives quarantined from a download,
 * which the release notes say how to clear.
 */
const { execFileSync } = require("node:child_process");
const path = require("node:path");

exports.default = async (context) => {
  if (context.electronPlatformName !== "darwin") return;
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", app], { stdio: ["ignore", "ignore", "pipe"] });
  console.log(`  • ad-hoc signed ${app}`);
};
