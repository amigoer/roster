import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import type { About } from "./about.js";
import type { Agents } from "./agents.js";
import { MAX_BYTES, MAX_PER_MESSAGE, type AttachmentStore } from "./attachments.js";
import type { CatalogEntry } from "./catalog.js";
import type { Detector } from "./detect.js";
import { isLogo, LOGO_IDS, LOGOS, LOGOS_DIR } from "./logos.js";
import { Rejection } from "./errors.js";
import type { ExecutorSettings } from "./executors.js";
import type { Extensions } from "./extensions.js";
import type { Installer } from "./installer.js";
import type { Orchestrator } from "./orchestrator.js";
import type { Sources } from "./sources.js";
import type { BotInput, MemberSettings, Mode, Store } from "./store.js";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".webp": "image/webp",
};

const TIERS = ["read", "write", "execute"] as const;
const MODES: readonly Mode[] = ["human_led", "leader", "discussion"];

export interface ServerHandle {
  port: number;
  close(): Promise<void>;
}


const optText = (v: unknown, max: number): string | null => {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
};

/** Validates a bot body. With partial, absent fields are left out rather than defaulted. */
function botInput(
  body: Record<string, unknown>,
  partial: boolean,
  executors: readonly string[],
): Partial<BotInput> {
  const out: Partial<BotInput> = {};
  const has = (k: string) => !partial || k in body;

  if (has("name")) {
    const name = String(body["name"] ?? "").trim();
    if (!name) throw new Rejection("名字不能为空");
    // @name is how a group addresses it, so the name has to survive being typed after @
    if (/[@\s]/.test(name)) throw new Rejection("名字里不能有空格或 @");
    if ([...name].length > 24) throw new Rejection("名字最多 24 个字");
    out.name = name;
  }
  if (has("title")) out.title = optText(body["title"], 40);
  if (has("avatar")) {
    // only the bundled logos, so every bot shares one style; null asks for one to be picked
    const avatar = optText(body["avatar"], 40);
    if (avatar && !isLogo(avatar)) throw new Rejection("头像只能从内置的 logo 里选");
    out.avatar = avatar;
  }
  if (has("system_prompt")) out.system_prompt = optText(body["system_prompt"], 12_000);
  if (has("executor_id")) {
    const executor = String(body["executor_id"] ?? "");
    if (!executors.includes(executor)) throw new Rejection(`没有这个 agent：${executor || "（空）"}`);
    out.executor_id = executor;
  }
  // null is the agent's own sign-in; whether the executor offers it is checked once both are known
  if (has("model_source")) out.model_source = optText(body["model_source"], 80);
  if (has("model")) out.model = optText(body["model"], 120);
  if (has("permission_tier")) {
    const tier = String(body["permission_tier"] ?? "");
    if (!(TIERS as readonly string[]).includes(tier)) throw new Rejection("权限档只能是 read / write / execute");
    out.permission_tier = tier as BotInput["permission_tier"];
  }
  return out;
}

export function startServer(opts: {
  store: Store;
  orchestrator: Orchestrator;
  attachments: AttachmentStore;
  settings: ExecutorSettings;
  sources: Sources;
  extensions: Extensions;
  installer: Installer;
  agents: Agents;
  catalog: readonly CatalogEntry[];
  detector: Detector;
  /** re-scans extensions and rebuilds the registry, after an install or removal */
  reload(): Promise<void>;
  uiDir: string | null;
  about(): About;
  port?: number;
  broadcast(msg: unknown): void;
  subscribe(fn: (msg: unknown) => void): () => void;
}): Promise<ServerHandle> {
  const { store, orchestrator, attachments, uiDir, sources, extensions, installer, agents, catalog, detector } = opts;
  // read per request: executors can be added and removed while the server runs
  const executors = () => Object.keys(orchestrator.capabilities());

  const json = (res: ServerResponse, body: unknown, code = 200) => {
    res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body));
  };

  const readBody = (req: IncomingMessage): Promise<Record<string, unknown>> =>
    new Promise((resolve) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        try {
          resolve(raw ? (JSON.parse(raw) as Record<string, unknown>) : {});
        } catch {
          resolve({});
        }
      });
    });

  const pushConversations = () =>
    opts.broadcast({ kind: "conversations", conversations: store.listConversations() });
  const pushBots = () => opts.broadcast({ kind: "bots", bots: store.listBots() });
  const pushExecutors = () =>
    opts.broadcast({ kind: "executors", executors: orchestrator.executors(), capabilities: orchestrator.capabilities() });

  /** Whether the bot's executor can take its model source, said the way the settings page would say it. */
  const checkSource = async (executorId: string, sourceId: string | null) => {
    const r = await sources.usable(executorId, sourceId);
    if (!r.ok) throw new Rejection(r.reason);
  };

  const extensionsView = () => ({
    agents: agents.view(),
    installed: extensions.list(),
    jobs: installer.jobs(),
    root: installer.root,
    programsRoot: installer.programsRoot,
    environment: detector.current(),
  });

  /** One extension's catalog entry, by the id the UI sends. */
  const catalogEntry = (id: string): CatalogEntry => {
    const entry = catalog.find((c) => c.id === id);
    if (!entry) throw new Rejection("目录里没有这个扩展", 404);
    return entry;
  };

  const server = createServer((req, res) => {
    // a throw inside an async handler is an unhandled rejection, which kills the
    // whole process -- one bad request must not take the app with it
    void handle(req, res).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      if (!(err instanceof Rejection)) console.error("[roster] request failed:", message);
      if (!res.headersSent) json(res, { error: message }, err instanceof Rejection ? err.status : 500);
      else res.end();
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    const method = req.method ?? "GET";
    const route = (pattern: RegExp, verb: string) => (method === verb ? pattern.exec(path) : null);

    if (path === "/api/stream") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write(": connected\n\n");
      const unsub = opts.subscribe((msg) => {
        res.write(`data: ${JSON.stringify(msg)}\n\n`);
      });
      const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
      req.on("close", () => {
        clearInterval(ping);
        unsub();
      });
      return;
    }

    if (path === "/api/state") {
      // capabilities ship as data so the UI degrades per backend instead of
      // hiding whatever the weakest one lacks
      return json(res, {
        bots: store.listBots(),
        conversations: store.listConversations(url.searchParams.get("archived") === "1"),
        executors: orchestrator.executors(),
        capabilities: orchestrator.capabilities(),
        // names only, so a bot's model source can be labelled anywhere; keys never leave the settings page
        sources: store.listProviders().map((p) => ({ id: p.id, name: p.name, preset: p.preset, api: p.api })),
        presence: orchestrator.presence(),
        logos: LOGOS,
        defaultDir: process.env["ROSTER_DEFAULT_DIR"] ?? process.cwd(),
      });
    }

    // under /api so the Vite dev proxy reaches it too
    const logo = /^\/api\/logos\/([a-z0-9-]+)\.webp$/.exec(path);
    if (logo?.[1] && method === "GET") {
      if (!isLogo(logo[1])) return json(res, { error: "not found" }, 404);
      res.writeHead(200, { "content-type": "image/webp", "cache-control": "public, max-age=86400" });
      createReadStream(join(LOGOS_DIR, `${logo[1]}.webp`)).pipe(res);
      return;
    }

    if (path === "/api/models" && method === "GET") {
      return json(res, { models: await orchestrator.models() });
    }

    if (path === "/api/about" && method === "GET") {
      return json(res, opts.about());
    }

    // ---- extensions and the machine they run on ----

    if (path === "/api/extensions" && method === "GET") {
      return json(res, extensionsView());
    }
    // installing an agent means fetching what this machine lacks: its program, or an adapter that is not bundled
    if (path === "/api/extensions/install" && method === "POST") {
      const body = await readBody(req);
      const entry = catalogEntry(String(body["id"] ?? ""));
      const loaded = extensions.list().find((e) => e.type === entry.id && !e.error);
      const job = await guardAsync(() => {
        if (!loaded && entry.extension) {
          const { npm, version, overrides } = entry.extension;
          return installer.install(entry.id, npm, { ...(version ? { version } : {}), ...(overrides ? { overrides } : {}) });
        }
        const program = agents.program(entry.id);
        if (!program) throw new Error(`「${entry.label}」随 Roster 内置，没有什么要装的`);
        return installer.installProgram(entry.id, program);
      });
      if (job.state === "done") {
        await opts.reload();
        pushExecutors();
      }
      return json(res, { job, ...extensionsView() });
    }
    const extensionUpdate = route(/^\/api\/extensions\/([^/]+)\/update$/, "POST");
    if (extensionUpdate?.[1]) {
      const id = extensionUpdate[1];
      const program = agents.program(id);
      const job = await guardAsync(() =>
        program && agents.state(id).installed ? installer.installProgram(id, program) : installer.update(id),
      );
      if (job.state === "done") {
        await opts.reload();
        pushExecutors();
      }
      return json(res, { job, ...extensionsView() });
    }
    const extension = route(/^\/api\/extensions\/([^/]+)$/, "DELETE");
    if (extension?.[1]) {
      const id = extension[1];
      guard(() => {
        if (agents.program(id) && agents.state(id).installed) installer.removeProgram(id);
        else installer.remove(id);
      });
      await opts.reload();
      pushExecutors();
      return json(res, { ok: true, ...extensionsView() });
    }
    if (path === "/api/environment" && method === "GET") {
      const fresh = url.searchParams.get("fresh") === "1";
      const env = await detector.detect(fresh);
      // what was just found is what executors run on from now
      if (fresh) {
        await opts.reload();
        pushExecutors();
      }
      return json(res, env);
    }

    // ---- executors and the endpoints bots call ----

    if (path === "/api/executors" && method === "GET") {
      return json(res, await opts.settings.view());
    }
    if (path === "/api/executors" && method === "POST") {
      const executor = await opts.settings.createExecutor(await readBody(req));
      pushExecutors();
      return json(res, { executor });
    }
    const executorCheck = /^\/api\/executors\/([^/]+)\/check$/.exec(path);
    if (executorCheck?.[1] && method === "POST") {
      return json(res, await opts.settings.check(executorCheck[1]));
    }
    const executorLogin = /^\/api\/executors\/([^/]+)\/login$/.exec(path);
    if (executorLogin?.[1] && method === "GET") {
      return json(res, await opts.settings.login(executorLogin[1], url.searchParams.get("fresh") === "1"));
    }
    const executorAuth = /^\/api\/executors\/([^/]+)\/authenticate$/.exec(path);
    if (executorAuth?.[1] && method === "POST") {
      const body = await readBody(req);
      return json(res, await opts.settings.authenticate(executorAuth[1], String(body["method"] ?? "")));
    }
    const executor = /^\/api\/executors\/([^/]+)$/.exec(path);
    if (executor?.[1] && method === "PATCH") {
      const updated = await opts.settings.updateExecutor(executor[1], await readBody(req));
      pushExecutors();
      // a new setup marks the members started on the old one
      pushConversations();
      return json(res, { executor: updated });
    }
    if (executor?.[1] && method === "DELETE") {
      opts.settings.deleteExecutor(executor[1]);
      pushExecutors();
      return json(res, { ok: true });
    }

    if (path === "/api/providers" && method === "POST") {
      const provider = await opts.settings.createProvider(await readBody(req));
      pushExecutors();
      return json(res, { provider });
    }
    if (path === "/api/providers/probe-models" && method === "POST") {
      return json(res, await opts.settings.probeModels(await readBody(req)));
    }
    const providerCheck = /^\/api\/providers\/([^/]+)\/check$/.exec(path);
    if (providerCheck?.[1] && method === "POST") {
      return json(res, await opts.settings.checkProvider(providerCheck[1]));
    }
    const providerModels = /^\/api\/providers\/([^/]+)\/models$/.exec(path);
    if (providerModels?.[1] && method === "GET") {
      return json(res, await opts.settings.providerModels(providerModels[1]));
    }
    const presetModels = /^\/api\/presets\/([^/]+)\/models$/.exec(path);
    if (presetModels?.[1] && method === "GET") {
      return json(res, await opts.settings.presetModels(decodeURIComponent(presetModels[1])));
    }
    const provider = /^\/api\/providers\/([^/]+)$/.exec(path);
    if (provider?.[1] && method === "PATCH") {
      const updated = await opts.settings.updateProvider(provider[1], await readBody(req));
      pushExecutors();
      pushConversations();
      return json(res, { provider: updated });
    }
    if (provider?.[1] && method === "DELETE") {
      opts.settings.deleteProvider(provider[1]);
      pushExecutors();
      return json(res, { ok: true });
    }

    // ---- bots ----

    if (path === "/api/bots" && method === "POST") {
      const input = botInput(await readBody(req), false, executors()) as BotInput;
      if (store.nameTaken(input.name)) throw new Rejection(`通讯录里已经有叫「${input.name}」的 bot 了`);
      await checkSource(input.executor_id, input.model_source ?? null);
      const bot = store.createBot({ ...input, avatar: input.avatar ?? store.leastUsedLogo(LOGO_IDS) });
      pushBots();
      return json(res, { bot });
    }

    const bot = /^\/api\/bots\/([^/]+)$/.exec(path);
    if (bot?.[1] && method === "PATCH") {
      const current = store.getBot(bot[1]);
      if (!current) throw new Rejection("没有这个 bot");
      const patch = botInput(await readBody(req), true, executors());
      if (patch.name && store.nameTaken(patch.name, bot[1])) {
        throw new Rejection(`通讯录里已经有叫「${patch.name}」的 bot 了`);
      }
      if ("executor_id" in patch || "model_source" in patch) {
        await checkSource(patch.executor_id ?? current.executor_id, "model_source" in patch ? (patch.model_source ?? null) : current.model_source);
      }
      if ("avatar" in patch && !patch.avatar) patch.avatar = store.leastUsedLogo(LOGO_IDS, bot[1]);
      const updated = store.updateBot(bot[1], patch);
      pushBots();
      // names and avatars in every conversation follow the edit
      pushConversations();
      return json(res, { bot: updated });
    }
    if (bot?.[1] && method === "DELETE") {
      const ok = store.archiveBot(bot[1]);
      pushBots();
      return json(res, { ok });
    }

    // ---- conversations ----

    const msgs = /^\/api\/conversations\/([^/]+)\/messages$/.exec(path);
    if (msgs?.[1]) {
      const id = msgs[1];
      if (method === "GET") {
        return json(res, { messages: store.listMessages(id), streams: orchestrator.streams(id) });
      }
      if (method === "POST") {
        const body = await readBody(req);
        const text = String(body["text"] ?? "").trim();
        const ids = Array.isArray(body["attachments"]) ? [...new Set((body["attachments"] as unknown[]).map(String))] : [];
        if (ids.length > MAX_PER_MESSAGE) throw new Rejection(`一条消息最多带 ${MAX_PER_MESSAGE} 个附件`);
        const refs = ids.map((aid) => {
          const ref = attachments.get(id, aid);
          if (!ref) throw new Rejection("有附件找不到了，重新添加一下");
          return ref;
        });
        if (!text && refs.length === 0) throw new Rejection("消息不能为空");
        await orchestrator.send(id, text, refs);
        return json(res, { ok: true });
      }
    }

    // the file's bytes are the body, so a large one never sits in memory as JSON
    const upload = route(/^\/api\/conversations\/([^/]+)\/attachments$/, "POST");
    if (upload?.[1]) {
      if (!store.getConversation(upload[1])) throw new Rejection("没有这个会话", 404);
      if (Number(req.headers["content-length"] ?? 0) > MAX_BYTES) {
        throw new Rejection(`文件太大了，单个最多 ${MAX_BYTES / 1024 / 1024} MB`, 413);
      }
      const header = req.headers["x-file-name"];
      let name = "file";
      try {
        name = decodeURIComponent(String(Array.isArray(header) ? header[0] : (header ?? ""))) || "file";
      } catch {
        // a malformed name is not worth refusing the file over
      }
      const ref = await attachments.save(upload[1], name, String(req.headers["content-type"] ?? ""), req);
      return json(res, { attachment: ref });
    }

    const attachment = /^\/api\/conversations\/([^/]+)\/attachments\/([^/]+)$/.exec(path);
    if (attachment?.[1] && attachment[2]) {
      const [, convId, attachmentId] = attachment as unknown as [string, string, string];
      const ref = attachments.get(convId, attachmentId);
      if (!ref) throw new Rejection("没有这个附件", 404);
      if (method === "GET") {
        res.writeHead(200, {
          "content-type": ref.mime,
          "content-length": ref.size,
          "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(ref.name)}`,
          // an attached page or SVG opened from here must not run as the app's own origin
          "content-security-policy": "sandbox",
          "x-content-type-options": "nosniff",
          "cache-control": "private, max-age=31536000, immutable",
        });
        createReadStream(attachments.path(convId, ref)).pipe(res);
        return;
      }
      if (method === "DELETE") {
        if (store.isAttachmentSent(convId, attachmentId)) throw new Rejection("已经发出去的附件不能删除", 409);
        attachments.remove(convId, attachmentId);
        return json(res, { ok: true });
      }
    }

    // model, mode, effort and plan usage for the composer; later changes arrive as pushes
    const status = route(/^\/api\/conversations\/([^/]+)\/status$/, "GET");
    if (status?.[1]) {
      if (!store.getConversation(status[1])) throw new Rejection("没有这个会话");
      return json(res, await orchestrator.status(status[1]));
    }

    if (path === "/api/conversations" && method === "POST") {
      const body = await readBody(req);
      const dir = String(body["repoPath"] ?? process.cwd()).trim();
      // catch a bad path here, where the message can be shown, rather than three
      // layers down inside a backend
      if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Rejection(`不是一个目录：${dir}`);
      const botIds = Array.isArray(body["botIds"]) ? [...new Set((body["botIds"] as unknown[]).map(String))] : [];
      if (botIds.length === 0) throw new Rejection("至少选一个 bot");
      for (const id of botIds) {
        const b = store.getBot(id);
        if (!b || b.archived_at !== null) throw new Rejection("选中的 bot 已经不在通讯录里了");
      }
      const mode = MODES.includes(body["mode"] as Mode) ? (body["mode"] as Mode) : "human_led";
      const leaderBotId = typeof body["leaderBotId"] === "string" ? body["leaderBotId"] : undefined;
      const conv = store.createConversation({
        title: optText(body["title"], 80) ?? (botIds.length > 1 ? "新群聊" : "New conversation"),
        repoPath: dir,
        worktreePath: dir,
        botIds,
        mode,
        ...(leaderBotId ? { leaderBotId } : {}),
      });
      pushConversations();
      // same shape as the list endpoint, so the UI can insert it optimistically
      return json(res, { conversation: { ...conv, members: store.members(conv.id), archived: false } });
    }

    const archive = route(/^\/api\/conversations\/([^/]+)\/archive$/, "POST");
    if (archive?.[1]) {
      const body = await readBody(req);
      const on = body["archived"] !== false;
      // a conversation you are done with should not keep backend sessions alive
      if (on) await orchestrator.release(archive[1]);
      store.setArchived(archive[1], on);
      pushConversations();
      return json(res, { ok: true, archived: on });
    }

    const read = route(/^\/api\/conversations\/([^/]+)\/read$/, "POST");
    if (read?.[1]) {
      const changed = store.markRead(read[1]);
      if (changed) pushConversations();
      return json(res, { ok: changed });
    }

    const abort = route(/^\/api\/conversations\/([^/]+)\/abort$/, "POST");
    if (abort?.[1]) return json(res, { ok: await orchestrator.abort(abort[1]) });

    const perm = route(/^\/api\/conversations\/([^/]+)\/permissions\/([^/]+)$/, "POST");
    if (perm?.[1] && perm[2]) {
      const body = await readBody(req);
      return json(res, { ok: orchestrator.resolvePermission(perm[1], perm[2], body["allow"] === true) });
    }

    const addMember = route(/^\/api\/conversations\/([^/]+)\/members$/, "POST");
    if (addMember?.[1]) {
      const body = await readBody(req);
      const member = guard(() => orchestrator.addMember(addMember[1]!, String(body["botId"] ?? "")));
      return json(res, { memberId: member.id });
    }

    const sync = route(/^\/api\/conversations\/([^/]+)\/members\/([^/]+)\/sync$/, "POST");
    if (sync?.[1] && sync[2]) {
      await guardAsync(() => orchestrator.syncMember(sync[1]!, sync[2]!));
      return json(res, { ok: true });
    }

    // model, effort or mode for one member's session, from the composer
    const session = route(/^\/api\/conversations\/([^/]+)\/members\/([^/]+)\/session$/, "PATCH");
    if (session?.[1] && session[2]) {
      const body = await readBody(req);
      const patch: MemberSettings = {};
      for (const key of ["model", "effort", "mode"] as const) {
        if (typeof body[key] === "string") patch[key] = body[key];
      }
      if (typeof body["fast"] === "boolean") patch.fast = body["fast"];
      // null means the agent's own sign-in; a string is an endpoint id
      if ("source" in body && (body["source"] === null || typeof body["source"] === "string")) patch.source = body["source"];
      await guardAsync(() => orchestrator.configure(session[1]!, session[2]!, patch));
      return json(res, { ok: true });
    }

    const compact = route(/^\/api\/conversations\/([^/]+)\/members\/([^/]+)\/compact$/, "POST");
    if (compact?.[1] && compact[2]) {
      await guardAsync(() => orchestrator.compact(compact[1]!, compact[2]!));
      return json(res, { ok: true });
    }

    const context = route(/^\/api\/conversations\/([^/]+)\/members\/([^/]+)\/context$/, "GET");
    if (context?.[1] && context[2]) {
      return json(res, await guardAsync(() => orchestrator.contextDetail(context[1]!, context[2]!)));
    }

    const removeMember = route(/^\/api\/conversations\/([^/]+)\/members\/([^/]+)$/, "DELETE");
    if (removeMember?.[1] && removeMember[2]) {
      await guardAsync(() => orchestrator.removeMember(removeMember[1]!, removeMember[2]!));
      return json(res, { ok: true });
    }

    const conv = /^\/api\/conversations\/([^/]+)$/.exec(path);
    if (conv?.[1] && method === "DELETE") {
      await orchestrator.release(conv[1]);
      const ok = store.delete(conv[1]);
      if (ok) attachments.removeConversation(conv[1]);
      pushConversations();
      return json(res, { ok });
    }
    if (conv?.[1] && method === "PATCH") {
      const id = conv[1];
      if (!store.getConversation(id)) throw new Rejection("没有这个会话");
      const body = await readBody(req);
      if ("title" in body) {
        const title = String(body["title"] ?? "").trim();
        if (!title) throw new Rejection("标题不能为空");
        store.rename(id, title.slice(0, 80));
      }
      if ("mode" in body) {
        const mode = body["mode"] as Mode;
        if (!MODES.includes(mode)) throw new Rejection("不认识的群聊模式");
        const leader = typeof body["leaderMemberId"] === "string" ? body["leaderMemberId"] : undefined;
        guard(() => orchestrator.setMode(id, mode, leader));
      }
      pushConversations();
      return json(res, { ok: true });
    }

    // static UI; unknown paths fall back to index.html so the SPA can route
    if (uiDir && method === "GET") {
      const rel = path === "/" ? "index.html" : normalize(path).replace(/^(\.\.[/\\])+/, "");
      let file = join(uiDir, rel);
      if (!existsSync(file) || !statSync(file).isFile()) file = join(uiDir, "index.html");
      if (existsSync(file)) {
        res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
        createReadStream(file).pipe(res);
        return;
      }
    }

    json(res, { error: "not found" }, 404);
  }

  return new Promise((resolve, reject) => {
    const done = () => {
      const addr = server.address();
      resolve({
        port: typeof addr === "object" && addr ? addr.port : 0,
        close: () =>
          new Promise<void>((r) => {
            server.close(() => r());
            // close() waits for every connection to end, and an event stream never does
            server.closeAllConnections();
          }),
      });
    };
    // A stable port keeps the origin stable, and the origin is what localStorage
    // is keyed on -- an ephemeral port silently wipes every UI preference on
    // each launch. Fall back only when something else already holds it.
    server.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code !== "EADDRINUSE") return reject(err);
      server.listen(0, "127.0.0.1", done);
    });
    // loopback only; this process is the authority and nothing else should reach it
    server.listen(opts.port ?? 7788, "127.0.0.1", done);
  });
}

/** The orchestrator's own validation errors are the user's to read, not a crash. */
function guard<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    throw new Rejection(err instanceof Error ? err.message : String(err));
  }
}

async function guardAsync<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw new Rejection(err instanceof Error ? err.message : String(err));
  }
}
