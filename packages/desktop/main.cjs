const { app, BrowserWindow, Menu, Notification, clipboard, nativeTheme, safeStorage, shell } = require("electron");
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const coreEntry = path.resolve(__dirname, "../core/dist/main.js");
const uiDir = path.resolve(__dirname, "../ui/dist");

let core = null;
let win = null;
/** Core's language, from its handshake and then its stream; the shell's own words follow it. */
let locale = "en";

const WORDS = {
  en: {
    cut: "Cut",
    copy: "Copy",
    paste: "Paste",
    selectAll: "Select All",
    copyLink: "Copy Link",
    waiting: (n) => (n === 1 ? "1 conversation is waiting for you" : `${n} conversations are waiting for you`),
  },
  "zh-CN": {
    cut: "剪切",
    copy: "复制",
    paste: "粘贴",
    selectAll: "全选",
    copyLink: "复制链接",
    waiting: (n) => `${n} 个会话在等你`,
  },
};

const words = () => WORDS[locale] ?? WORDS.en;

/**
 * The key core seals provider secrets with. It lives next to the database,
 * itself encrypted by the OS: Keychain on macOS, DPAPI on Windows, a keyring on
 * Linux. Core runs as a plain node process and cannot reach any of those, which
 * is why this side holds it.
 */
function vaultKey() {
  if (!safeStorage.isEncryptionAvailable()) return { key: null, keystore: "none" };
  const keystore =
    process.platform === "darwin"
      ? "keychain"
      : process.platform === "win32"
        ? "dpapi"
        : typeof safeStorage.getSelectedStorageBackend === "function"
          ? safeStorage.getSelectedStorageBackend()
          : "unknown";
  const dir = process.env.ROSTER_DATA_DIR ?? path.join(os.homedir(), ".roster");
  const file = path.join(dir, "secret.key");
  try {
    if (fs.existsSync(file)) return { key: safeStorage.decryptString(fs.readFileSync(file)), keystore };
    fs.mkdirSync(dir, { recursive: true });
    const key = crypto.randomBytes(32).toString("base64");
    fs.writeFileSync(file, safeStorage.encryptString(key), { mode: 0o600 });
    return { key, keystore };
  } catch {
    // a key file this keychain cannot open (another user, a copied data dir) is left alone; keys saved under it stay unreadable until re-entered
    return { key: null, keystore: "unreadable" };
  }
}

/**
 * The shell owns no business logic. It starts core, waits for the handshake, and
 * points a window at the URL core serves -- the same bytes a plain browser gets.
 */
function startCore() {
  // before spawning: a keychain prompt can outlast the time core waits for the key
  const secrets = vaultKey();
  return new Promise((resolve, reject) => {
    core = spawn(process.execPath, [coreEntry], {
      // started from the dock, core has no LANG and its Intl says en-US whatever the system is set to
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", ROSTER_UI_DIR: uiDir, ROSTER_SYSTEM_LOCALES: app.getPreferredSystemLanguages().join(",") },
      stdio: ["pipe", "pipe", "pipe"],
    });
    // over stdin, not the environment: every agent process core starts inherits its environment
    core.stdin.end(`${JSON.stringify({ roster: "secrets", ...secrets })}\n`);
    let buf = "";
    core.stdout.on("data", (d) => {
      buf += d.toString();
      for (const line of buf.split("\n")) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.roster === "ready") {
            if (msg.locale) locale = msg.locale;
            return resolve(msg.url);
          }
        } catch {
          /* core also logs plain text */
        }
      }
    });
    core.stderr.on("data", (d) => process.stderr.write(`[core] ${d}`));
    core.on("exit", (code) => {
      if (!win) reject(new Error(`core exited with ${code}`));
    });
    setTimeout(() => reject(new Error("core did not report ready in 20s")), 20_000);
  });
}

app.whenReady().then(async () => {
  const url = await startCore();
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    // "hidden" would also drop the frame and its controls on Windows and Linux; this one is macOS-only
    titleBarStyle: "hiddenInset",
    // the top-left of the close light. The three lights are 14pt with 9pt gaps on macOS 26+, so the row is 60pt wide:
    // x centres it on the UI's 72px rail. y is AppKit's own inset for a sidebar window (Finder, Notes: 19pt down,
    // level with the toolbar's centre), so the row sits where the eye expects from every other window: above the
    // panel headers' text line rather than on it, and not jammed into the corner either
    trafficLightPosition: { x: 6, y: 19 },
    // the UI's chrome colour; a hardcoded light one flashes white before the dark UI paints
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#0a0b0d" : "#eef0f4",
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  // a link out of the app belongs in the user's browser, not in a bare Electron window
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:\/\//.test(target)) void shell.openExternal(target);
    return { action: "deny" };
  });
  // a right click that does nothing at all is the giveaway that this is a web page
  win.webContents.on("context-menu", (_e, params) => {
    const w = words();
    const items = params.isEditable
      ? [
          { role: "cut", label: w.cut, enabled: params.editFlags.canCut },
          { role: "copy", label: w.copy, enabled: params.editFlags.canCopy },
          { role: "paste", label: w.paste, enabled: params.editFlags.canPaste },
          { type: "separator" },
          { role: "selectAll", label: w.selectAll },
        ]
      : params.selectionText
        ? [{ role: "copy", label: w.copy }]
        : [];
    if (params.linkURL) {
      if (items.length > 0) items.push({ type: "separator" });
      items.push({ label: w.copyLink, click: () => clipboard.writeText(params.linkURL) });
    }
    if (items.length > 0) Menu.buildFromTemplate(items).popup({ window: win });
  });
  await win.loadURL(url);

  // desktop capability lives here and nowhere else: main subscribes to the same
  // SSE stream over plain HTTP, so the renderer needs no privileged bridge
  watchAttention(url);
});

function watchAttention(url) {
  const http = require("node:http");
  // a group pushes the list on every turn; only a newly waiting conversation is news
  let lastWaiting = 0;
  const req = http.get(new URL("/api/stream", url), (res) => {
    res.setEncoding("utf8");
    res.on("data", (chunk) => {
      for (const line of chunk.split("\n")) {
        if (!line.startsWith("data: ")) continue;
        try {
          const msg = JSON.parse(line.slice(6));
          if (msg.kind === "preferences" && msg.locale?.resolved) locale = msg.locale.resolved;
          if (msg.kind !== "conversations") continue;
          const waiting = msg.conversations.filter((c) => c.attention !== "none").length;
          if (process.platform === "darwin") app.dock.setBadge(waiting ? String(waiting) : "");
          if (waiting > lastWaiting && Notification.isSupported()) {
            new Notification({ title: "Roster", body: words().waiting(waiting) }).show();
          }
          lastWaiting = waiting;
        } catch {
          /* ignore keepalives */
        }
      }
    });
  });
  req.on("error", () => {});
}

/** A little past core's own shutdown deadline, so this only fires when core cannot run its timers at all. */
const CORE_STOP_MS = 7000;
let stopping = false;

app.on("window-all-closed", () => app.quit());
// the app outlives core, never the reverse: a core left behind keeps the database open with nothing to stop it
app.on("before-quit", (event) => {
  if (!core || core.exitCode !== null || core.signalCode !== null) return;
  event.preventDefault();
  if (stopping) return;
  stopping = true;
  const force = setTimeout(() => core.kill("SIGKILL"), CORE_STOP_MS);
  core.once("exit", () => {
    clearTimeout(force);
    app.quit();
  });
  core.kill("SIGTERM");
});
