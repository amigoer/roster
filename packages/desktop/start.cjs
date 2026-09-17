/**
 * Runs Roster, on macOS as Roster.
 *
 * macOS reads a notification's name, icon and permission off the bundle it came
 * from, and the Electron npm ships is a bundle called "Electron" whose signature
 * is linker-signed with nothing sealed. So from source every notification would
 * say "Electron" -- and before the bundle is properly signed the system refuses
 * them outright, without even offering to ask. A clone of that bundle under
 * Roster's own name and identifier settles both, and costs no disk: APFS clones
 * the files rather than copying them. A packaged Roster carries a real signature
 * and needs none of this.
 */
const { execFileSync, spawn } = require("node:child_process");
const { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const path = require("node:path");

/** What a person sees the app called: in the menu bar, and as the sender of every notification. */
const NAME = "Roster";
/**
 * Its identity to the system. Notification permission is remembered against this
 * and asked about exactly once, so changing it costs everyone one more prompt.
 */
const ID = "io.github.amigoer.roster";

const LSREGISTER =
  "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";

// require("electron") is the path to the executable inside the bundle it ships
const shipped = require("electron");
const source = path.resolve(shipped, "../../..");
const version = JSON.parse(readFileSync(path.join(source, "../../package.json"), "utf8")).version;

const dir = path.join(__dirname, ".mac");
const bundle = path.join(dir, `${NAME}.app`);
const stamp = path.join(dir, "built");
/** What the bundle was made from and as; anything else means making it again. */
const want = `${version} ${NAME} ${ID}\n`;

/** True once the bundle stands under Roster's name; false leaves the shipped Electron to run as itself. */
function build() {
  try {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    // -c clones rather than copies; a filesystem that cannot has to spend the 300MB
    try {
      execFileSync("cp", ["-Rc", source, bundle]);
    } catch {
      execFileSync("cp", ["-R", source, bundle]);
    }
    execFileSync("/usr/libexec/PlistBuddy", [
      "-c", `Set :CFBundleName ${NAME}`,
      "-c", `Set :CFBundleDisplayName ${NAME}`,
      "-c", `Set :CFBundleIdentifier ${ID}`,
      path.join(bundle, "Contents/Info.plist"),
    ]);
    // the signature has to seal the name it was given, or the system takes nothing from it
    execFileSync("codesign", ["--force", "--deep", "--sign", "-", bundle], { stdio: ["ignore", "ignore", "pipe"] });
    // and the system has to know the bundle before the app asks it for anything
    execFileSync(LSREGISTER, ["-f", bundle]);
    writeFileSync(stamp, want);
    console.log(`[roster] built ${bundle}`);
    return true;
  } catch (err) {
    // it still runs; what is lost is the name on its notifications, and whether they are allowed at all
    console.error(`[roster] couldn't build ${bundle}: ${String(err.stderr ?? err.message).trim()}`);
    return false;
  }
}

const ready = process.platform === "darwin" && (existsSync(stamp) && readFileSync(stamp, "utf8") === want ? existsSync(bundle) : build());
const child = spawn(ready ? path.join(bundle, "Contents/MacOS/Electron") : shipped, [__dirname, ...process.argv.slice(2)], {
  stdio: "inherit",
});
child.on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 0)));
