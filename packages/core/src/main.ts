import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { aboutReader } from "./about.js";
import { Agents } from "./agents.js";
import { AttachmentStore } from "./attachments.js";
import { CATALOG } from "./catalog.js";
import { openDb } from "./db/index.js";
import { Detector } from "./detect.js";
import { ensureExecutors, ExecutorSettings } from "./executors.js";
import { Extensions, type ExtensionRoot } from "./extensions.js";
import { Installer } from "./installer.js";
import { LOGO_IDS } from "./logos.js";
import { Orchestrator } from "./orchestrator.js";
import { Registry } from "./registry.js";
import { scriptedFactory } from "./scripted.js";
import { NO_VAULT, Secrets, type Vault } from "./secrets.js";
import { startServer } from "./server.js";
import { setShellEnv, Sources } from "./sources.js";
import { Store } from "./store.js";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * The desktop shell sends the key provider secrets are sealed with as one line
 * on stdin, never through the environment: every agent process Roster starts
 * inherits the environment. Run on its own there is no line, and keys are kept
 * unsealed.
 */
function readVault(): Promise<Vault> {
  if (process.stdin.isTTY) return Promise.resolve(NO_VAULT);
  return new Promise((resolve) => {
    let buf = "";
    let settled = false;
    const done = (vault: Vault) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.stdin.removeAllListeners();
      process.stdin.destroy();
      resolve(vault);
    };
    // a pipe nobody writes to must not hold startup
    const timer = setTimeout(() => done(NO_VAULT), 2000);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      buf += chunk;
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      try {
        const msg = JSON.parse(buf.slice(0, nl)) as { roster?: string; key?: string | null; keystore?: string };
        const key = msg.roster === "secrets" && typeof msg.key === "string" ? Buffer.from(msg.key, "base64") : null;
        done(key?.length === 32 ? { key, keystore: msg.keystore ?? "unknown" } : { key: null, keystore: msg.keystore ?? "none" });
      } catch {
        done(NO_VAULT);
      }
    });
    process.stdin.on("end", () => done(NO_VAULT));
    process.stdin.on("error", () => done(NO_VAULT));
  });
}

const vault = await readVault();

const dataDir = process.env["ROSTER_DATA_DIR"] ?? join(homedir(), ".roster");
mkdirSync(dataDir, { recursive: true });

const uiDir = process.env["ROSTER_UI_DIR"]
  ? resolve(process.env["ROSTER_UI_DIR"])
  : resolve(here, "../../ui/dist");

const scripted = process.env["ROSTER_SCRIPTED"] === "1";

const checkout = existsSync(resolve(here, "../../ext-claude-code/package.json"));

// adapters ship with Roster: the monorepo's packages when run from a checkout, a directory beside core when packaged
const bundledDir = process.env["ROSTER_BUNDLED_EXTENSIONS"] ?? (checkout ? resolve(here, "../..") : resolve(here, "../extensions"));
const extensionsDir = join(dataDir, "extensions");
const roots: ExtensionRoot[] = [
  { dir: bundledDir, origin: "bundled" },
  // anything linked in for development
  ...(process.env["ROSTER_EXTENSIONS"] ?? "")
    .split(delimiter)
    .filter(Boolean)
    .map((dir): ExtensionRoot => ({ dir: resolve(dir), origin: "linked" })),
  // adapters Roster fetched itself
  { dir: extensionsDir, origin: "installed" },
];
const extensions = new Extensions(roots);
if (!scripted) {
  for (const e of await extensions.load()) {
    console.log(e.error ? `[roster] extension ${e.name}: ${e.error}` : `[roster] extension ${e.name}@${e.version} (${e.origin}) -> ${e.type}`);
  }
}

const about = aboutReader({
  packageJson: resolve(here, "../package.json"),
  fromSource: checkout,
  // core's own build and the adapters loaded into it: rebuilding any of them only applies after a restart
  codeDirs: [here, join(here, "db"), ...extensions.list().map((e) => join(e.dir, "dist"))],
  paths: { data: dataDir, agents: join(dataDir, "agents"), attachments: join(dataDir, "attachments"), extensions: extensionsDir },
});

const db = openDb(join(dataDir, "roster.db"));
const store = new Store(db);
store.recoverAfterRestart();
const secrets = new Secrets(db, vault);
const sealed = secrets.sealPlain();
if (sealed > 0) console.log(`[roster] sealed ${sealed} keys that were stored before there was a key to seal them with`);

const listeners = new Set<(msg: unknown) => void>();
const broadcast = (msg: unknown) => {
  for (const fn of listeners) fn(msg);
};

const installer = new Installer(extensionsDir, join(dataDir, "agents"), () => broadcast({ kind: "extensions" }));
const detector = new Detector(CATALOG, installer.npmCli);
const agents = new Agents(CATALOG, extensions, detector, installer);
// before anything reads a key: endpoints may point at variables only the login shell has
setShellEnv(await detector.shellEnv());

// scripted replies instead of models: for working on the UI without credentials, spend, or extensions
if (scripted && store.listExecutors().length === 0) {
  const executor = store.createExecutor({ name: "脚本回复", type: "scripted", settings: {} });
  if (!store.hasAnyBot()) {
    store.createBot({
      name: "Pi",
      title: "通用编码助手",
      avatar: "sheep",
      system_prompt: null,
      executor_id: executor.id,
      model_source: null,
      model: null,
      permission_tier: "read",
    });
  }
}

// bots from before logos existed still wear a letter; the roster must be one family
store.assignLogos(LOGO_IDS);

const backfilled = store.backfillTitles();
if (backfilled > 0) console.log(`[roster] derived ${backfilled} conversation titles`);

const types = () => (scripted ? [] : extensions.types());
const build = () =>
  scripted
    ? new Registry(Object.fromEntries(store.listExecutors().map((e) => [e.id, scriptedFactory(e.id, 40, e.name)])))
    : Registry.from(types(), store.listExecutors(), (t) => agents.defaults(t));

let registry = build();
const sources = new Sources(store, secrets, () => registry, (t) => settings.presets(t));
const attachments = new AttachmentStore(join(dataDir, "attachments"));
const orchestrator = new Orchestrator(store, broadcast as never, registry, sources, attachments);
const changed = () => {
  // an agent made ready by detection or a download gets its executor here, so it is usable at once
  if (!scripted) ensureExecutors(store, agents.usable());
  registry = build();
  orchestrator.useRegistry(registry);
};
const settings = new ExecutorSettings(store, secrets, types, () => registry, changed);
const pushExecutors = () =>
  broadcast({ kind: "executors", executors: orchestrator.executors(), capabilities: orchestrator.capabilities() });

// Detection runs in the background; when it lands, executors get the programs it found.
void detector
  .detect()
  .then(() => {
    if (scripted) return;
    changed();
    pushExecutors();
    broadcast({ kind: "extensions" });
  })
  .catch((err: unknown) => console.error("[roster] detection failed:", err instanceof Error ? err.message : String(err)));

const handle = await startServer({
  store,
  orchestrator,
  attachments,
  settings,
  sources,
  extensions,
  installer,
  agents,
  catalog: CATALOG,
  detector,
  reload: async () => {
    if (!scripted) await extensions.load();
    changed();
  },
  uiDir,
  about,
  port: Number(process.env["ROSTER_PORT"] ?? 7788),
  broadcast,
  subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
});

// the handshake Electron reads off stdout
console.log(JSON.stringify({ roster: "ready", port: handle.port, url: `http://127.0.0.1:${handle.port}/` }));

/** Past what a backend takes to close a session that will not end on its own. */
const SHUTDOWN_GRACE_MS = 5_000;

let stopping = false;
const shutdown = async () => {
  // the desktop shell's SIGTERM and a terminal's Ctrl+C can both arrive
  if (stopping) return;
  stopping = true;
  // whatever does not settle in time must not keep this process holding the database
  setTimeout(() => {
    console.error(`[roster] shutdown did not finish in ${SHUTDOWN_GRACE_MS}ms, exiting anyway`);
    process.exit(1);
  }, SHUTDOWN_GRACE_MS).unref();
  await orchestrator.disposeAll();
  await handle.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
