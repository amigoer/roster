/** Cuts the app's icons from their drawings: the Dock icon, the window icon, and the menu bar item's. */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
/** The mark itself, where the UI already serves it as the favicon: one drawing, not a copy per package. */
const mark = join(root, "packages/ui/public/icon.svg");
/** The same mark cut for a template image: black where it paints, clear where the bar shows through. */
const template = join(root, "packages/desktop/assets/tray.svg");
const assets = join(root, "packages/desktop/assets");

if (process.platform !== "darwin") {
  // sips renders the SVG and iconutil packs the .icns; the results are committed, so nobody else has to run this
  console.error("[icons] needs macOS");
  process.exit(1);
}

/** Renders an SVG square at one size; sips is macOS's own renderer, so it draws what the app will. */
const png = (svg, size, out) =>
  execFileSync("sips", ["-s", "format", "png", "-z", String(size), String(size), svg, "--out", out], { stdio: ["ignore", "ignore", "pipe"] });

// Windows and Linux take the plain image and size it themselves
png(mark, 1024, join(assets, "icon.png"));

// the Dock, the Finder and the app switcher read the .icns, which holds every size drawn on its own
const work = mkdtempSync(join(tmpdir(), "roster-icons-"));
const iconset = join(work, "icon.iconset");
mkdirSync(iconset);
for (const size of [16, 32, 128, 256, 512]) {
  png(mark, size, join(iconset, `icon_${size}x${size}.png`));
  png(mark, size * 2, join(iconset, `icon_${size}x${size}@2x.png`));
}
execFileSync("iconutil", ["-c", "icns", iconset, "-o", join(assets, "icon.icns")]);
rmSync(work, { recursive: true, force: true });

// 18pt is what the menu bar gives an item; the @2x name is how nativeImage finds the Retina one
png(template, 18, join(assets, "trayTemplate.png"));
png(template, 36, join(assets, "trayTemplate@2x.png"));

console.log(`[icons] wrote icon.png, icon.icns and trayTemplate.png to ${assets}`);
