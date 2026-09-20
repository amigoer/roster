/** Stages everything the packaged app carries, then hands it to electron-builder. */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const desktop = join(root, "packages/desktop");
const stage = join(desktop, ".stage");

if (process.platform !== "darwin") {
  // the only target so far; a Windows or Linux build needs its own config and a runner to match
  console.error("[package] macOS only");
  process.exit(1);
}

const run = (cmd, args, cwd = root) => execFileSync(cmd, args, { cwd, stdio: "inherit" });

/**
 * A package with its own node_modules, as a plain directory tree: --legacy is pnpm 10's
 * word for "do not inject workspace dependencies", and the hoisted linker keeps the
 * result free of the symlink farm, which is what has to survive being copied into a
 * bundle and signed. What lands there is the package's `files`, so dist comes along.
 */
const deploy = (pkg, to) => run("pnpm", ["deploy", "--legacy", "--filter", pkg, "--prod", "--config.node-linker=hoisted", to]);

rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

// core looks for its adapters in ../extensions, relative to its own dist, whenever it is
// not running from a checkout; everything below follows from that one path
deploy("@roster/core", join(stage, "core"));
const extensions = join(stage, "core/extensions");
deploy("@roster/ext-claude-code", join(extensions, "ext-claude-code"));
deploy("@roster/ext-pi-agent", join(extensions, "ext-pi-agent"));

// the ACP adapters are a manifest and nothing else; the agent programs they name are fetched later
for (const name of readdirSync(join(root, "packages"))) {
  if (!name.startsWith("ext-")) continue;
  const to = join(extensions, name);
  if (existsSync(to)) continue;
  mkdirSync(to, { recursive: true });
  cpSync(join(root, "packages", name, "package.json"), join(to, "package.json"));
}

const ui = join(root, "packages/ui/dist");
if (!existsSync(join(ui, "index.html"))) {
  console.error("[package] packages/ui/dist is missing; run pnpm build first");
  process.exit(1);
}
cpSync(ui, join(stage, "ui"), { recursive: true });

// anything after the script name goes on to electron-builder, so `--arm64` builds one arch
run("pnpm", ["exec", "electron-builder", "--mac", ...process.argv.slice(2)], desktop);
