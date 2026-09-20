const { app, BrowserWindow, Menu, Notification, Tray, clipboard, dialog, ipcMain, nativeImage, nativeTheme, safeStorage, shell } = require("electron");
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// packaged, the three of them sit in Contents/Resources, outside the asar: core spawns as a
// real process, the UI is served off disk, and the icons are read by the system, not by Electron
const res = process.resourcesPath;
const packaged = app.isPackaged;
const coreEntry = packaged ? path.join(res, "core/dist/main.js") : path.resolve(__dirname, "../core/dist/main.js");
const uiDir = packaged ? path.join(res, "ui") : path.resolve(__dirname, "../ui/dist");
const assets = packaged ? path.join(res, "assets") : path.join(__dirname, "assets");

let core = null;
let win = null;
/** The menu bar item; it has to be held here or the garbage collector takes it off the bar. */
let tray = null;
/** Core's language, from its handshake and then its stream; the shell's own words follow it. */
let locale = "en";
/** The conversation the window is showing, as the page reports it. */
let shown = null;
/** The notification each conversation has up: a newer one replaces it, and a settled one is taken down. */
const posted = new Map();

const WORDS = {
  en: {
    cut: "Cut",
    copy: "Copy",
    paste: "Paste",
    selectAll: "Select All",
    copyLink: "Copy Link",
    open: "Open Roster",
    quit: "Quit Roster",
  },
  "zh-CN": {
    cut: "剪切",
    copy: "复制",
    paste: "粘贴",
    selectAll: "全选",
    copyLink: "复制链接",
    open: "打开 Roster",
    quit: "退出 Roster",
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
      // core has no working directory of its own; wherever the app was launched from must not become one
      cwd: os.homedir(),
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
    // Windows and Linux take the icon from the window; macOS reads it off the bundle instead
    icon: path.join(assets, "icon.png"),
    // "hidden" would also drop the frame and its controls on Windows and Linux; this one is macOS-only
    titleBarStyle: "hiddenInset",
    // the top-left of the close light. The three lights are 14pt with 9pt gaps on macOS 26+, so the row is 60pt wide:
    // x centres it on the UI's 72px rail. y is AppKit's own inset for a sidebar window (Finder, Notes: 19pt down,
    // level with the toolbar's centre), so the row sits where the eye expects from every other window: above the
    // panel headers' text line rather than on it, and not jammed into the corner either
    trafficLightPosition: { x: 6, y: 19 },
    // the UI's chrome colour; a hardcoded light one flashes white before the dark UI paints
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#0a0b0d" : "#eef0f4",
    // shown once the page has painted in the theme it picked, so no frame of the wrong one comes first
    show: false,
    webPreferences: { preload: path.join(__dirname, "preload.cjs"), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  win.once("ready-to-show", () => win.show());
  // the page's only way to a native folder chooser and to Finder; both take a path, neither returns anything else
  ipcMain.handle("roster:pickDirectory", async (_e, defaultPath) => {
    const r = await dialog.showOpenDialog(win, {
      properties: ["openDirectory", "createDirectory"],
      ...(typeof defaultPath === "string" && defaultPath ? { defaultPath } : {}),
    });
    return r.canceled ? null : (r.filePaths[0] ?? null);
  });
  ipcMain.handle("roster:revealDirectory", async (_e, dir) => {
    if (typeof dir !== "string" || !path.isAbsolute(dir)) return false;
    return (await shell.openPath(dir)) === "";
  });
  // the one thing the shell cannot see for itself: which conversation is on screen
  ipcMain.on("roster:showing", (_e, id) => {
    shown = typeof id === "string" ? id : null;
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
  // the theme is the page's to pick; the colour behind it, seen while resizing, follows
  const dark = await win.webContents.executeJavaScript('document.documentElement.classList.contains("dark")', true).catch(() => null);
  if (dark !== null) win.setBackgroundColor(dark ? "#0a0b0d" : "#eef0f4");

  menuBar();

  // desktop capability lives here and nowhere else: main subscribes to the same
  // SSE stream over plain HTTP, so the page keeps no privileged channel of its
  // own -- it only says what is on screen, and takes the conversation a click lands on
  watchCore(url);
});

/**
 * Roster's row in the menu bar: how many conversations are waiting, and a way
 * back to the window from whatever is covering it. On macOS the icon is a
 * template image -- black where it paints -- and the system tints it for a light
 * or dark bar itself; a Windows or Linux tray tints nothing, so it takes the
 * mark in its own colours.
 */
function menuBar() {
  const icon =
    process.platform === "darwin"
      ? path.join(assets, "trayTemplate.png")
      : nativeImage.createFromPath(path.join(assets, "icon.png")).resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  tray.setToolTip("Roster");
  tray.on("click", bringForward);
  // built as it opens, so it is in whatever language core last reported
  tray.on("right-click", () => {
    const w = words();
    tray.popUpContextMenu(
      Menu.buildFromTemplate([
        { label: w.open, click: bringForward },
        { type: "separator" },
        { label: w.quit, click: () => app.quit() },
      ]),
    );
  });
}

/** How long a dropped stream waits before dialling core again. */
const STREAM_RETRY_MS = 1000;

/**
 * Core decides what is worth interrupting someone for and writes the words; the
 * shell only shows them natively, and knows the two things core cannot see --
 * whether the window has focus and what is on screen.
 */
function watchCore(url) {
  const http = require("node:http");
  let retry = null;
  const again = () => {
    if (stopping || retry) return;
    retry = setTimeout(() => {
      retry = null;
      watchCore(url);
    }, STREAM_RETRY_MS);
  };
  const req = http.get(new URL("/api/stream", url), (res) => {
    res.setEncoding("utf8");
    let buf = "";
    res.on("data", (chunk) => {
      // a frame can be split across chunks; what follows the last newline is the start of the next one
      buf += chunk;
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        // core also writes comments, which is what its keepalives are
        if (!line.startsWith("data: ")) continue;
        let msg;
        try {
          msg = JSON.parse(line.slice(6));
        } catch {
          continue;
        }
        if (msg.kind === "preferences" && msg.locale?.resolved) locale = msg.locale.resolved;
        else if (msg.kind === "notify") post(msg.notification);
        else if (msg.kind === "conversations") {
          const waiting = msg.conversations.filter((c) => c.attention !== "none");
          const count = waiting.length ? String(waiting.length) : "";
          if (process.platform === "darwin") app.dock.setBadge(count);
          // the same number beside the menu bar icon, for a window that is not on this desktop
          tray?.setTitle(count);
          settled(new Set(waiting.map((c) => c.id)));
        }
      }
    });
    res.on("end", again);
  });
  req.on("error", again);
}

function post(n) {
  if (!n || !Notification.isSupported()) return;
  // nobody needs to be told what is already on their screen
  if (shown === n.conversationId && win?.isFocused()) return;
  posted.get(n.conversationId)?.close();
  const note = new Notification({ title: n.title, body: n.body });
  note.on("click", () => openConversation(n.conversationId));
  // the system turning one down is silent otherwise, and looks exactly like core never sending it
  note.on("failed", (_e, error) => console.error(`[roster] the system turned a notification down: ${error}`));
  note.on("close", () => {
    if (posted.get(n.conversationId) === note) posted.delete(n.conversationId);
  });
  posted.set(n.conversationId, note);
  note.show();
}

/** Out from under whatever is over it, minimized or not: what a notification and the menu bar item both want. */
function bringForward() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  app.focus({ steal: true });
}

/** A notification is a way into the conversation: clicking one brings the window forward on it. */
function openConversation(conversationId) {
  if (!win) return;
  bringForward();
  win.webContents.send("roster:open", conversationId);
}

/** Read, decided or deleted: a conversation that no longer waits takes its notification down with it. */
function settled(waiting) {
  for (const [id, note] of posted) {
    if (waiting.has(id)) continue;
    note.close();
    posted.delete(id);
  }
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
