// Runs against dist: `pnpm --filter @roster/core test` builds first.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { createServer, get } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Readable } from "node:stream";
import { after, beforeEach, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { literal, piHarness } from "@roster/ext-pi-agent";
import { aboutReader } from "../dist/about.js";
import { openDb } from "../dist/db/index.js";
import { AttachmentStore, MAX_BYTES } from "../dist/attachments.js";
import { composeDelivery } from "../dist/delivery.js";
import { Detector } from "../dist/detect.js";
import { Rejection } from "../dist/errors.js";
import { checkEndpoint, ExecutorSettings } from "../dist/executors.js";
import { Extensions } from "../dist/extensions.js";
import { Harnesses } from "../dist/harnesses.js";
import { locale, matchLocale, setLocale, systemLocale } from "../dist/i18n/index.js";
import { Installer } from "../dist/installer.js";
import { LOGO_IDS, LOGOS_DIR, logos } from "../dist/logos.js";
import { findMentions } from "../dist/mentions.js";
import { Orchestrator } from "../dist/orchestrator.js";
import { Registry } from "../dist/registry.js";
import { scriptedFactory } from "../dist/scripted.js";
import { NO_VAULT, Secrets } from "../dist/secrets.js";
import { fits, sourceOf, Sources } from "../dist/sources.js";
import { Store, UNTITLED } from "../dist/store.js";

// the fixtures and expectations are written in Chinese; the languages suite switches and switches back
setLocale("zh-CN");

/** Runs fn with core in another language, and puts the language back whatever happens. */
async function inLocale(next, fn) {
  const before = locale();
  setLocale(next);
  try {
    return await fn();
  } finally {
    setLocale(before);
  }
}

const dirs = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** A scripted backend that also records every prompt each bot was handed, unless other factories are given. */
function harness(factories) {
  const dir = mkdtempSync(join(tmpdir(), "roster-test-"));
  dirs.push(dir);
  const db = openDb(join(dir, "roster.db"));
  const store = new Store(db);
  const secrets = new Secrets(db, NO_VAULT);
  // nothing is built in any more: the two executors the fixtures name are rows like any other
  for (const id of ["pi", "claude"]) store.createExecutor({ id, name: id, type: "scripted", source_kind: "own", provider_id: null, model: null });
  const sent = [];
  const inner = scriptedFactory("pi", 1);
  const spy = {
    ...inner,
    create() {
      const rt = inner.create();
      let name = "?";
      let cwd;
      return new Proxy(rt, {
        get(target, prop) {
          if (prop === "start") {
            return (opts) => {
              name = opts.systemPrompt ?? "?";
              cwd = opts.cwd;
              return target.start(opts);
            };
          }
          if (prop === "send") {
            return (text, deliver, attachments = []) => {
              sent.push({ preset: name, cwd, text, attachments });
              return target.send(text, deliver, attachments);
            };
          }
          const v = target[prop];
          return typeof v === "function" ? v.bind(target) : v;
        },
      });
    },
  };
  const pushed = [];
  const registry = new Registry(factories ?? { pi: spy, claude: spy });
  const sources = new Sources(store, secrets, () => registry, async () => []);
  const attachments = new AttachmentStore(join(dir, "attachments"));
  const orch = new Orchestrator(store, (m) => pushed.push(m), registry, sources, attachments);
  const bot = (name, extra = {}) =>
    store.createBot({
      name,
      title: `${name} 的职责`,
      avatar: null,
      // the preset doubles as a label, so the spy can tell who received a prompt
      system_prompt: `preset:${name}`,
      executor_id: "pi",
      model: null,
      permission_tier: "read",
      ...extra,
    });
  const group = (bots, extra = {}) =>
    store.createConversation({
      title: "新群聊",
      repoPath: dir,
      worktreePath: dir,
      botIds: bots.map((b) => b.id),
      ...extra,
    });
  const said = (conversationId) =>
    store
      .listMessages(conversationId)
      .filter((m) => m.card_kind === "text" || m.card_kind === "system")
      .map((m) => {
        const text = JSON.parse(m.body_json).text;
        if (m.author_kind === "human") return `用户: ${text}`;
        if (m.author_kind === "system") return `* ${text}`;
        const member = store.getMember(m.author_member_id);
        return `${store.getBot(member.bot_id).name}: ${text}`;
      });
  return { store, secrets, orch, sent, pushed, bot, group, said, dir, registry, sources, attachments };
}

/** Resolves once the conversation has stayed idle across a few event-loop turns. */
async function settle(store, conversationId, timeout = 5000) {
  const end = Date.now() + timeout;
  let quiet = 0;
  while (Date.now() < end) {
    await new Promise((r) => setTimeout(r, 15));
    quiet = store.getConversation(conversationId).run_state === "idle" ? quiet + 1 : 0;
    if (quiet >= 4) return;
  }
  throw new Error(`conversation still running after ${timeout}ms`);
}

async function until(pred, timeout = 5000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("condition not met in time");
}

/**
 * A backend that plays one turn as written: a string is text, { think } is thinking,
 * { start } announces a call, { gate } takes it through the host, { end } returns its result.
 */
function played(actions) {
  const scripted = scriptedFactory("pi", 1);
  return {
    ...scripted,
    create() {
      const handlers = new Set();
      const emit = (e) => handlers.forEach((h) => h(e));
      let opts;
      return {
        capabilities: scripted.capabilities,
        resumeToken: undefined,
        subscribe: (h) => (handlers.add(h), () => handlers.delete(h)),
        start: async (o) => {
          opts = o;
        },
        send: async () => {
          emit({ type: "turn.start", display: "status" });
          void (async () => {
            for (const a of actions) {
              if (typeof a === "string") emit({ type: "assistant.text", display: "message", delta: a });
              else if (a.think !== undefined) emit({ type: "assistant.thinking", display: "fold", delta: a.think });
              else if (a.start) emit({ type: "tool.start", display: "fold", call: a.start });
              else if (a.gate) await opts.onToolCall(a.gate);
              else if (a.end) emit({ type: "tool.end", display: "fold", ...a.end });
            }
            emit({ type: "turn.end", display: "status", reason: "done" });
          })();
        },
        abort: async () => {},
        dispose: async () => handlers.clear(),
      };
    },
  };
}

describe("mentions", () => {
  const members = [
    { id: "go", name: "Go工程师" },
    { id: "g", name: "Go" },
    { id: "rev", name: "审查员" },
    { id: "bob", name: "Bob" },
  ];

  test("matches CJK names with no trailing space, longest first", () => {
    assert.deepEqual(findMentions("@Go工程师帮我看看，@审查员review", members), { ids: ["go", "rev"], all: false });
  });

  test("an ASCII name does not match inside a longer word", () => {
    assert.deepEqual(findMentions("@Bobby hi", members).ids, []);
    assert.deepEqual(findMentions("@bob, hi", members).ids, ["bob"]);
  });

  test("ignores emails and code", () => {
    assert.deepEqual(findMentions("mail me@Bob or `@Bob` or\n```\n@Bob\n```", members).ids, []);
  });

  test("@所有人 addresses everyone", () => {
    assert.equal(findMentions("@所有人 看一下", members).all, true);
  });
});

describe("delivery", () => {
  const base = {
    title: "t",
    mode: "human_led",
    selfId: "a",
    leaderId: null,
    members: [{ id: "a", name: "甲", title: "前端" }, { id: "b", name: "乙", title: null }],
    names: new Map([["a", "甲"], ["b", "乙"]]),
    asks: new Set(["mention"]),
    fresh: true,
  };
  const item = (kind, text, memberId = null) => ({ seq: 1, memberId, kind, text, at: 0 });

  test("a direct conversation passes what the human typed through untouched", () => {
    const out = composeDelivery({ ...base, shape: "direct", items: [item("human", "写个 hello")] });
    assert.equal(out.text, "写个 hello");
    assert.deepEqual(out.attachments, []);
  });

  test("what the human attached follows what they typed: a short text file in full, anything else by path", () => {
    const files = [
      { name: "notes.md", mime: "text/markdown", size: 20, path: "/data/a/notes.md", content: "# 需求\n登录页" },
      { name: "shot.png", mime: "image/png", size: 2048, path: "/data/b/shot.png" },
    ];
    const out = composeDelivery({ ...base, shape: "direct", items: [{ ...item("human", "看看这个"), files }] });
    assert.match(out.text, /^看看这个\n\n<attachment name="notes.md" path="\/data\/a\/notes.md">\n# 需求\n登录页\n<\/attachment>/);
    assert.match(out.text, /<attachment name="shot.png" path="\/data\/b\/shot.png" type="image\/png" size="2 KB" \/>$/);
    assert.deepEqual(out.attachments.map((a) => a.name), ["notes.md", "shot.png"]);
    assert.equal("content" in out.attachments[0], false);
  });

  test("a group turn names the roster, marks self, and ends with the instruction", () => {
    const out = composeDelivery({
      ...base,
      shape: "group",
      items: [item("human", "@甲 做登录"), item("bot", "我来写接口", "b")],
    }).text;
    assert.match(out, /- 甲（你）：前端/);
    assert.match(out, /<message from="乙"/);
    assert.match(out, /用户在群里 @ 了你/);
  });

  test("a later turn carries only the new lines and who you are; the roster returns when the group changes", () => {
    const later = composeDelivery({
      ...base,
      shape: "group",
      fresh: false,
      items: [item("human", "继续"), item("bot", "好", "b")],
    }).text;
    assert.doesNotMatch(later, /<members>|<group_chat/);
    assert.match(later, /^<messages>\n<message from="用户"/);
    assert.match(later, /\n\n你是甲。用户在群里 @ 了你/);

    const changed = composeDelivery({
      ...base,
      shape: "group",
      fresh: false,
      items: [{ ...item("notice", "丙 加入了群聊"), notice: "notice.joined" }, item("human", "欢迎")],
    }).text;
    assert.match(changed, /<group_chat title="t" mode="人主导">\n<members>\n- 甲（你）：前端/);
    assert.match(changed, /<notice time="[0-9:]+">丙 加入了群聊<\/notice>/);

    const synced = composeDelivery({
      ...base,
      shape: "group",
      fresh: false,
      items: [{ ...item("notice", "乙 切换到了更新后的设定"), notice: "notice.synced" }, item("human", "继续")],
    }).text;
    assert.doesNotMatch(synced, /<members>/);
  });

  test("nothing owed means no turn", () => {
    assert.equal(composeDelivery({ ...base, shape: "group", items: [] }), null);
  });

  test("a long backlog drops old bot lines but never what the human said", () => {
    const long = "x".repeat(20_000);
    const out = composeDelivery({
      ...base,
      shape: "group",
      items: [item("human", "最早的需求"), item("bot", long, "b"), item("bot", long, "b"), item("human", "最新的问题")],
    }).text;
    assert.match(out, /最早的需求/);
    assert.match(out, /最新的问题/);
    assert.match(out, /omitted_earlier="1"/);
  });
});

describe("attachments", () => {
  test("a file keeps only its own name, a binary one is pointed at, and one too large leaves nothing behind", async () => {
    const dir = mkdtempSync(join(tmpdir(), "roster-attachments-"));
    dirs.push(dir);
    const store = new AttachmentStore(dir);
    const conv = randomUUID();
    const ref = await store.save(conv, "../../secrets/key.txt", "", Readable.from([Buffer.from([0xff, 0xfe, 0x00, 0x41])]));
    assert.equal(ref.name, "key.txt");
    assert.equal(ref.mime, "text/plain");
    const [file] = store.deliver(conv, [ref]);
    assert.equal(file.content, undefined);
    assert.ok(file.path.startsWith(join(dir, conv, ref.id)));
    assert.deepEqual(store.get(conv, ref.id), ref);
    assert.equal(store.get(conv, "../x"), null);

    const chunks = function* () {
      for (let i = 0; i <= MAX_BYTES / (1 << 20); i++) yield Buffer.alloc(1 << 20);
    };
    await assert.rejects(
      store.save(conv, "big.bin", "application/octet-stream", Readable.from(chunks())),
      (err) => err instanceof Rejection && err.status === 413,
    );
    assert.deepEqual(readdirSync(join(dir, conv)), [ref.id]);
  });
});

describe("orchestrator", () => {
  let h;
  beforeEach(() => {
    h = harness();
  });

  test("a direct conversation replies once and waits for the human", async () => {
    const pi = h.bot("Pi");
    const conv = h.group([pi]);
    await h.orch.send(conv.id, "写个 hello");
    await settle(h.store, conv.id);

    assert.deepEqual(h.said(conv.id), ["用户: 写个 hello", "Pi: 收到：写个 hello"]);
    assert.equal(h.sent[0].text, "写个 hello");
    const after = h.store.getConversation(conv.id);
    assert.equal(after.attention, "waiting_input");
    assert.equal(after.title, "写个 hello");
  });

  test("files alone are a message: named to the bot with a short text in full, handed over as they are, and titling it", async () => {
    const pi = h.bot("Pi");
    const conv = h.group([pi]);
    const notes = await h.attachments.save(conv.id, "notes.md", "text/markdown", Readable.from([Buffer.from("# 登录页\n要有验证码")]));
    const shot = await h.attachments.save(conv.id, "shot.png", "image/png", Readable.from([randomBytes(64)]));
    await h.orch.send(conv.id, "", [notes, shot]);
    await settle(h.store, conv.id);

    const [human, reply] = h.store.listMessages(conv.id);
    assert.deepEqual(JSON.parse(human.body_json).attachments.map((a) => a.name), ["notes.md", "shot.png"]);
    assert.match(h.sent[0].text, /^<attachment name="notes.md" path="[^"]+">\n# 登录页\n要有验证码\n<\/attachment>\n\n<attachment name="shot.png"/);
    assert.deepEqual(h.sent[0].attachments.map((a) => a.mime), ["text/markdown", "image/png"]);
    assert.ok(existsSync(h.sent[0].attachments[1].path));
    assert.match(JSON.parse(reply.body_json).text, /附件：notes.md（text\/markdown）、shot.png（image\/png）/);
    assert.equal(h.store.getConversation(conv.id).title, "notes.md");
  });

  test("human-led: @ picks the speaker, and no @ goes to whoever spoke last", async () => {
    const a = h.bot("甲");
    const b = h.bot("乙");
    const conv = h.group([a, b]);

    await h.orch.send(conv.id, "大家好");
    await settle(h.store, conv.id);
    await h.orch.send(conv.id, "@乙 你来");
    await settle(h.store, conv.id);
    await h.orch.send(conv.id, "继续");
    await settle(h.store, conv.id);

    const bots = h.said(conv.id).filter((l) => !l.startsWith("用户"));
    assert.deepEqual(
      bots.map((l) => l.split(":")[0]),
      ["甲", "乙", "乙"],
    );
    // the second member's next turn sees only what is new to it, never its own lines
    const last = h.sent.at(-1).text;
    assert.match(last, /继续/);
    assert.doesNotMatch(last, /from="乙（你）"/);
  });

  test("@所有人 asks every member", async () => {
    const conv = h.group([h.bot("甲"), h.bot("乙"), h.bot("丙")]);
    await h.orch.send(conv.id, "@所有人 报个到");
    await settle(h.store, conv.id);
    const speakers = h.said(conv.id).slice(1).map((l) => l.split(":")[0]).sort();
    assert.deepEqual(speakers, ["丙", "乙", "甲"].sort());
  });

  test("leader mode: dispatch, reports, then back to the human", async () => {
    const lead = h.bot("组长");
    const a = h.bot("甲");
    const b = h.bot("乙");
    const conv = h.group([lead, a, b], { mode: "leader", leaderBotId: lead.id });

    await h.orch.send(conv.id, "做一个登录页");
    await settle(h.store, conv.id);

    const lines = h.said(conv.id);
    const speakers = lines.slice(1).map((l) => l.split(":")[0]);
    assert.equal(speakers[0], "组长");
    assert.deepEqual(speakers.slice(1, 3).sort(), ["乙", "甲"].sort());
    assert.equal(speakers[3], "组长");
    assert.equal(speakers.length, 4, `unexpected extra turns: ${lines.join(" | ")}`);
    assert.match(lines.at(-1), /汇总/);
    // the leader's report turn saw both members' results
    const report = h.sent.filter((s) => s.preset === "preset:组长").at(-1).text;
    assert.match(report, /from="甲"/);
    assert.match(report, /from="乙"/);
    assert.equal(h.store.getConversation(conv.id).attention, "waiting_input");
  });

  test("discussion mode: everyone speaks once and writes need the human", async () => {
    const a = h.bot("甲", { permission_tier: "execute" });
    const b = h.bot("乙", { permission_tier: "execute" });
    const conv = h.group([a, b], { mode: "discussion" });

    await h.orch.send(conv.id, "这个方案行不行 #write");
    await until(() => h.store.listMessages(conv.id).filter((m) => m.status === "pending").length === 2);
    assert.equal(h.store.getConversation(conv.id).attention, "waiting_permission");

    for (const card of h.store.listMessages(conv.id).filter((m) => m.status === "pending")) {
      assert.equal(h.orch.resolvePermission(conv.id, JSON.parse(card.body_json).requestId, false), true);
    }
    await settle(h.store, conv.id);
    const speakers = h.said(conv.id).slice(1).map((l) => l.split(":")[0]).sort();
    assert.deepEqual(speakers, ["乙", "甲"].sort());
    assert.ok(h.sent.every((s) => s.text.includes("现在是讨论模式")));
  });

  test("members speaking at once say when their turns began, and that they are writing before the reply lands", async () => {
    const a = h.bot("甲");
    const b = h.bot("乙");
    const conv = h.group([a, b], { mode: "discussion" });
    const ids = h.store.activeMembers(conv.id).map((m) => m.id);

    await h.orch.send(conv.id, "各说各的");
    await settle(h.store, conv.id);

    const presence = h.pushed.filter((m) => m.kind === "presence");
    const working = presence.filter((m) => m.state !== "idle");
    assert.ok(working.length > 0);
    assert.ok(working.every((m) => m.turnId && Number.isFinite(m.since)), "a running member says when its turn began");
    assert.ok(presence.filter((m) => m.state === "idle").every((m) => m.since === undefined && m.turnId === undefined));
    // the members were asked in roster order, and a turn's reports all name the same beginning
    const since = (id) => new Set(working.filter((m) => m.memberId === id).map((m) => m.since));
    assert.equal(since(ids[0]).size, 1);
    assert.equal(since(ids[1]).size, 1);
    assert.ok([...since(ids[0])][0] <= [...since(ids[1])][0]);

    for (const id of ids) {
      const own = h.pushed
        .map((m, i) => ({ m, i }))
        .filter(({ m }) =>
          m.kind === "presence" || m.kind === "delta"
            ? m.memberId === id
            : m.kind === "message" && m.message.author_member_id === id && m.message.card_kind === "text",
        );
      const writing = own.find(({ m }) => m.kind === "presence" && m.state === "writing");
      const delta = own.find(({ m }) => m.kind === "delta");
      const reply = own.find(({ m }) => m.kind === "message");
      assert.ok(writing && delta && reply);
      assert.ok(writing.i < delta.i && delta.i < reply.i, "writing is reported as the first words go out, ahead of the finished reply");
    }
  });

  test("a read-only bot asks before writing, and proceeds once allowed", async () => {
    const pi = h.bot("Pi");
    const conv = h.group([pi]);
    await h.orch.send(conv.id, "改一下 #write");
    await until(() => h.store.listMessages(conv.id).some((m) => m.status === "pending"));
    const card = h.store.listMessages(conv.id).find((m) => m.status === "pending");
    h.orch.resolvePermission(conv.id, JSON.parse(card.body_json).requestId, true);
    await settle(h.store, conv.id);

    const messages = h.store.listMessages(conv.id);
    assert.equal(messages.find((m) => m.card_kind === "permission").status, "allowed");
    const steps = JSON.parse(messages.find((m) => m.card_kind === "steps").body_json).steps;
    assert.deepEqual(steps.map((s) => [s.name, s.ok]), [["write", true]]);
  });

  test("two writers in one group take turns on the worktree", async () => {
    const a = h.bot("甲", { permission_tier: "write" });
    const b = h.bot("乙", { permission_tier: "write" });
    const conv = h.group([a, b]);
    const waited = [];
    const orig = h.pushed.push.bind(h.pushed);
    h.pushed.push = (m) => {
      if (m.kind === "presence" && m.state === "waiting_lock") waited.push(m.memberId);
      return orig(m);
    };

    await h.orch.send(conv.id, "@所有人 一起改 #write");
    await settle(h.store, conv.id);
    assert.equal(waited.length, 1, "exactly one member should have queued for the lease");
    const steps = h.store
      .listMessages(conv.id)
      .filter((m) => m.card_kind === "steps")
      .flatMap((m) => JSON.parse(m.body_json).steps);
    assert.deepEqual(steps.map((s) => s.ok), [true, true]);
  });

  test("stop halts the leader loop", async () => {
    const lead = h.bot("组长");
    const a = h.bot("甲");
    const conv = h.group([lead, a], { mode: "leader", leaderBotId: lead.id });
    const memberA = h.store.activeMembers(conv.id).find((m) => m.bot_id === a.id);
    // stop the moment the dispatched member starts, before it can report back
    let stopped = null;
    const orig = h.pushed.push.bind(h.pushed);
    h.pushed.push = (m) => {
      if (!stopped && m.kind === "presence" && m.memberId === memberA.id) stopped = h.orch.abort(conv.id);
      return orig(m);
    };

    await h.orch.send(conv.id, "开始");
    await until(() => stopped !== null);
    await stopped;
    await settle(h.store, conv.id);

    const lines = h.said(conv.id);
    assert.equal(lines.filter((l) => l.startsWith("组长")).length, 1, lines.join(" | "));
    assert.ok(!lines.some((l) => l.includes("汇总")), `the leader summarized after stop: ${lines.join(" | ")}`);
    assert.equal(h.store.getConversation(conv.id).run_state, "idle");
  });

  test("a member joining late is handed the backlog, and a 1:1 becomes a group", async () => {
    const a = h.bot("甲");
    const conv = h.group([a]);
    await h.orch.send(conv.id, "先说背景：我们在做支付");
    await settle(h.store, conv.id);

    const b = h.bot("乙");
    h.orch.addMember(conv.id, b.id);
    assert.equal(h.store.getConversation(conv.id).shape, "group");
    await h.orch.send(conv.id, "@乙 你怎么看");
    await settle(h.store, conv.id);

    const joined = h.sent.find((s) => s.preset === "preset:乙").text;
    assert.match(joined, /先说背景：我们在做支付/);
    assert.match(joined, /from="甲"/);
    assert.match(joined, /乙 加入了群聊/);
    assert.throws(() => h.orch.addMember(conv.id, b.id), /已经在群里/);
  });

  test("removing the leader hands the role on and says so", async () => {
    const lead = h.bot("组长");
    const a = h.bot("甲");
    const conv = h.group([lead, a], { mode: "leader", leaderBotId: lead.id });
    const leaderMember = h.store.activeMembers(conv.id).find((m) => m.bot_id === lead.id);
    await h.orch.removeMember(conv.id, leaderMember.id);
    const lines = h.said(conv.id);
    assert.deepEqual(lines, ["* 组长 被移出了群聊", "* 群主改为 甲"]);
  });

  test("syncing a member adopts the edited preset in a fresh session", async () => {
    const a = h.bot("甲");
    const conv = h.group([a]);
    await h.orch.send(conv.id, "第一句");
    await settle(h.store, conv.id);

    h.store.updateBot(a.id, { system_prompt: "preset:甲v2" });
    assert.equal(h.store.members(conv.id)[0].stale, true);
    const member = h.store.activeMembers(conv.id)[0];
    await h.orch.syncMember(conv.id, member.id);
    assert.equal(h.store.members(conv.id)[0].stale, false);

    await h.orch.send(conv.id, "第二句");
    await settle(h.store, conv.id);
    const last = h.sent.at(-1);
    assert.equal(last.preset, "preset:甲v2");
    // a fresh session is told what came before
    assert.match(last.text, /第一句/);
    assert.match(last.text, /第二句/);
  });
});

/** A backend that cannot answer at all, so the turn ends as a failure. */
function broken(message) {
  const scripted = scriptedFactory("pi", 1);
  return {
    ...scripted,
    create: () => ({
      capabilities: scripted.capabilities,
      resumeToken: undefined,
      subscribe: () => () => {},
      start: async () => {},
      send: async () => {
        throw new Error(message);
      },
      abort: async () => {},
      dispose: async () => {},
    }),
  };
}

describe("notifications", () => {
  let h;
  beforeEach(() => {
    h = harness();
  });

  const notified = () => h.pushed.filter((m) => m.kind === "notify").map((m) => m.notification);
  const direct = (bot) =>
    h.store.createConversation({ title: "与 Pi 的会话", repoPath: h.dir, worktreePath: h.dir, dirKind: "chat", botIds: [bot.id] });

  test("a 1:1 reply is one notification: the conversation it came in, and what was said", async () => {
    const conv = direct(h.bot("Pi"));
    await h.orch.send(conv.id, "写个 hello");
    await settle(h.store, conv.id);

    assert.deepEqual(
      notified().map((n) => [n.reason, n.conversationId, n.title, n.body]),
      [["waiting_input", conv.id, "写个 hello", "收到：写个 hello"]],
    );
  });

  test("a group reply names who spoke, the way the list does", async () => {
    const conv = h.group([h.bot("Pi")]);
    await h.orch.send(conv.id, "写个 hello");
    await settle(h.store, conv.id);

    assert.deepEqual(notified().map((n) => n.body), ["Pi：收到：写个 hello"]);
  });

  test("an approval request says what it wants to run; a second one while that one waits is not news", async () => {
    const conv = h.group([h.bot("甲"), h.bot("乙")], { mode: "discussion" });
    await h.orch.send(conv.id, "看看目录 #exec");
    await until(() => h.store.listMessages(conv.id).filter((m) => m.status === "pending").length === 2);

    const asked = notified();
    assert.equal(asked.length, 1, `two members asking is still one interruption: ${JSON.stringify(asked)}`);
    assert.equal(asked[0].reason, "waiting_permission");
    assert.match(asked[0].body, /^[甲乙]：等你批准：ls -la$/);

    for (const card of h.store.listMessages(conv.id).filter((m) => m.status === "pending")) {
      h.orch.resolvePermission(conv.id, JSON.parse(card.body_json).requestId, false);
    }
    await settle(h.store, conv.id);
    // deciding it does not end the wait: the turn then finishes, and that is worth one more
    assert.deepEqual(notified().map((n) => n.reason), ["waiting_permission", "waiting_input"]);
  });

  test("a turn that failed says why, not just that something is waiting", async () => {
    h = harness({ pi: broken("模型没答应") });
    const conv = direct(h.bot("Pi"));
    await h.orch.send(conv.id, "写个 hello");
    await settle(h.store, conv.id);

    assert.deepEqual(
      notified().map((n) => [n.reason, n.body]),
      [["error", "模型没答应"]],
    );
  });

  test("every turn you start is worth telling you about once it lands", async () => {
    const conv = direct(h.bot("Pi"));
    await h.orch.send(conv.id, "第一句");
    await settle(h.store, conv.id);
    await h.orch.send(conv.id, "第二句");
    await settle(h.store, conv.id);

    assert.deepEqual(notified().map((n) => n.body), ["收到：第一句", "收到：第二句"]);
  });
});

describe("the list", () => {
  let h;
  beforeEach(() => {
    h = harness();
  });

  const direct = (bot) =>
    h.store.createConversation({ title: `与 ${bot.name} 的会话`, repoPath: h.dir, worktreePath: h.dir, dirKind: "chat", botIds: [bot.id] });
  // creation times a few milliseconds apart, so recency has an order to go by
  const tick = () => new Promise((r) => setTimeout(r, 5));
  const listed = (archived = false) => h.store.listConversations(archived);
  const titles = () => listed().map((c) => c.title);

  test("pinned comes first, even above what waits on you; among the pinned, what waits still leads", async () => {
    const pi = h.bot("Pi");
    const first = h.group([pi], { title: "一" });
    await tick();
    const second = h.group([pi], { title: "二" });
    await tick();
    const third = h.group([pi], { title: "三" });
    assert.deepEqual(titles(), ["三", "二", "一"]);

    h.store.setPinned(first.id, true);
    h.store.setAttention(second.id, "waiting_input");
    assert.deepEqual(titles(), ["一", "二", "三"]);
    assert.deepEqual(listed().map((c) => c.pinned), [true, false, false]);

    h.store.setPinned(third.id, true);
    assert.deepEqual(titles(), ["三", "一", "二"], "the pinned ones by recency");
    await tick();
    h.store.setAttention(first.id, "waiting_input");
    assert.deepEqual(titles(), ["一", "三", "二"]);

    h.store.setPinned(first.id, false);
    h.store.setPinned(third.id, false);
    assert.deepEqual(titles(), ["二", "一", "三"], "unpinned, the longest waiting leads again");
  });

  test("a 1:1 is pinned as its bot's row: later sessions share the pin, and it outlives the one it was pinned from", async () => {
    const pi = h.bot("Pi");
    const gpt = h.bot("GPT");
    const old = direct(pi);
    direct(gpt);
    h.group([pi, gpt], { title: "群" });
    h.store.setPinned(old.id, true);
    await tick();
    const fresh = direct(pi);
    const pinned = () => listed().filter((c) => c.pinned).map((c) => c.id).sort();
    assert.deepEqual(pinned(), [old.id, fresh.id].sort(), "every session with Pi, and no group Pi is in");

    h.store.delete(old.id);
    assert.deepEqual(pinned(), [fresh.id]);
    h.store.setArchived(fresh.id, true);
    assert.equal(listed(true).find((c) => c.id === fresh.id).pinned, false, "archived is out of the list it was pinned in");
    h.store.setArchived(fresh.id, false);
    assert.deepEqual(pinned(), [fresh.id], "and back in it once restored");
    h.store.setPinned(fresh.id, false);
    assert.deepEqual(pinned(), []);
  });

  test("marked unread waits until it is read: after what the bots wait on, and a live wait shows through it", async () => {
    const pi = h.bot("Pi");
    const marked = h.group([pi], { title: "标" });
    await tick();
    h.group([pi], { title: "新" });
    await tick();
    const replied = h.group([pi], { title: "回" });
    h.store.setAttention(replied.id, "waiting_input");
    const shown = () => listed().find((c) => c.id === marked.id).attention;

    assert.equal(h.store.setUnread(marked.id, true), true);
    assert.equal(shown(), "unread");
    assert.deepEqual(titles(), ["回", "标", "新"]);
    const since = h.store.getConversation(marked.id).unread_at;
    await tick();
    assert.equal(h.store.setUnread(marked.id, true), false);
    assert.equal(h.store.getConversation(marked.id).unread_at, since, "marking it again keeps its place in line");

    h.store.setAttention(marked.id, "waiting_permission");
    assert.equal(shown(), "waiting_permission");
    assert.equal(h.store.markRead(marked.id), true);
    assert.equal(shown(), "waiting_permission", "reading does not decide a pending permission");
    h.store.setAttention(marked.id, "none");
    assert.equal(shown(), "none", "but the mark went with the reading");
    assert.equal(h.store.markRead(marked.id), false);
  });

  test("writing in a marked conversation reads it", async () => {
    const conv = h.group([h.bot("Pi")]);
    h.store.setUnread(conv.id, true);
    await h.orch.send(conv.id, "继续");
    assert.equal(h.store.getConversation(conv.id).unread_at, null);
    await settle(h.store, conv.id);
  });

  test("pins and marks go through the API, and a new 1:1 with a pinned bot comes back pinned", { timeout: 20_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "roster-list-"));
    dirs.push(dir);
    const { core, url } = startCore(dir);
    try {
      const base = await url;
      const call = async (path, method = "GET", body) => {
        const res = await fetch(new URL(path, base), {
          method,
          ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
        });
        return res.json();
      };
      const entry = async (id) => (await call("/api/state")).conversations.find((c) => c.id === id);
      const bot = (await call("/api/state")).bots[0];
      const first = (await call("/api/conversations", "POST", { botIds: [bot.id] })).conversation;
      assert.equal(first.pinned, false);

      assert.deepEqual(await call(`/api/conversations/${first.id}/pin`, "POST", { pinned: true }), { ok: true, pinned: true });
      const second = (await call("/api/conversations", "POST", { botIds: [bot.id] })).conversation;
      assert.equal(second.pinned, true);

      assert.deepEqual(await call(`/api/conversations/${first.id}/unread`, "POST"), { ok: true });
      assert.equal((await entry(first.id)).attention, "unread");
      assert.deepEqual(await call(`/api/conversations/${first.id}/read`, "POST"), { ok: true });
      assert.equal((await entry(first.id)).attention, "none");

      assert.deepEqual(await call(`/api/conversations/${second.id}/pin`, "POST", { pinned: false }), { ok: true, pinned: false });
      assert.equal((await entry(first.id)).pinned, false, "unpinned from either session, the row is");
    } finally {
      core.kill("SIGKILL");
    }
  });
});

describe("session status", () => {
  const usage = (usedPercent) => ({ plan: "pro", windows: [{ kind: "session", usedPercent }] });

  test("a member is previewed before its first turn, then shown as its session reports", async () => {
    const scripted = scriptedFactory("pi", 1);
    const h = harness({ pi: { ...scripted, sessionInfo: async ({ model }) => ({ model: `preview:${model}` }) } });
    const conv = h.group([h.bot("甲", { model: "m1" })]);
    const [member] = h.store.activeMembers(conv.id);

    // with no permission modes of its own, the mode shown is the tier it is gated by
    assert.deepEqual((await h.orch.status(conv.id)).sessions[member.id], { model: "preview:m1", mode: "read" });

    await h.orch.send(conv.id, "一");
    await settle(h.store, conv.id);

    const parts = [
      { name: "系统工具", tokens: 9_000 },
      { name: "系统提示词", tokens: 3_000 },
      { name: "消息", tokens: 3_000 },
    ];
    const context = { used: 15_000, max: 200_000, percent: 8, autoCompactAt: 84, parts };
    // a first turn has no prefix to read back: it writes all of it
    const cache = { read: 0, write: 12_000, uncached: 0 };
    const { commands } = await scripted.sessionOptions();
    const reported = { model: "m1", modelLabel: "m1", mode: "read", effort: "high", fast: "off", context, cache, commands };
    assert.deepEqual((await h.orch.status(conv.id)).sessions[member.id], reported);
    // a session restating the same picture is not news
    await h.orch.configure(conv.id, member.id, {});
    assert.deepEqual(h.pushed.filter((m) => m.kind === "session").map((m) => m.info), [reported]);
  });

  test("picks for a session are kept, reach it live, and survive into its next start", async () => {
    const scripted = scriptedFactory("pi", 1);
    const h = harness({ pi: { ...scripted, capabilities: { ...scripted.capabilities, permissionModes: true } } });
    const conv = h.group([h.bot("甲")]);
    const [member] = h.store.activeMembers(conv.id);

    // nothing running yet: the pick waits for the start, and the preview shows it now
    await h.orch.configure(conv.id, member.id, { mode: "plan" });
    assert.equal(h.pushed.findLast((m) => m.kind === "session").info.mode, "plan");

    await h.orch.send(conv.id, "一");
    await settle(h.store, conv.id);
    assert.equal((await h.orch.status(conv.id)).sessions[member.id].mode, "plan");

    await h.orch.configure(conv.id, member.id, { model: "scripted-plain" });
    const live = h.pushed.findLast((m) => m.kind === "session").info;
    assert.deepEqual([live.model, live.mode, live.effort], ["scripted-plain", "plan", null]);
    assert.deepEqual(h.store.getMember(member.id).settings, { mode: "plan", model: "scripted-plain" });

    await assert.rejects(h.orch.configure(conv.id, member.id, { mode: "yolo" }), /不认识的模式/);
    await assert.rejects(h.orch.configure(conv.id, member.id, { model: "gpt" }), /不认识的模型/);
  });

  test("compacting frees context, writes nothing, and a message sent meanwhile waits for it", async () => {
    const h = harness({ pi: scriptedFactory("pi", 1) });
    const conv = h.group([h.bot("甲")]);
    const [member] = h.store.activeMembers(conv.id);
    await h.orch.send(conv.id, "一");
    await settle(h.store, conv.id);
    assert.equal((await h.orch.contextDetail(conv.id, member.id)).used, 15_000);
    const said = h.said(conv.id);

    await h.orch.compact(conv.id, member.id);
    assert.ok(h.pushed.some((m) => m.kind === "presence" && m.state === "compacting"));
    await assert.rejects(h.orch.compact(conv.id, member.id), /正在回复/);
    await settle(h.store, conv.id);
    assert.deepEqual(h.said(conv.id), said);
    assert.equal((await h.orch.status(conv.id)).sessions[member.id].context.used, 12_000);

    await h.orch.compact(conv.id, member.id);
    await h.orch.send(conv.id, "二");
    await settle(h.store, conv.id);
    assert.deepEqual(h.said(conv.id).slice(-2), ["用户: 二", "甲: 收到：二"]);
  });

  test("a backend with its own permission modes gets deferred calls, and its asks become cards", async () => {
    const scripted = scriptedFactory("pi", 1);
    const factory = { ...scripted, capabilities: { ...scripted.capabilities, permissionModes: true } };
    const h = harness({ pi: factory });
    // under Roster's own rules an execute tier is never asked; the backend's mode asks anyway
    const conv = h.group([h.bot("甲", { permission_tier: "execute" })]);

    await h.orch.send(conv.id, "先看再改 #read #write");
    await until(() => h.store.getConversation(conv.id).attention === "waiting_permission");
    const cards = h.store.listMessages(conv.id).filter((m) => m.card_kind === "permission");
    assert.deepEqual(cards.map((c) => JSON.parse(c.body_json).call.name), ["write"]);

    h.orch.resolvePermission(conv.id, JSON.parse(cards[0].body_json).requestId, true);
    await settle(h.store, conv.id);
    const steps = h.store
      .listMessages(conv.id)
      .filter((m) => m.card_kind === "steps")
      .flatMap((m) => JSON.parse(m.body_json).steps);
    assert.deepEqual(steps.map((s) => [s.name, s.ok]), [["read", true], ["write", true]]);
  });

  test("without permission modes of its own, a session switches tiers for itself alone, and the backend never hears of it", async () => {
    const scripted = scriptedFactory("pi", 1);
    const handed = [];
    const h = harness({
      pi: {
        ...scripted,
        create() {
          const rt = scripted.create();
          const [start, configure] = [rt.start.bind(rt), rt.configure.bind(rt)];
          rt.start = (opts) => (handed.push(opts.mode), start(opts));
          rt.configure = (settings) => (handed.push(settings.mode), configure(settings));
          return rt;
        },
      },
    });
    const pi = h.bot("Pi");
    const conv = h.group([pi]);
    const elsewhere = h.group([pi]);
    const [member] = h.store.activeMembers(conv.id);

    const { sessions, options } = await h.orch.status(conv.id);
    assert.deepEqual(options[member.id].modes.map((m) => [m.id, m.label]), [["read", "只读"], ["write", "可写"], ["execute", "可执行"]]);
    assert.equal(sessions[member.id].mode, "read", "until one is picked, the bot's tier is the session's");
    await assert.rejects(h.orch.configure(conv.id, member.id, { mode: "plan" }), /不认识的模式/);

    await h.orch.configure(conv.id, member.id, { mode: "execute" });
    assert.equal(h.pushed.findLast((m) => m.kind === "session").info.mode, "execute");
    await h.orch.send(conv.id, "改完跑一下 #write #exec");
    await settle(h.store, conv.id);
    assert.equal(h.store.listMessages(conv.id).filter((m) => m.card_kind === "permission").length, 0);
    assert.equal(h.store.getBot(pi.id).permission_tier, "read");

    await h.orch.send(elsewhere.id, "改一下 #write");
    await until(() => h.store.listMessages(elsewhere.id).some((m) => m.status === "pending"));
    const card = h.store.listMessages(elsewhere.id).find((m) => m.status === "pending");
    h.orch.resolvePermission(elsewhere.id, JSON.parse(card.body_json).requestId, false);
    await settle(h.store, elsewhere.id);

    assert.equal(handed.length, 2, "one start per conversation, and nothing to switch in place");
    assert.ok(handed.every((mode) => mode === undefined));
  });

  test("a tier switched while a call waits on you leaves that call to you, and lets the next one through", async () => {
    const h = harness({ pi: scriptedFactory("pi", 1) });
    const conv = h.group([h.bot("Pi")]);
    const [member] = h.store.activeMembers(conv.id);
    const cards = () => h.store.listMessages(conv.id).filter((m) => m.card_kind === "permission");

    await h.orch.send(conv.id, "改完跑一下 #write #exec");
    await until(() => cards().some((m) => m.status === "pending"));
    await h.orch.configure(conv.id, member.id, { mode: "execute" });
    assert.deepEqual(cards().map((c) => c.status), ["pending"]);

    h.orch.resolvePermission(conv.id, JSON.parse(cards()[0].body_json).requestId, true);
    await settle(h.store, conv.id);
    assert.deepEqual(cards().map((c) => [JSON.parse(c.body_json).call.name, c.status]), [["write", "allowed"]]);
    const steps = h.store
      .listMessages(conv.id)
      .filter((m) => m.card_kind === "steps")
      .flatMap((m) => JSON.parse(m.body_json).steps);
    assert.deepEqual(steps.map((s) => [s.name, s.ok]), [["write", true], ["bash", true]]);
  });

  test("switching only the tier keeps a live session and what it reported", async () => {
    const scripted = scriptedFactory("pi", 1);
    // like pi, a runtime that cannot switch anything in place
    const h = harness({ pi: { ...scripted, create: () => Object.assign(scripted.create(), { configure: undefined }) } });
    const conv = h.group([h.bot("Pi")]);
    const [member] = h.store.activeMembers(conv.id);
    await h.orch.send(conv.id, "一");
    await settle(h.store, conv.id);
    const before = (await h.orch.status(conv.id)).sessions[member.id];
    assert.ok(before.cache, "the cache readout only a live session has");

    await h.orch.configure(conv.id, member.id, { mode: "write" });
    assert.deepEqual(h.pushed.findLast((m) => m.kind === "session").info, { ...before, mode: "write" });
    assert.deepEqual((await h.orch.status(conv.id)).sessions[member.id], { ...before, mode: "write" });
  });

  test("a bot's new tier reaches the sessions still going by it; one that picked its own keeps it, through a sync too", async () => {
    const h = harness({ pi: scriptedFactory("pi", 1) });
    const pi = h.bot("Pi");
    const [following, picked] = [h.group([pi]), h.group([pi])].map((conv) => ({ conv, member: h.store.activeMembers(conv.id)[0] }));
    await h.orch.configure(picked.conv.id, picked.member.id, { mode: "execute" });

    const from = h.pushed.length;
    h.store.updateBot(pi.id, { permission_tier: "write" });
    h.orch.tierChanged(pi.id);
    await until(() => h.pushed.slice(from).some((m) => m.kind === "session"));
    await new Promise((r) => setTimeout(r, 30));
    const pushed = h.pushed.slice(from).filter((m) => m.kind === "session");
    assert.deepEqual(pushed.map((m) => [m.memberId, m.info.mode]), [[following.member.id, "write"]]);

    await h.orch.syncMember(picked.conv.id, picked.member.id);
    assert.deepEqual(h.store.getMember(picked.member.id).settings, { mode: "execute" });
    assert.equal((await h.orch.status(picked.conv.id)).sessions[picked.member.id].mode, "execute");
  });

  test("a steps card says what each call was about, when it ran, and where it fell in the reply", async () => {
    const bash = { id: "c1", name: "Bash", effect: "execute", input: { command: "pnpm test\n--reporter dot", description: "Run the tests" } };
    const read = { id: "c2", name: "Read", effect: "read", input: { file_path: "/repo/notes.md" } };
    const h = harness({
      pi: played([
        "先跑一下测试。",
        { start: bash },
        { gate: bash },
        { end: { id: "c1", isError: true, content: "\nError: node:sqlite is missing\n    at main" } },
        "测试挂了，看看说明。",
        { start: read },
        { gate: read },
        { end: { id: "c2", isError: false, content: "notes" } },
      ]),
    });
    const conv = h.group([h.bot("甲", { permission_tier: "execute" })]);
    await h.orch.send(conv.id, "跑测试");
    await settle(h.store, conv.id);

    const messages = h.store.listMessages(conv.id);
    const reply = JSON.parse(messages.find((m) => m.card_kind === "text" && m.author_kind === "bot").body_json).text;
    assert.equal(reply, "先跑一下测试。\n\n测试挂了，看看说明。");
    const card = messages.find((m) => m.card_kind === "steps");
    const { steps, last } = JSON.parse(card.body_json);
    assert.deepEqual(
      steps.map((s) => [s.name, s.title, s.at, s.ok, s.error]),
      [
        ["Bash", "Run the tests", "先跑一下测试。\n\n".length, false, "Error: node:sqlite is missing"],
        ["Read", "/repo/notes.md", reply.length + 2, true, undefined],
      ],
    );
    assert.equal(reply.slice(0, steps[0].at).trim(), "先跑一下测试。", "the reply splits where the call was made");
    assert.ok(steps.every((s) => s.startedAt <= s.endedAt));
    assert.ok(last > card.seq, "the card remembers the latest event it folded in");

    const detail = h.store.stepDetail(conv.id, card.turn_id, "c1");
    assert.deepEqual([detail.input, detail.output, detail.isError], [bash.input, "\nError: node:sqlite is missing\n    at main", true]);
    assert.equal(h.store.stepDetail(conv.id, card.turn_id, "nope"), null);

    const working = h.pushed.filter((m) => m.kind === "presence" && m.state !== "idle");
    assert.ok(working.length > 0 && working.every((m) => m.turnId === card.turn_id), "presence names the turn being written");
  });

  test("thinking streams as it comes, is listed among the calls where it began, and is written whole to the log", async () => {
    const read = { id: "r1", name: "Read", effect: "read", input: { file_path: "/repo/notes.md" } };
    const h = harness({
      pi: played([
        // a backend that hides its thinking still sends empty blocks; they are no thought
        { think: "" },
        { think: "  " },
        { think: "**Planning the read**\n\nThe notes " },
        { think: "decide it." },
        "先看看说明。",
        { start: read },
        { gate: read },
        { end: { id: "r1", isError: false, content: "ship it" } },
        { think: "## Notes say ship\nSo answer yes." },
        "可以发了。",
      ]),
    });
    const conv = h.group([h.bot("甲")]);
    await h.orch.send(conv.id, "能发吗");
    await settle(h.store, conv.id);

    const messages = h.store.listMessages(conv.id);
    const reply = JSON.parse(messages.find((m) => m.card_kind === "text" && m.author_kind === "bot").body_json).text;
    assert.equal(reply, "先看看说明。\n\n可以发了。", "thinking never leaks into the reply");
    const card = messages.find((m) => m.card_kind === "steps");
    const { steps } = JSON.parse(card.body_json);
    assert.deepEqual(
      steps.map((s) => [s.kind ?? "call", s.title, s.at]),
      [
        ["thought", "Planning the read", 0],
        ["call", "/repo/notes.md", "先看看说明。\n\n".length],
        ["thought", "Notes say ship", "先看看说明。\n\n".length],
      ],
    );
    assert.ok(steps.every((s) => s.startedAt <= s.endedAt), "every thought is closed when the next thing happens");

    const [first, , second] = steps;
    assert.deepEqual(h.store.thoughtDetail(conv.id, card.turn_id, first.id).text, "**Planning the read**\n\nThe notes decide it.");
    assert.equal(h.store.thoughtDetail(conv.id, card.turn_id, second.id).text, "## Notes say ship\nSo answer yes.");
    assert.equal(h.store.thoughtDetail(conv.id, card.turn_id, "nope"), null);

    const streamed = h.pushed.filter((m) => m.kind === "thinking" && m.id === first.id).map((m) => m.text).join("");
    assert.equal(streamed, "**Planning the read**\n\nThe notes decide it.", "the words went out as they came");
    assert.deepEqual(h.orch.thoughts(conv.id), {}, "nothing is mid-thought once the turn is over");
  });

  test("one member's thinking is never handed to another", async () => {
    const h = harness({ pi: played([{ think: "secret reasoning" }, "我的结论。"]) });
    const conv = h.group([h.bot("甲"), h.bot("乙")]);
    await h.orch.send(conv.id, "@甲 你先说");
    await settle(h.store, conv.id);

    const other = h.store.activeMembers(conv.id).find((m) => h.store.getBot(m.bot_id).name === "乙");
    const handed = h.store.backlog(other).items.map((i) => i.text).join("\n");
    assert.match(handed, /我的结论。/);
    assert.doesNotMatch(handed, /secret reasoning/);
  });

  test("a call the backend asks about before announcing it gets one step, placed where it asked", async () => {
    const edit = { id: "e1", name: "edit", effect: "write", input: { path: "notes.md" } };
    const h = harness({ pi: played(["我改一下。", { gate: edit }, { start: edit }, { end: { id: "e1", isError: false, content: "ok" } }, "改好了。"]) });
    const conv = h.group([h.bot("甲")]);
    await h.orch.send(conv.id, "改");
    await until(() => h.store.listMessages(conv.id).some((m) => m.status === "pending"));
    const pending = h.store.listMessages(conv.id).find((m) => m.status === "pending");
    h.orch.resolvePermission(conv.id, JSON.parse(pending.body_json).requestId, true);
    await settle(h.store, conv.id);

    const steps = h.store.listMessages(conv.id).filter((m) => m.card_kind === "steps").flatMap((m) => JSON.parse(m.body_json).steps);
    assert.deepEqual(steps.map((s) => [s.id, s.title, s.at, s.ok]), [["e1", "notes.md", "我改一下。".length, true]]);
  });

  test("a reply carries what it answers: the card keeps it apart, the bot is handed it as a quote", async () => {
    const h = harness();
    const conv = h.group([h.bot("甲")]);
    await h.orch.send(conv.id, "先说说看");
    await settle(h.store, conv.id);
    await h.orch.send(conv.id, "第二点再说细一点", [], { messageId: "m1", name: "甲", text: "这是它说过的话" });
    await settle(h.store, conv.id);

    const asked = h.store.listMessages(conv.id).filter((m) => m.author_kind === "human");
    const body = JSON.parse(asked.at(-1).body_json);
    assert.equal(body.text, "第二点再说细一点", "what was typed stays what was typed");
    assert.deepEqual(body.quote, { messageId: "m1", name: "甲", text: "这是它说过的话" });
    assert.match(h.sent.at(-1).text, /回复 甲 的这段话：\n> 这是它说过的话\n\n第二点再说细一点/);
  });

  test("plan usage is read in the background when first looked at, then served from cache", async () => {
    let reads = 0;
    const scripted = scriptedFactory("pi", 1);
    const h = harness({ pi: { ...scripted, quota: async () => (reads++, usage(10)) } });
    const conv = h.group([h.bot("甲")]);

    assert.deepEqual((await h.orch.status(conv.id)).quota, {});
    await until(() => h.pushed.some((m) => m.kind === "quota"));
    assert.deepEqual((await h.orch.status(conv.id)).quota, { pi: usage(10) });
    assert.equal(reads, 1);
  });

  test("usage is re-read once its window has reset, cache interval or not", async () => {
    let reads = 0;
    const spent = { plan: "pro", windows: [{ kind: "session", usedPercent: 40, resetsAt: Date.now() + 50 }] };
    const scripted = scriptedFactory("pi", 1);
    const h = harness({ pi: { ...scripted, quota: async () => (reads++, reads === 1 ? spent : usage(3)) } });
    const conv = h.group([h.bot("甲")]);

    await h.orch.status(conv.id);
    await until(() => h.pushed.some((m) => m.kind === "quota"));
    assert.deepEqual((await h.orch.status(conv.id)).quota, { pi: spent }, "still within the window, still cached");

    const quotas = () => h.pushed.filter((m) => m.kind === "quota").map((m) => m.quota);
    for (const end = Date.now() + 5000; Date.now() < end && quotas().length < 2; ) {
      await h.orch.status(conv.id);
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.deepEqual(quotas(), [spent, usage(3)]);
    assert.deepEqual((await h.orch.status(conv.id)).quota, { pi: usage(3) });
    assert.equal(reads, 2, "the window it answered with has not reset either");
  });

  test("a finished turn re-reads usage through its live session, at most once per interval", async () => {
    let cold = 0;
    let warm = 0;
    const scripted = scriptedFactory("pi", 1);
    const factory = {
      ...scripted,
      quota: async () => (cold++, usage(10)),
      create() {
        const rt = scripted.create();
        rt.quota = async () => (warm++, usage(20));
        return rt;
      },
    };
    const h = harness({ pi: factory });
    const conv = h.group([h.bot("甲")]);

    await h.orch.send(conv.id, "一");
    await settle(h.store, conv.id);
    await until(() => h.pushed.some((m) => m.kind === "quota"));
    await h.orch.send(conv.id, "二");
    await settle(h.store, conv.id);

    assert.deepEqual([cold, warm], [0, 1]);
    assert.deepEqual(h.pushed.filter((m) => m.kind === "quota").map((m) => m.quota), [usage(20)]);
  });
});

describe("logos", () => {
  test("every catalog entry ships an image", () => {
    assert.equal(new Set(LOGO_IDS).size, logos().length, "logo ids must be unique");
    for (const id of LOGO_IDS) {
      const file = join(LOGOS_DIR, `${id}.webp`);
      assert.ok(existsSync(file) && statSync(file).size > 0, `missing ${file}`);
    }
  });

  test("bots without a logo get the least used ones, in catalog order", () => {
    const h = harness();
    const a = h.bot("甲");
    const b = h.bot("乙", { avatar: LOGO_IDS[0] });
    const c = h.bot("丙");
    const gone = h.bot("丁", { avatar: LOGO_IDS[2] });
    h.store.archiveBot(gone.id);

    assert.equal(h.store.assignLogos(LOGO_IDS), 2);
    // the second bot already wears the first logo, and an archived bot blocks nothing
    assert.equal(h.store.getBot(a.id).avatar, LOGO_IDS[1]);
    assert.equal(h.store.getBot(c.id).avatar, LOGO_IDS[2]);
    assert.equal(h.store.getBot(b.id).avatar, LOGO_IDS[0]);
    assert.equal(h.store.assignLogos(LOGO_IDS), 0, "a second pass changes nothing");
    assert.equal(h.store.leastUsedLogo(LOGO_IDS), LOGO_IDS[3]);
    // a bot choosing again does not count its own current logo against it
    assert.equal(h.store.leastUsedLogo(LOGO_IDS.slice(0, 2), b.id), LOGO_IDS[0]);
  });
});

describe("migrations", () => {
  test("old steps cards are rebuilt from the log: titles, times, and pi's wrapped output read as text", () => {
    const dir = mkdtempSync(join(tmpdir(), "roster-steps-"));
    dirs.push(dir);
    const file = join(dir, "roster.db");
    const db = openDb(file);
    const store = new Store(db);
    store.createExecutor({ name: "pi", type: "pi-agent", source_kind: "own", provider_id: null, model: null });
    const bot = store.createBot({
      name: "Pi", title: null, avatar: null, system_prompt: null,
      executor_id: store.listExecutors()[0].id, model: null, permission_tier: "read",
    });
    const conv = store.createConversation({ title: "x", repoPath: dir, worktreePath: dir, botIds: [bot.id] });
    const [member] = store.activeMembers(conv.id);
    const event = (type, payload, at) =>
      db
        .prepare(
          `INSERT INTO events (conversation_id, member_id, turn_id, type, payload_json, surface, broadcast, created_at)
           VALUES (?, ?, 't1', ?, ?, 1, 0, ?)`,
        )
        .run(conv.id, member.id, type, JSON.stringify({ type, display: "fold", ...payload }), at);
    const wrapped = (text) => JSON.stringify({ content: [{ type: "text", text }], details: {} });
    event("tool.start", { call: { id: "b1", name: "bash", effect: "execute", input: { command: "ls -la" } } }, 1000);
    event("tool.end", { id: "b1", isError: true, content: wrapped("ls: nope") }, 1500);
    event("tool.start", { call: { id: "b2", name: "bash", effect: "execute", input: { command: "git log" } } }, 1600);
    event("tool.end", { id: "b2", isError: true, content: wrapped("=== git log ===\n\n\nCommand exited with code 128") }, 1700);
    // the card as it was written then: a name and a tick
    db.prepare(
      `INSERT INTO messages (id, conversation_id, seq, turn_id, author_kind, author_member_id, card_kind, body_json, created_at, updated_at)
       VALUES ('old', ?, 1, 't1', 'bot', ?, 'steps', ?, 1000, 1500)`,
    ).run(conv.id, member.id, JSON.stringify({ steps: [{ id: "b1", name: "bash", effect: "execute", ok: false }] }));
    const { user_version: version } = db.prepare(`PRAGMA user_version`).get();
    db.exec(`PRAGMA user_version = ${version - 1}`);
    db.close();

    const reopened = new Store(openDb(file));
    const body = JSON.parse(reopened.getMessage("old").body_json);
    assert.deepEqual(body.steps, [
      { id: "b1", name: "bash", effect: "execute", title: "ls -la", startedAt: 1000, endedAt: 1500, ok: false, error: "ls: nope" },
      // a shell's exit status says more than the first line of what it printed
      { id: "b2", name: "bash", effect: "execute", title: "git log", startedAt: 1600, endedAt: 1700, ok: false, error: "Command exited with code 128" },
    ]);
    assert.equal(reopened.stepDetail(conv.id, "t1", "b1").output, "ls: nope");
  });

  test("existing members keep their place; the event sequence skips past legacy rows", () => {
    const dir = mkdtempSync(join(tmpdir(), "roster-mig-"));
    dirs.push(dir);
    const file = join(dir, "roster.db");
    const db = openDb(file);
    const store = new Store(db);
    store.createExecutor({ name: "pi", type: "pi-agent", source_kind: "own", provider_id: null, model: null });
    const pi = store.listExecutors()[0];
    const bot = store.createBot({
      name: "Pi", title: null, avatar: null, system_prompt: null,
      executor_id: pi.id, model: null, permission_tier: "read",
    });
    const conv = store.createConversation({ title: "x", repoPath: dir, worktreePath: dir, botIds: [bot.id] });
    // simulate the pre-migration world: a legacy human row with a local seq, members at 0
    db.exec(`PRAGMA user_version = 0`);
    db.prepare(`UPDATE conversations SET last_seq = 7 WHERE id = ?`).run(conv.id);
    db.prepare(
      `INSERT INTO messages (id, conversation_id, seq, author_kind, card_kind, body_json, created_at, updated_at)
       VALUES ('legacy', ?, 50, 'human', 'text', '{"text":"old"}', 0, 0)`,
    ).run(conv.id);
    db.close();

    const reopened = new Store(openDb(file));
    assert.equal(reopened.activeMembers(conv.id)[0].delivered_seq, 7);
    const { seq } = reopened.append(conv.id, null, null, { type: "system.notice", display: "message", text: "hi" });
    assert.ok(seq > 50, `new event seq ${seq} should sort after the legacy row`);
  });

  test("a database from before executors keeps every bot and member, now on the built-in executors", () => {
    const dir = mkdtempSync(join(tmpdir(), "roster-exec-"));
    dirs.push(dir);
    const file = join(dir, "roster.db");
    // the schema as it was: bots.backend under a closed CHECK, and no executors table
    const schema = readFileSync(new URL("../dist/db/schema.sql", import.meta.url), "utf8");
    const legacy = schema.replace(
      /executor_id\s+TEXT NOT NULL REFERENCES executors\(id\),/,
      "backend TEXT NOT NULL CHECK (backend IN ('pi', 'claude')),",
    );
    assert.notEqual(legacy, schema, "the fixture must really be the old bots table");
    const raw = new DatabaseSync(file);
    raw.exec(legacy);
    raw.exec("DROP TABLE executors; PRAGMA user_version = 1;");
    const t = Date.now();
    raw
      .prepare(
        `INSERT INTO bots (id, name, title, avatar, system_prompt, backend, model, permission_tier, tools_json, created_at, updated_at)
         VALUES ('b1', 'Pi', NULL, NULL, NULL, 'pi', 'deepseek-v4-flash', 'read', '[]', ?, ?),
                ('b2', 'Claude', NULL, NULL, '写 Go', 'claude', NULL, 'write', '[]', ?, ?)`,
      )
      .run(t, t, t, t);
    raw
      .prepare(
        `INSERT INTO conversations (id, title, shape, repo_path, worktree_path, created_at, last_activity_at)
         VALUES ('c1', '老群', 'group', ?, ?, ?, ?)`,
      )
      .run(dir, dir, t, t);
    const spec = (name, backend, model) => JSON.stringify({ name, system_prompt: null, backend, model });
    raw
      .prepare(
        `INSERT INTO members (id, conversation_id, bot_id, spec_json, capabilities_json, joined_at)
         VALUES ('m1', 'c1', 'b1', ?, '{}', ?), ('m2', 'c1', 'b2', ?, '{}', ?)`,
      )
      .run(spec("Pi", "pi", "deepseek-v4-flash"), t, spec("Claude", "claude", null), t);
    raw.close();

    const store = new Store(openDb(file));
    assert.deepEqual(
      store.listExecutors().map((e) => [e.id, e.type]),
      [["claude", "claude-code"], ["pi", "pi-agent"]],
    );
    const bots = new Map(store.listBots().map((b) => [b.id, b]));
    assert.deepEqual([bots.get("b1").executor_id, bots.get("b1").model], ["pi", "deepseek-v4-flash"]);
    assert.deepEqual([bots.get("b2").executor_id, bots.get("b2").system_prompt], ["claude", "写 Go"]);
    const members = store.activeMembers("c1");
    assert.deepEqual(members.map((m) => m.spec.executor_id).sort(), ["claude", "pi"]);
    assert.ok(members.every((m) => !("backend" in m.spec)), "the old key is gone from every snapshot");
    assert.ok(existsSync(`${file}.bak-v2`), "the database from before is kept aside");
    // the old CHECK is gone, and what replaced it is a real reference
    assert.throws(() =>
      store.createBot({
        name: "幽灵", title: null, avatar: null, system_prompt: null,
        executor_id: "nowhere", model: null, permission_tier: "read",
      }),
    );
  });

  test("an endpoint bound to an executor, then named by its bots, ends up bound to the executor again", () => {
    const dir = mkdtempSync(join(tmpdir(), "roster-src-"));
    dirs.push(dir);
    const file = join(dir, "roster.db");
    const db = openDb(file);
    const store = new Store(db);
    const executor = store.createExecutor({ name: "乙", type: "beta", source_kind: "own", provider_id: null, model: null });
    const provider = store.createProvider({ name: "DS", preset: "deepseek", api: null, base_url: null, models: [], headers: {}, key_env: null, secret_ref: null });
    const bot = store.createBot({ name: "甲", title: null, avatar: null, system_prompt: null, executor_id: executor.id, model: "m", permission_tier: "read" });
    const conv = store.createConversation({ title: "t", repoPath: dir, worktreePath: dir, botIds: [bot.id] });
    // the database as it was: the binding on the executor, nothing on the bot or its member
    db.prepare(`UPDATE executors SET provider_ids_json = ? WHERE id = ?`).run(JSON.stringify([provider.id]), executor.id);
    db.exec("PRAGMA user_version = 2");
    db.close();

    const reopened = new Store(openDb(file));
    const bound = reopened.getExecutor(executor.id);
    assert.deepEqual([bound.source_kind, bound.provider_id, bound.name], ["endpoint", provider.id, "乙 · DS"]);
    assert.equal(reopened.getBot(bot.id).executor_id, executor.id);
    assert.ok(!("model_source" in reopened.activeMembers(conv.id)[0].spec), "the snapshot names only the executor now");
    assert.equal(reopened.listConversations()[0].members[0].stale, false, "the member ran on that endpoint all along");
  });

  test("every pairing in use becomes an executor, identical ones merge, and the program moves to its type", () => {
    const dir = mkdtempSync(join(tmpdir(), "roster-bind-"));
    dirs.push(dir);
    const file = join(dir, "roster.db");
    const db = openDb(file);
    const store = new Store(db);
    const provider = store.createProvider({ name: "官方", preset: "anthropic", api: null, base_url: null, models: [], headers: {}, key_env: null, secret_ref: null });
    const own = store.createExecutor({ name: "Claude Code", type: "claude-code", source_kind: "own", provider_id: null, model: null });
    const extra = store.createExecutor({ name: "Claude Code 2", type: "claude-code", source_kind: "own", provider_id: null, model: null });
    const idle = store.createExecutor({ name: "Codex", type: "codex", source_kind: "own", provider_id: null, model: null });
    const bot = (name, executorId) =>
      store.createBot({ name, title: null, avatar: null, system_prompt: null, executor_id: executorId, model: null, permission_tier: "read" });
    const a = bot("甲", own.id);
    const b = bot("乙", own.id);
    const c = bot("丙", extra.id);
    const conv = store.createConversation({ title: "t", repoPath: dir, worktreePath: dir, botIds: [b.id] });
    const [member] = store.activeMembers(conv.id);
    // creation order decides which executor is the type's own and which pairing keeps the old row, so it is spelled out
    [own, extra, idle].forEach((e, i) => db.prepare(`UPDATE executors SET created_at = ? WHERE id = ?`).run(i + 1, e.id));
    [a, b, c].forEach((x, i) => db.prepare(`UPDATE bots SET created_at = ? WHERE id = ?`).run(i + 1, x.id));
    db.prepare(`UPDATE members SET joined_at = 9 WHERE id = ?`).run(member.id);
    // the database as it was: programs on executors, sources on bots, and a member switched to another source mid-conversation
    db.prepare(`UPDATE executors SET config_json = ? WHERE id = ?`).run(JSON.stringify({ executable: "/opt/claude" }), own.id);
    db.prepare(`UPDATE executors SET config_json = ? WHERE id = ?`).run(JSON.stringify({ executable: "/opt/claude-beta" }), extra.id);
    db.prepare(`UPDATE bots SET model_source = ? WHERE id = ?`).run(provider.id, b.id);
    db.prepare(`UPDATE members SET spec_json = json_set(spec_json, '$.model_source', ?), settings_json = ?, resume_token = 'tok', delivered_seq = 3 WHERE id = ?`).run(
      provider.id,
      JSON.stringify({ source: null, model: "opus", effort: "high" }),
      member.id,
    );
    db.exec("PRAGMA user_version = 3");
    db.close();

    const reopened = new Store(openDb(file));
    assert.equal(reopened.harnessProgram("claude-code"), "/opt/claude", "the oldest executor spoke for its type");
    const live = reopened.listExecutors();
    assert.deepEqual(
      live.map((e) => [e.name, e.source_kind, e.provider_id]).sort(),
      [["Claude Code · 官方", "endpoint", provider.id], ["Claude Code · 订阅", "own", null]],
    );
    const onProvider = live.find((e) => e.provider_id === provider.id);
    assert.equal(reopened.getBot(a.id).executor_id, own.id);
    assert.equal(reopened.getBot(b.id).executor_id, onProvider.id);
    assert.equal(reopened.getBot(c.id).executor_id, own.id, "the extra setup on the same sign-in merged into the first");
    assert.ok(reopened.getExecutor(extra.id).archived_at && reopened.getExecutor(idle.id).archived_at, "nothing runs on them any more");

    const [moved] = reopened.activeMembers(conv.id);
    assert.equal(moved.spec.executor_id, onProvider.id);
    assert.deepEqual(moved.settings, {}, "picks made for the other source went with it");
    assert.equal(moved.delivered_seq, 0, "a new backend session is owed the backlog");
    assert.equal(reopened.getResumeToken(member.id), undefined);
    assert.equal(reopened.listConversations()[0].members[0].stale, false);
    assert.ok(existsSync(`${file}.bak-v4`));
  });
});

/** A harness type that runs on scripts but reports what source and program it was handed, so tests can see what reached it. */
function fakeHarness(type, { own = false, apis = ["openai-completions"], presets = [] } = {}) {
  const caps = { interceptToolCall: true, mutateToolInput: false, midRunInject: [], costLimit: false, mcp: false, branch: false, permissionModes: false };
  return {
    type,
    label: type,
    sources: { own, apis },
    capabilities: () => caps,
    presets: async () => presets,
    create: (instance) => {
      if (instance.source.kind === "own" && !own) throw new Error(`${type} 没有自带登录`);
      return {
        ...scriptedFactory(instance.id, 1, instance.label),
        type,
        check: async () => ({
          ok: true,
          detail: instance.source.kind === "endpoint" ? (instance.source.endpoint.apiKey ?? "none") : `own:${instance.program ?? ""}`,
        }),
      };
    },
    ...(own ? { login: async (program) => ({ state: "ok", account: `acct:${program ?? ""}`, methods: [] }) } : {}),
  };
}

/** deepseekUrl is where the deepseek preset's API answers, for tests that ask it what it lists. */
function settingsHarness(vault = { key: randomBytes(32), keystore: "keychain" }, { deepseekUrl } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "roster-settings-"));
  dirs.push(dir);
  const db = openDb(join(dir, "roster.db"));
  const store = new Store(db);
  const secrets = new Secrets(db, vault);
  const types = [
    fakeHarness("alpha", {
      own: true,
      apis: ["anthropic-messages"],
      presets: [{ id: "anthropic", label: "Anthropic", api: "anthropic-messages" }],
    }),
    fakeHarness("beta", {
      presets: [{ id: "deepseek", label: "DeepSeek", api: "openai-completions", ...(deepseekUrl ? { baseUrl: deepseekUrl } : {}) }],
    }),
  ];
  const programOf = (type) => store.harnessProgram(type) ?? undefined;
  const build = () =>
    Registry.from(types, store.listExecutors(), (row, type) => ({
      id: row.id,
      label: row.name,
      source: sourceOf(row, store, secrets),
      program: programOf(type.type),
    }));
  let registry = build();
  const settings = new ExecutorSettings(
    store,
    secrets,
    () => types,
    () => registry,
    () => {
      registry = build();
      orch.useRegistry(registry);
    },
    programOf,
  );
  const sources = new Sources(store, secrets, () => registry, (t) => settings.presets(t));
  const orch = new Orchestrator(store, () => {}, registry, sources);
  const bot = (name, executor_id) =>
    store.createBot({ name, title: null, avatar: null, system_prompt: null, executor_id, model: null, permission_tier: "read" });
  return { db, store, secrets, settings, sources, orch, registry: () => registry, bot, dir };
}

describe("executors and providers", () => {
  test("a key is sealed at rest, shown only as a hint, and reaches the executor in memory", async () => {
    const h = settingsHarness();
    const provider = await h.settings.createProvider({ name: "官方", preset: "deepseek", key: "sk-secret-value-123456" });
    assert.deepEqual(provider.key, { source: "stored", set: true, hint: "sk-…3456" });
    assert.ok(!JSON.stringify(await h.settings.view()).includes("secret-value"), "nothing the UI reads carries the key");
    const row = h.db.prepare("SELECT alg, data FROM secrets").get();
    assert.equal(row.alg, "aes-256-gcm");
    assert.ok(!Buffer.from(row.data).toString("utf8").includes("secret-value"), "the row holds ciphertext");

    const executor = await h.settings.createExecutor({ type: "beta", source_kind: "endpoint", provider_id: provider.id });
    assert.equal(executor.name, "beta · 官方", "named after its type and source when nobody names it");
    // the executor names the endpoint, and is built with it, key and all
    assert.equal(sourceOf(executor, h.store, h.secrets).endpoint.apiKey, "sk-secret-value-123456");
    assert.equal((await h.registry().get(executor.id).check()).detail, "sk-secret-value-123456");
  });

  test("with nothing to seal with a key is kept plain and says so, and is sealed once a key arrives", () => {
    const h = settingsHarness(NO_VAULT);
    assert.equal(h.secrets.encrypted, false);
    const ref = h.secrets.put("plain-key-000000");
    assert.equal(h.db.prepare("SELECT alg FROM secrets WHERE ref = ?").get(ref).alg, "plain");

    const sealed = new Secrets(h.db, { key: randomBytes(32), keystore: "dpapi" });
    assert.equal(sealed.sealPlain(), 1);
    assert.equal(h.db.prepare("SELECT alg FROM secrets WHERE ref = ?").get(ref).alg, "aes-256-gcm");
    assert.equal(sealed.get(ref), "plain-key-000000");
    // a key sealed under another machine's key reads as missing, not as garbage
    assert.equal(new Secrets(h.db, { key: randomBytes(32), keystore: "dpapi" }).get(ref), undefined);
  });

  test("moving a provider marks members on it stale; a new key does not", async () => {
    const h = settingsHarness();
    const provider = await h.settings.createProvider({
      name: "网关",
      preset: "custom",
      api: "openai-completions",
      base_url: "https://a.example/v1",
      models: ["m1"],
      key: "k1-aaaaaaaaaaaa",
    });
    const executor = await h.settings.createExecutor({ type: "beta", source_kind: "endpoint", provider_id: provider.id });
    const conv = h.store.createConversation({ title: "t", repoPath: h.dir, worktreePath: h.dir, botIds: [h.bot("甲", executor.id).id] });
    const stale = () => h.store.listConversations().find((c) => c.id === conv.id).members[0].stale;

    assert.equal(stale(), false);
    await h.settings.updateProvider(provider.id, { key: "k2-bbbbbbbbbbbb" });
    assert.equal(stale(), false, "a rotated key reaches the next session with nothing to re-sync");
    await h.settings.updateProvider(provider.id, { base_url: "https://b.example/v1" });
    assert.equal(stale(), true);
  });

  test("a longer prompt cache is a setting of the agent, off unless asked, and no reason to re-sync", async () => {
    const h = settingsHarness();
    const provider = await h.settings.createProvider({ name: "官方", preset: "deepseek", key: "sk-secret-value-123456" });
    const executor = await h.settings.createExecutor({ type: "beta", source_kind: "endpoint", provider_id: provider.id });
    assert.equal(executor.long_cache, 0);
    const conv = h.store.createConversation({ title: "t", repoPath: h.dir, worktreePath: h.dir, botIds: [h.bot("甲", executor.id).id] });
    const stale = () => h.store.listConversations().find((c) => c.id === conv.id).members[0].stale;

    const on = await h.settings.updateExecutor(executor.id, { long_cache: true });
    assert.equal(on.long_cache, 1);
    assert.equal(on.rev, executor.rev, "the cache lifetime is not part of the setup members snapshot");
    assert.equal(stale(), false);
    // a save that says nothing about it keeps it
    assert.equal((await h.settings.updateExecutor(executor.id, { name: "改名" })).long_cache, 1);
    assert.equal((await h.settings.updateExecutor(executor.id, { long_cache: false })).long_cache, 0);
  });

  test("an executor's source has to fit its type, a type signs in once, and what is in use cannot be deleted", async () => {
    const h = settingsHarness();
    const provider = await h.settings.createProvider({ name: "DS", preset: "deepseek", key: "sk-xxxxxxxxxxxxxx" });
    const rejects = (body, pattern) => assert.rejects(h.settings.createExecutor(body), (err) => err instanceof Rejection && pattern.test(err.message));
    await rejects({ type: "alpha", source_kind: "endpoint", provider_id: provider.id }, /协议对不上/);
    // beta has no sign-in of its own, so it has to run on an endpoint; alpha brings one
    await rejects({ type: "beta", source_kind: "own" }, /没有自带登录/);
    await rejects({ type: "beta", source_kind: "endpoint" }, /选一个模型 API/);
    const alpha = await h.settings.createExecutor({ type: "alpha", source_kind: "own" });
    assert.equal(alpha.name, "alpha · 订阅");
    await rejects({ type: "alpha", source_kind: "own", name: "另一个" }, /订阅已经有 agent 了/);
    const beta = await h.settings.createExecutor({ type: "beta", source_kind: "endpoint", provider_id: provider.id });
    // the type is not a setting: another type is another executor
    const moved = await h.settings.updateExecutor(beta.id, { type: "alpha", model: "ds-pro" });
    assert.deepEqual([moved.type, moved.model, moved.rev], ["beta", "ds-pro", 2]);

    // the models a bot picks from are its executor's, and only those: the agent's own, or what its model API listed
    h.store.setListedModels(provider.id, ["ds-flash", "ds-pro"]);
    assert.deepEqual((await h.sources.models(alpha.id)).map((m) => m.id), ["scripted", "scripted-plain"]);
    assert.deepEqual((await h.sources.models(beta.id)).map((m) => m.id), ["ds-flash", "ds-pro"]);

    const bot = h.bot("乙", beta.id);
    assert.throws(() => h.settings.deleteProvider(provider.id), (err) => err instanceof Rejection && err.status === 409);
    assert.throws(() => h.settings.deleteExecutor(beta.id), (err) => err instanceof Rejection && /bot 在用/.test(err.message));
    // a member still running on it holds it too, after its bot is gone
    const conv = h.store.createConversation({ title: "t", repoPath: h.dir, worktreePath: h.dir, botIds: [bot.id] });
    h.store.archiveBot(bot.id);
    assert.throws(() => h.settings.deleteExecutor(beta.id), (err) => err instanceof Rejection && /会话里的成员/.test(err.message));
    h.store.leaveMember(h.store.activeMembers(conv.id)[0].id);
    h.settings.deleteExecutor(beta.id);
    h.settings.deleteProvider(provider.id);
  });

  test("an agent on a sign-in its harness does not have moves, with its bots and present members, into the harness's one agent on a model API", async () => {
    const h = settingsHarness();
    const ds = await h.settings.createProvider({ name: "DS", preset: "deepseek", key: "sk-xxxxxxxxxxxxxx" });
    const onApi = await h.settings.createExecutor({ type: "beta", source_kind: "endpoint", provider_id: ds.id });
    const alpha = await h.settings.createExecutor({ type: "alpha", source_kind: "own" });
    // what older data left behind: beta has no sign-in of its own
    const stray = h.store.createExecutor({ name: "beta · 订阅", type: "beta", source_kind: "own", provider_id: null, model: null });
    const bot = h.bot("甲", stray.id);
    const retired = h.bot("乙", stray.id);
    h.store.archiveBot(retired.id);
    const open = h.store.createConversation({ title: "t", repoPath: h.dir, worktreePath: h.dir, botIds: [bot.id] });
    const [present] = h.store.activeMembers(open.id);
    h.store.setResumeToken(present.id, "tok");
    h.store.setDelivered(present.id, 3);
    const earlier = h.store.createConversation({ title: "t2", repoPath: h.dir, worktreePath: h.dir, botIds: [bot.id] });
    const [left] = h.store.activeMembers(earlier.id);
    h.store.leaveMember(left.id);

    assert.equal(h.settings.mergeStrayOwn(), 1);
    assert.ok(h.store.getExecutor(stray.id).archived_at);
    assert.ok(h.orch.executors().every((e) => e.id !== stray.id));
    assert.deepEqual([h.store.getBot(bot.id).executor_id, h.store.getBot(retired.id).executor_id], [onApi.id, stray.id], "an archived bot stays where it was");
    const moved = h.store.getMember(present.id);
    assert.deepEqual([moved.spec.executor_id, moved.delivered_seq, h.store.getResumeToken(present.id)], [onApi.id, 0, undefined], "a fresh session there, owed the backlog");
    assert.equal(h.store.listConversations().find((c) => c.id === open.id).members[0].stale, false);
    assert.equal(h.store.getMember(left.id).spec.executor_id, stray.id, "one that left still says what it ran on");
    assert.equal(h.store.getExecutor(alpha.id).archived_at, null, "a harness with a sign-in keeps its agent on it");

    // with two agents on model APIs to choose between, nothing is guessed
    const gateway = await h.settings.createProvider({
      name: "网关",
      preset: "custom",
      api: "openai-completions",
      base_url: "https://a.example/v1",
      models: ["m1"],
      key: "k1-aaaaaaaaaaaa",
    });
    await h.settings.createExecutor({ type: "beta", source_kind: "endpoint", provider_id: gateway.id });
    const undecided = h.store.createExecutor({ name: "beta · 订阅", type: "beta", source_kind: "own", provider_id: null, model: null });
    assert.equal(h.settings.mergeStrayOwn(), 0);
    assert.equal(h.store.getExecutor(undecided.id).archived_at, null);
  });

  test("a name that only said an agent's pairing follows a new source, and one a person chose stays", async () => {
    const h = settingsHarness();
    const official = await h.settings.createProvider({ name: "官方", preset: "anthropic", key: "sk-aaaaaaaaaaaaaaaa" });
    const agent = await h.settings.createExecutor({ type: "alpha", source_kind: "own" });
    const onApi = await h.settings.updateExecutor(agent.id, { name: agent.name, source_kind: "endpoint", provider_id: official.id });
    assert.equal(onApi.name, "alpha · 官方");
    assert.equal((await h.settings.updateExecutor(agent.id, { name: "我的 alpha", source_kind: "own" })).name, "我的 alpha");
    assert.equal((await h.settings.updateExecutor(agent.id, { name: "我的 alpha", source_kind: "endpoint", provider_id: official.id })).name, "我的 alpha");
  });

  test("an executor added while the app runs is there for the very next lookup, and one that cannot run says why", async () => {
    const h = settingsHarness();
    const provider = await h.settings.createProvider({ name: "DS", preset: "deepseek", key: "sk-xxxxxxxxxxxxxx" });
    const executor = await h.settings.createExecutor({ name: "新 agent", type: "beta", source_kind: "endpoint", provider_id: provider.id });
    assert.equal(h.orch.capabilities()[executor.id].interceptToolCall, true);
    const listed = () => h.orch.executors().find((e) => e.id === executor.id);
    assert.deepEqual(
      [listed().type, listed().label, listed().source_kind, listed().provider_id, listed().problem],
      ["beta", "新 agent", "endpoint", provider.id, null],
    );

    // pulled out from under it, bypassing the in-use check: the next rebuild leaves it out, with the reason
    h.store.archiveProvider(provider.id);
    h.settings.setProgram("beta", {});
    assert.ok(!(executor.id in h.orch.capabilities()));
    assert.match(listed().problem, /模型 API 已经删除/);
    assert.match((await h.settings.check(executor.id)).items[0].detail, /模型 API 已经删除/);
  });

  test("pairings nobody has made yet are offered, and a type's program and sign-in are the type's", async () => {
    const h = settingsHarness();
    const official = await h.settings.createProvider({ name: "官方", preset: "anthropic", key: "sk-aaaaaaaaaaaaaaaa" });
    const ds = await h.settings.createProvider({ name: "DS", preset: "deepseek", key: "sk-xxxxxxxxxxxxxx" });
    const offered = async () => (await h.settings.candidates()).map((c) => [c.type, c.source_kind, c.provider_id, c.name]);
    assert.deepEqual(await offered(), [
      ["alpha", "own", null, "alpha · 订阅"],
      ["alpha", "endpoint", official.id, "alpha · 官方"],
      ["beta", "endpoint", ds.id, "beta · DS"],
    ]);
    const alpha = await h.settings.createExecutor({ type: "alpha", source_kind: "own" });
    assert.deepEqual((await offered()).map((c) => c[3]), ["alpha · 官方", "beta · DS"]);

    // the program is set once for the type, and every executor of it is rebuilt with it
    h.settings.setProgram("alpha", { program: "/opt/alpha" });
    assert.equal((await h.settings.login("alpha", true)).account, "acct:/opt/alpha");
    const check = await h.settings.check(alpha.id);
    assert.deepEqual(check.items.map((i) => [i.label, i.ok, i.detail]), [
      ["订阅", true, "已登录（acct:/opt/alpha）"],
      ["alpha", true, "own:/opt/alpha"],
    ]);
    h.store.setListedModels(ds.id, ["ds-flash", "ds-pro"]);
    assert.deepEqual((await h.settings.draftModels("beta", ds.id)).map((m) => m.id), ["ds-flash", "ds-pro"]);
    assert.equal((await h.settings.login("beta")).state, "none", "beta has no sign-in of its own");
  });

  test("a preset serves exactly what its API lists: a check replaces the list, a save keeps it, a custom list stays the person's", async () => {
    let listed = ["deepseek-v4-pro", "deepseek-flash"];
    const server = createServer((req, res) => {
      if (req.headers.authorization !== "Bearer sk-xxxxxxxxxxxxxx") return res.writeHead(401).end();
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: listed.map((id) => ({ id })) }));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const url = `http://127.0.0.1:${server.address().port}`;
      const h = settingsHarness(undefined, { deepseekUrl: url });
      const provider = await h.settings.createProvider({ name: "DS", preset: "deepseek", key: "sk-xxxxxxxxxxxxxx" });
      const executor = await h.settings.createExecutor({ type: "beta", source_kind: "endpoint", provider_id: provider.id });
      const conv = h.store.createConversation({ title: "t", repoPath: h.dir, worktreePath: h.dir, botIds: [h.bot("甲", executor.id).id] });
      const models = () => h.store.getProvider(provider.id).models;
      const stale = () => h.store.listConversations().find((c) => c.id === conv.id).members[0].stale;
      assert.deepEqual(models(), [], "nothing is offered before the API has been asked");

      const first = await h.settings.checkProvider(provider.id);
      assert.deepEqual([first.check.ok, first.check.models, first.relisted], [true, ["deepseek-flash", "deepseek-v4-pro"], true]);
      assert.deepEqual((await h.sources.models(executor.id)).map((m) => [m.id, m.available]), [["deepseek-flash", true], ["deepseek-v4-pro", true]]);

      listed = ["deepseek-flash", "deepseek-v4-pro", "deepseek-flash"];
      assert.equal((await h.settings.checkProvider(provider.id)).relisted, false, "the same ids in another order are the same list");
      listed = ["deepseek-v4-pro"];
      assert.equal((await h.settings.checkProvider(provider.id)).relisted, true);
      assert.deepEqual(models(), ["deepseek-v4-pro"], "a model the API stopped listing is not offered");
      assert.equal(stale(), false, "a fresh list is not a new setup");

      await h.settings.updateProvider(provider.id, { name: "DeepSeek", key: "sk-refused-00000000" });
      assert.deepEqual(models(), ["deepseek-v4-pro"], "a save leaves the listed models alone");
      const refused = await h.settings.checkProvider(provider.id);
      assert.deepEqual([refused.check.ok, refused.relisted, models()], [false, false, ["deepseek-v4-pro"]], "a check that lists nothing keeps the last list");

      await h.settings.updateProvider(provider.id, { key: "sk-xxxxxxxxxxxxxx" });
      listed = ["deepseek-flash", "deepseek-v4-pro"];
      assert.equal(await h.settings.refreshModels(), true, "a start asks every preset again");
      assert.deepEqual(models(), ["deepseek-flash", "deepseek-v4-pro"]);

      const custom = await h.settings.createProvider({
        name: "网关",
        preset: "custom",
        api: "openai-completions",
        base_url: url,
        models: ["m1"],
        key: "sk-xxxxxxxxxxxxxx",
      });
      const customCheck = await h.settings.checkProvider(custom.id);
      assert.deepEqual([customCheck.check.models, customCheck.relisted], [["deepseek-flash", "deepseek-v4-pro"], false]);
      assert.deepEqual(h.store.getProvider(custom.id).models, ["m1"], "a custom endpoint keeps the list a person gave it");
    } finally {
      server.close();
    }
  });

  test("a check brings back the ids the endpoint listed, each once and sorted, in one page", async () => {
    const server = createServer((req, res) => {
      if (req.headers.authorization !== "Bearer good") return res.writeHead(401).end();
      const onePage = !req.url.startsWith("/anthropic/") || req.url === "/anthropic/v1/models?limit=1000";
      res.writeHead(onePage ? 200 : 400, { "content-type": "application/json" }).end(JSON.stringify({ data: [{ id: "b" }, { id: "a" }, { id: "b" }] }));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const base = `http://127.0.0.1:${server.address().port}`;
      const endpoint = { id: "x", name: "x", preset: "custom", api: "openai-completions", baseUrl: `${base}/v1` };
      assert.deepEqual(await checkEndpoint({ ...endpoint, apiKey: "good" }), { ok: true, detail: "连上了，API 列出 2 个模型", models: ["a", "b"] });
      assert.deepEqual(await checkEndpoint({ ...endpoint, apiKey: "bad" }), { ok: false, detail: "密钥被拒绝（401）" });
      // Anthropic's list pages at 20 unless asked for more
      const anthropic = { ...endpoint, api: "anthropic-messages", baseUrl: `${base}/anthropic`, apiKey: "good" };
      assert.deepEqual((await checkEndpoint(anthropic)).models, ["a", "b"]);
    } finally {
      server.close();
    }
  });

  test("a rebuild after startup is reported as stale, until the process restarts", () => {
    const dir = mkdtempSync(join(tmpdir(), "roster-about-"));
    dirs.push(dir);
    writeFileSync(join(dir, "main.js"), "");
    writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "1.2.3" }));
    const paths = { data: dir, agents: dir, attachments: dir, extensions: dir };
    const read = aboutReader({ packageJson: join(dir, "package.json"), fromSource: true, codeDirs: [dir, join(dir, "missing")], paths });
    assert.equal(read().version, "1.2.3");
    assert.equal(read().stale, false, "a directory that does not exist is skipped");
    // a later build rewrites the file with a newer time
    const later = new Date(Date.now() + 60_000);
    utimesSync(join(dir, "main.js"), later, later);
    assert.equal(read().stale, true);
    // a fresh start stamps the new build
    assert.equal(aboutReader({ packageJson: join(dir, "package.json"), fromSource: true, codeDirs: [dir], paths })().stale, false);
  });

  test("a pasted key reaches pi as itself, never as a command or a variable", () => {
    assert.equal(literal("!rm -rf ~"), "$!rm -rf ~");
    assert.equal(literal("sk-a$HOME$b"), "sk-a$$HOME$$b");
    assert.equal(literal("sk-plain"), "sk-plain");
  });

  test("pi offers only the ids its model API listed, and runs one named by hand that pi has never heard of", async () => {
    const endpoint = { id: "p1", name: "DS", preset: "deepseek", apiKey: "sk-test", models: ["deepseek-flash", "deepseek-v4-pro"] };
    const factory = piHarness.create({ id: "e1", label: "pi", source: { kind: "endpoint", endpoint } });
    assert.deepEqual(
      (await factory.sessionOptions()).models.map((m) => [m.id, m.resolved, m.label]),
      [
        ["deepseek-flash", "deepseek/deepseek-flash", "deepseek-flash"],
        ["deepseek-v4-pro", "deepseek/deepseek-v4-pro", "deepseek-v4-pro"],
      ],
    );
    assert.deepEqual(await factory.sessionInfo({}), { model: "deepseek/deepseek-flash", modelLabel: "deepseek-flash", effort: null }, "nothing picked runs the first listed");
    assert.deepEqual(await factory.sessionInfo({ model: "deepseek/typed-by-hand" }), { model: "deepseek/typed-by-hand", modelLabel: "typed-by-hand", effort: null });
    const deepseek = (await piHarness.presets()).find((p) => p.id === "deepseek");
    assert.deepEqual([deepseek.api, "models" in deepseek], ["openai-completions", false], "a preset says where to call, not what it serves");
  });
});

/** A root with three extensions: code, ACP with a fake agent, and one written for another contract. */
function extensionRoot() {
  const root = mkdtempSync(join(tmpdir(), "roster-ext-"));
  dirs.push(root);
  const pkg = (name, manifest, files = {}) => {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: `@test/${name}`, version: "1.2.3", type: "module", roster: manifest }));
    for (const [file, text] of Object.entries(files)) writeFileSync(join(dir, file), text);
    return dir;
  };
  pkg("code", { api: 2, entry: "./index.js" }, {
    "index.js": `export const harness = { type: "coded", label: "Coded", sources: { own: false, apis: ["openai-completions"] }, capabilities: () => ({}), create: () => ({}) };`,
  });
  const acp = pkg("agent", { api: 2, type: "fake", label: "Fake Agent", acp: { command: ["node", "./agent.mjs"] } });
  copyFileSync(fileURLToPath(new URL("./fixtures/acp-agent.mjs", import.meta.url)), join(acp, "agent.mjs"));
  pkg("old", { api: 1, entry: "./index.js" }, { "index.js": "export const harness = {};" });
  pkg("broken", { api: 2, type: "gone", acp: { command: ["node", "some-package/bin/agent.js"] } });
  return root;
}

/** A program that updates itself the way grok does: `update --check --json` says what is out, `update` fetches it. */
function selfUpdatingProgram() {
  const dir = mkdtempSync(join(tmpdir(), "roster-updater-"));
  dirs.push(dir);
  const file = join(dir, "agent");
  writeFileSync(
    file,
    `#!/usr/bin/env node
const { existsSync, readFileSync, writeFileSync } = require("node:fs");
const kept = require("node:path").join(__dirname, "version");
const version = existsSync(kept) ? readFileSync(kept, "utf8") : "1.0.0";
const [first, ...rest] = process.argv.slice(2);
if (first === "--version") console.log("agent " + version);
else if (first === "update" && rest.includes("--check")) {
  console.log(JSON.stringify({ currentVersion: version, latestVersion: "1.1.0", updateAvailable: version !== "1.1.0", error: null }));
} else if (first === "update") {
  if (process.env.FAKE_UPDATE_FAIL === "1") {
    console.error("\\x1b[31mdownload failed\\x1b[0m");
    process.exit(3);
  }
  process.stdout.write("Downloading 10%\\rDownloading 100%\\n");
  writeFileSync(kept, "1.1.0");
  console.log("\\x1b[32mUpdated to 1.1.0\\x1b[0m");
}
`,
    { mode: 0o755 },
  );
  return file;
}

/** A root holding just the fake agent, with whatever else its ACP block says. */
function fakeAgentRoot(acp) {
  const root = mkdtempSync(join(tmpdir(), "roster-ext-"));
  dirs.push(root);
  const dir = join(root, "agent");
  mkdirSync(dir);
  const manifest = { api: 2, type: "fake", label: "Fake Agent", acp: { command: ["node", "./agent.mjs"], ...acp } };
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@test/agent", version: "1.2.3", type: "module", roster: manifest }));
  copyFileSync(fileURLToPath(new URL("./fixtures/acp-agent.mjs", import.meta.url)), join(dir, "agent.mjs"));
  return root;
}

/** One turn on a fresh runtime: what it said, and the token to resume it by. */
async function oneTurn(factory, opts, text) {
  const runtime = factory.create();
  let said = "";
  let ended = false;
  runtime.subscribe((e) => {
    if (e.type === "assistant.text") said += e.delta;
    if (e.type === "turn.end") ended = true;
  });
  try {
    await runtime.start(opts);
    await runtime.send(text);
    await until(() => ended, 15_000);
    return { said, token: runtime.resumeToken };
  } finally {
    await runtime.dispose();
  }
}

describe("extensions", () => {
  test("a harness says which version it runs, whether a program Roster fetched or the library its adapter carries", async () => {
    const root = mkdtempSync(join(tmpdir(), "roster-harnesses-"));
    dirs.push(root);
    const lib = join(root, "extensions", "lib");
    mkdirSync(lib, { recursive: true });
    writeFileSync(join(lib, "package.json"), JSON.stringify({ name: "@test/lib", version: "0.0.1", type: "module", roster: { api: 2, entry: "./index.js" } }));
    writeFileSync(
      join(lib, "index.js"),
      `export const harness = { type: "lib", label: "Lib", version: "9.9.9", sources: { own: false, apis: [] }, capabilities: () => ({}), create: () => ({}) };`,
    );
    const extensions = new Extensions([{ dir: join(root, "extensions"), origin: "linked" }]);
    await extensions.load();
    const cli = join(root, "agents", "prog", "node_modules", "@test", "prog-cli");
    mkdirSync(cli, { recursive: true });
    writeFileSync(join(cli, "package.json"), JSON.stringify({ name: "@test/prog-cli", version: "0.16.0", bin: { prog: "cli.js" } }));
    writeFileSync(join(cli, "cli.js"), "");
    const catalog = [
      { id: "prog", label: "Prog", description: "", program: { npm: "@test/prog-cli", bin: "prog" } },
      { id: "lib", label: "Lib", description: "" },
    ];
    const harnesses = new Harnesses(catalog, extensions, new Detector(catalog, ""), new Installer(join(root, "extensions"), join(root, "agents"), () => {}));
    assert.deepEqual([harnesses.state("prog").version, harnesses.state("prog").usable], ["0.16.0", true]);
    assert.deepEqual([harnesses.state("lib").needed, harnesses.state("lib").version], [false, "9.9.9"]);
    assert.match(piHarness.version, /^\d+\.\d+/, "pi says which version of its library it carries");
  });

  test("a root is scanned: code exports a type, a manifest becomes an ACP type, the rest say why not", async () => {
    const ext = new Extensions([{ dir: extensionRoot(), origin: "linked" }]);
    const loaded = await ext.load();
    const byName = Object.fromEntries(loaded.map((e) => [e.name, e]));
    assert.equal(byName["@test/code"].type, "coded");
    assert.equal(byName["@test/agent"].type, "fake");
    assert.equal(byName["@test/agent"].label, "Fake Agent");
    assert.match(byName["@test/old"].error, /契约 v1/);
    assert.match(byName["@test/broken"].error, /some-package/);
    assert.deepEqual(ext.types().map((t) => t.type).sort(), ["coded", "fake"]);
    const fake = ext.types().find((t) => t.type === "fake");
    assert.deepEqual(fake.sources, { own: true, apis: [] });
    assert.equal(fake.capabilities("own").interceptToolCall, false, "over ACP the host only sees what the agent asks about");
  });

  test("an ACP agent runs a conversation: text, a gated edit, usage, a model switch, images, commands, and its sign-in", async () => {
    const ext = new Extensions([{ dir: extensionRoot(), origin: "linked" }]);
    await ext.load();
    const dir = mkdtempSync(join(tmpdir(), "roster-acp-"));
    dirs.push(dir);
    const db = openDb(join(dir, "roster.db"));
    const store = new Store(db);
    const secrets = new Secrets(db, NO_VAULT);
    const executor = store.createExecutor({ name: "假 agent", type: "fake", source_kind: "own", provider_id: null, model: null });
    const registry = Registry.from(ext.types(), store.listExecutors(), (row) => ({ id: row.id, label: row.name, source: sourceOf(row, store, secrets) }));
    const sources = new Sources(store, secrets, () => registry, async () => []);
    const pushed = [];
    const attachments = new AttachmentStore(join(dir, "attachments"));
    const orch = new Orchestrator(store, (m) => pushed.push(m), registry, sources, attachments);
    const bot = store.createBot({ name: "甲", title: null, avatar: null, system_prompt: "be brief", executor_id: executor.id, model: null, permission_tier: "read" });
    const conv = store.createConversation({ title: "t", repoPath: dir, worktreePath: dir, botIds: [bot.id] });
    const [member] = store.activeMembers(conv.id);
    try {
    await orch.send(conv.id, "改一下 #write");
    // the agent asks before editing; the host turns that into a card and the human allows it
    await until(() => store.listMessages(conv.id).some((m) => m.status === "pending"), 15_000);
    const card = store.listMessages(conv.id).find((m) => m.status === "pending");
    assert.equal(JSON.parse(card.body_json).call.effect, "write");
    orch.resolvePermission(conv.id, JSON.parse(card.body_json).requestId, true);
    await settle(store, conv.id, 15_000);

    const texts = store.listMessages(conv.id).filter((m) => m.card_kind === "text" && m.author_kind === "bot").map((m) => JSON.parse(m.body_json).text);
    // text before and after a tool round is one reply, with the paragraphs kept apart
    assert.deepEqual(texts, ["hi \n\ndone"]);
    const steps = store.listMessages(conv.id).filter((m) => m.card_kind === "steps").flatMap((m) => JSON.parse(m.body_json).steps);
    assert.deepEqual(steps.map((s) => [s.effect, s.ok]), [["write", true]]);

    const status = await orch.status(conv.id);
    assert.equal(status.sessions[member.id].context.used, 1200);
    assert.equal(status.sessions[member.id].model, "m1");
    assert.deepEqual(status.options[member.id].models.map((m) => m.id), ["m1", "m2"]);
    assert.deepEqual((await sources.models(executor.id)).map((m) => m.id), ["m1", "m2"], "an own sign-in's catalog comes from the agent");
    assert.deepEqual(status.options[member.id].modes.map((m) => m.id), ["ask", "yolo"]);
    assert.equal(status.options[member.id].compact, true);
    // the live session's own list, argument hints included
    assert.deepEqual(status.sessions[member.id].commands, [
      { name: "compact", description: "Compact" },
      { name: "review", description: "Review changes", hint: "<branch>" },
    ]);

    // an image goes over as a block the agent reads itself, not only as a path in the text
    const shot = await attachments.save(conv.id, "shot.png", "image/png", Readable.from([randomBytes(32)]));
    await orch.send(conv.id, "看图", [shot]);
    await settle(store, conv.id, 15_000);
    const last = store.listMessages(conv.id).filter((m) => m.card_kind === "text" && m.author_kind === "bot").at(-1);
    assert.match(JSON.parse(last.body_json).text, /saw image\/png/);

    await orch.configure(conv.id, member.id, { model: "m2" });
    await until(() => pushed.some((m) => m.kind === "session" && m.info.model === "m2"));
    assert.equal(pushed.findLast((m) => m.kind === "session").info.modelLabel, "Model Two");

    const login = await ext.types().find((t) => t.type === "fake").login();
    assert.equal(login.state, "ok");
    assert.equal(login.account, "Pro");
    // a method typed terminal runs the agent itself, whether the type is the protocol's own field or kept inside _meta; one under the older convention names its own command
    assert.deepEqual(
      login.methods.map((m) => [m.id, m.terminal?.command, m.terminal?.args.at(-1)]),
      [
        ["fake-login", "./agent.mjs", "login"],
        ["fake-meta-login", "fake-cli", "login"],
        ["fake-inner-login", "./agent.mjs", "--sign-in"],
      ],
    );
    } finally {
      await orch.disposeAll();
    }
  });

  test("a failed turn reads as the agent's reason, not as the log it printed on the way", async () => {
    const ext = new Extensions([{ dir: extensionRoot(), origin: "linked" }]);
    await ext.load();
    const dir = mkdtempSync(join(tmpdir(), "roster-acp-"));
    dirs.push(dir);
    const db = openDb(join(dir, "roster.db"));
    const store = new Store(db);
    const secrets = new Secrets(db, NO_VAULT);
    const executor = store.createExecutor({ name: "假 agent", type: "fake", source_kind: "own", provider_id: null, model: null });
    const registry = Registry.from(ext.types(), store.listExecutors(), (row) => ({ id: row.id, label: row.name, source: sourceOf(row, store, secrets) }));
    const sources = new Sources(store, secrets, () => registry, async () => []);
    const orch = new Orchestrator(store, () => {}, registry, sources, new AttachmentStore(join(dir, "attachments")));
    const bot = store.createBot({ name: "甲", title: null, avatar: null, system_prompt: null, executor_id: executor.id, model: null, permission_tier: "read" });
    const conv = store.createConversation({ title: "t", repoPath: dir, worktreePath: dir, botIds: [bot.id] });
    const errors = () => store.listMessages(conv.id).filter((m) => m.card_kind === "error").map((m) => JSON.parse(m.body_json).text);
    try {
      await orch.send(conv.id, "#fail");
      await settle(store, conv.id, 15_000);
      await orch.send(conv.id, "#fail-details");
      await settle(store, conv.id, 15_000);
      // an upstream API's JSON body is read for its message; either way the log stays out
      assert.deepEqual(errors(), ["The 'm9' model is not supported", "spawn codex ENOENT"]);

      await orch.send(conv.id, "#crash");
      await settle(store, conv.id, 15_000);
      const crash = errors().at(-1);
      assert.doesNotMatch(crash, /\x1b/);
      assert.match(crash, /panicked: out of cheese$/, "a dead process is still explained by its last words");
      assert.ok(crash.length < 3_000, `a log line holding a whole response body is cut, not ${crash.length} chars`);
    } finally {
      await orch.disposeAll();
    }
  });

  test("a signed-out agent says so before any turn is tried", async () => {
    const ext = new Extensions([{ dir: extensionRoot(), origin: "linked" }]);
    await ext.load();
    process.env.FAKE_ACP_LOGGED_OUT = "1";
    try {
      const type = ext.types().find((t) => t.type === "fake");
      const login = await type.login();
      assert.equal(login.state, "none");
      const check = await type.create({ id: "x", label: "假 agent", source: { kind: "own" } }).check();
      assert.equal(check.ok, false);
      assert.match(check.detail, /没有登录/);
    } finally {
      delete process.env.FAKE_ACP_LOGGED_OUT;
    }
  });

  test("an agent whose modes cannot be switched is gated by tier, and its sessions carry the manifest's meta", async () => {
    const ext = new Extensions([{ dir: fakeAgentRoot({ permissionModes: false, sessionMeta: { pinned: true } }), origin: "linked" }]);
    await ext.load();
    assert.equal(ext.types()[0].capabilities("own").permissionModes, false);
    const dir = mkdtempSync(join(tmpdir(), "roster-acp-"));
    dirs.push(dir);
    const db = openDb(join(dir, "roster.db"));
    const store = new Store(db);
    const secrets = new Secrets(db, NO_VAULT);
    const executor = store.createExecutor({ name: "假 agent", type: "fake", source_kind: "own", provider_id: null, model: null });
    const registry = Registry.from(ext.types(), store.listExecutors(), (row) => ({ id: row.id, label: row.name, source: sourceOf(row, store, secrets) }));
    const sources = new Sources(store, secrets, () => registry, async () => []);
    const orch = new Orchestrator(store, () => {}, registry, sources, new AttachmentStore(join(dir, "attachments")));
    const bot = (name, tier) =>
      store.createBot({ name, title: null, avatar: null, system_prompt: null, executor_id: executor.id, model: null, permission_tier: tier });
    const chat = (b) => store.createConversation({ title: "t", repoPath: dir, worktreePath: dir, botIds: [b.id] });
    const steps = (conv) => store.listMessages(conv.id).filter((m) => m.card_kind === "steps").flatMap((m) => JSON.parse(m.body_json).steps);
    try {
      // the agent asks before editing, and a bot that may write needs nobody to answer
      const writer = chat(bot("甲", "write"));
      await orch.send(writer.id, "改一下 #write #meta");
      await settle(store, writer.id, 15_000);
      assert.equal(store.listMessages(writer.id).some((m) => m.card_kind === "permission"), false);
      assert.deepEqual(steps(writer).map((s) => [s.effect, s.ok]), [["write", true]]);
      const reply = store.listMessages(writer.id).find((m) => m.card_kind === "text" && m.author_kind === "bot");
      assert.match(JSON.parse(reply.body_json).text, /meta \{"pinned":true\}/);
      const [member] = store.activeMembers(writer.id);
      assert.deepEqual((await orch.status(writer.id)).options[member.id].modes.map((m) => m.id), ["read", "write", "execute"]);

      // past the tier, a person decides
      const reader = chat(bot("乙", "read"));
      await orch.send(reader.id, "改一下 #write");
      await until(() => store.listMessages(reader.id).some((m) => m.status === "pending"), 15_000);
      const card = store.listMessages(reader.id).find((m) => m.status === "pending");
      orch.resolvePermission(reader.id, JSON.parse(card.body_json).requestId, false);
      await settle(store, reader.id, 15_000);
      assert.deepEqual(steps(reader).map((s) => [s.effect, s.ok]), [["write", false]]);
    } finally {
      await orch.disposeAll();
    }
  });

  test("an agent's ask is answered for that call alone, never with a choice it would remember", async () => {
    const ext = new Extensions([{ dir: fakeAgentRoot({ permissionModes: false }), origin: "linked" }]);
    await ext.load();
    const dir = mkdtempSync(join(tmpdir(), "roster-acp-"));
    dirs.push(dir);
    const db = openDb(join(dir, "roster.db"));
    const store = new Store(db);
    const secrets = new Secrets(db, NO_VAULT);
    const executor = store.createExecutor({ name: "假 agent", type: "fake", source_kind: "own", provider_id: null, model: null });
    const registry = Registry.from(ext.types(), store.listExecutors(), (row) => ({ id: row.id, label: row.name, source: sourceOf(row, store, secrets) }));
    const sources = new Sources(store, secrets, () => registry, async () => []);
    const orch = new Orchestrator(store, () => {}, registry, sources, new AttachmentStore(join(dir, "attachments")));
    const chat = (name, tier) => {
      const bot = store.createBot({ name, title: null, avatar: null, system_prompt: null, executor_id: executor.id, model: null, permission_tier: tier });
      return store.createConversation({ title: "t", repoPath: dir, worktreePath: dir, botIds: [bot.id] });
    };
    const reply = (conv) => JSON.parse(store.listMessages(conv.id).findLast((m) => m.card_kind === "text" && m.author_kind === "bot").body_json).text;
    const steps = (conv) => store.listMessages(conv.id).filter((m) => m.card_kind === "steps").flatMap((m) => JSON.parse(m.body_json).steps);
    try {
      // "always" listed first is passed over for "once", whichever way the call goes
      const writer = chat("甲", "write");
      await orch.send(writer.id, "改一下 #write #always-first");
      await settle(store, writer.id, 15_000);
      assert.match(reply(writer), /answered allow /);
      assert.deepEqual(steps(writer).map((s) => [s.effect, s.ok]), [["write", true]]);

      const reader = chat("乙", "read");
      await orch.send(reader.id, "改一下 #write #always-first");
      await until(() => store.listMessages(reader.id).some((m) => m.status === "pending"), 15_000);
      const card = store.listMessages(reader.id).find((m) => m.status === "pending");
      orch.resolvePermission(reader.id, JSON.parse(card.body_json).requestId, false);
      await settle(store, reader.id, 15_000);
      assert.match(reply(reader), /answered reject /);

      // with only lasting choices on offer, even an allowed call gets none of them
      const lasting = chat("丙", "write");
      await orch.send(lasting.id, "改一下 #write #always-only");
      await settle(store, lasting.id, 15_000);
      assert.match(reply(lasting), /answered cancelled /);
      assert.deepEqual(steps(lasting).map((s) => [s.effect, s.ok]), [["write", false]]);
    } finally {
      await orch.disposeAll();
    }
  });

  test("a manifest's fixed environment is set on every launch, over what the host inherited", async () => {
    const ext = new Extensions([{ dir: fakeAgentRoot({ fixedEnv: { FAKE_PINNED: { edit: "ask" }, FAKE_PLAIN: "as is" } }), origin: "linked" }]);
    await ext.load();
    const dir = mkdtempSync(join(tmpdir(), "roster-acp-"));
    dirs.push(dir);
    process.env.FAKE_PINNED = "loose";
    try {
      const { said } = await oneTurn(ext.types()[0].create({ id: "x", label: "假 agent", source: { kind: "own" } }), { cwd: dir }, "#env");
      assert.match(said, /env \{"edit":"ask"\} as is /, "an object goes as JSON, a string as it is");
    } finally {
      delete process.env.FAKE_PINNED;
    }
  });

  test("a manifest's own sign-in command stands in for the agent's terminal methods, whichever convention marks them", async () => {
    const ext = new Extensions([{ dir: fakeAgentRoot({ login: { terminal: ["fake-cli", "login"] } }), origin: "linked" }]);
    await ext.load();
    const login = await ext.types()[0].login();
    assert.deepEqual(
      login.methods.map((m) => [m.id, m.terminal?.command, m.terminal?.args]),
      [["terminal", "fake-cli", ["login"]]],
    );
  });

  test("an agent that can only resume is resumed after a restart, not started over", async () => {
    const ext = new Extensions([{ dir: fakeAgentRoot({}), origin: "linked" }]);
    await ext.load();
    const dir = mkdtempSync(join(tmpdir(), "roster-acp-"));
    dirs.push(dir);
    process.env.FAKE_ACP_RESUME = "1";
    try {
      const factory = ext.types()[0].create({ id: "x", label: "假 agent", source: { kind: "own" } });
      const first = await oneTurn(factory, { cwd: dir }, "#session");
      assert.match(first.said, /session s1 resumed false /);
      const again = await oneTurn(factory, { cwd: dir, resumeToken: first.token }, "#session");
      assert.match(again.said, /session s1 resumed true /);
    } finally {
      delete process.env.FAKE_ACP_RESUME;
    }
  });

  test("an ask that names only its call is read against that call, with the effect the manifest declares", async () => {
    const conversation = async (acp) => {
      const ext = new Extensions([{ dir: fakeAgentRoot(acp), origin: "linked" }]);
      await ext.load();
      const dir = mkdtempSync(join(tmpdir(), "roster-acp-"));
      dirs.push(dir);
      const db = openDb(join(dir, "roster.db"));
      const store = new Store(db);
      const secrets = new Secrets(db, NO_VAULT);
      const executor = store.createExecutor({ name: "假 agent", type: "fake", source_kind: "own", provider_id: null, model: null });
      const registry = Registry.from(ext.types(), store.listExecutors(), (row) => ({ id: row.id, label: row.name, source: sourceOf(row, store, secrets) }));
      const sources = new Sources(store, secrets, () => registry, async () => []);
      const orch = new Orchestrator(store, () => {}, registry, sources, new AttachmentStore(join(dir, "attachments")));
      const bot = store.createBot({ name: "甲", title: null, avatar: null, system_prompt: null, executor_id: executor.id, model: null, permission_tier: "write" });
      const conv = store.createConversation({ title: "t", repoPath: dir, worktreePath: dir, botIds: [bot.id] });
      return { store, orch, conv };
    };
    const stepsOf = ({ store, conv }) => store.listMessages(conv.id).filter((m) => m.card_kind === "steps").flatMap((m) => JSON.parse(m.body_json).steps);

    // told what write does, a bot that may write needs nobody to answer
    const told = await conversation({ permissionModes: false, toolEffects: { write: "write" } });
    try {
      await told.orch.send(told.conv.id, "#bare");
      await settle(told.store, told.conv.id, 15_000);
      assert.equal(told.store.listMessages(told.conv.id).some((m) => m.card_kind === "permission"), false);
      assert.deepEqual(stepsOf(told).map((s) => [s.name, s.effect, s.ok]), [["write", "write", true]]);
    } finally {
      await told.orch.disposeAll();
    }

    // untold, the same call is past the tier and goes to a person, who still sees what it is
    const untold = await conversation({ permissionModes: false });
    try {
      await untold.orch.send(untold.conv.id, "#bare");
      await until(() => untold.store.listMessages(untold.conv.id).some((m) => m.status === "pending"), 15_000);
      const card = JSON.parse(untold.store.listMessages(untold.conv.id).find((m) => m.status === "pending").body_json);
      assert.deepEqual([card.call.name, card.call.effect, card.call.input], ["write", "execute", { file_path: "notes.md" }]);
      untold.orch.resolvePermission(untold.conv.id, card.requestId, false);
      await settle(untold.store, untold.conv.id, 15_000);
      assert.deepEqual(stepsOf(untold).map((s) => [s.name, s.ok]), [["write", false]]);
    } finally {
      await untold.orch.disposeAll();
    }
  });

  test("an agent with no sign-in of its own takes the presets it names, keyed and addressed from the catalog", async () => {
    const root = mkdtempSync(join(tmpdir(), "roster-ext-"));
    dirs.push(root);
    const presetter = join(root, "presetter");
    mkdirSync(presetter);
    writeFileSync(join(presetter, "package.json"), JSON.stringify({ name: "@test/presetter", version: "1.0.0", type: "module", roster: { api: 2, entry: "./index.js" } }));
    writeFileSync(
      join(presetter, "index.js"),
      `export const harness = { type: "presetter", label: "Presetter", sources: { own: false, apis: [] }, capabilities: () => ({}), create: () => ({}),
        presets: async () => [{ id: "fakepreset", label: "Fake preset", api: "openai-completions", baseUrl: "https://fake.example/v1" }] };`,
    );
    const agent = fakeAgentRoot({ own: false, presets: { fakepreset: { key: "FAKE_KEY", baseUrl: "FAKE_URL" } } });
    const ext = new Extensions([
      { dir: root, origin: "linked" },
      { dir: agent, origin: "linked" },
    ]);
    await ext.load();
    const fake = ext.types().find((t) => t.type === "fake");
    assert.deepEqual(fake.sources, { own: false, apis: [] });
    assert.equal(fake.login, undefined, "there is no sign-in to ask about");
    const presets = await fake.presets();
    assert.deepEqual(presets.map((p) => p.id), ["fakepreset"]);
    assert.equal(fits(fake, { preset: "fakepreset", api: null }, presets), true);
    assert.equal(fits(fake, { preset: "otherpreset", api: null }, presets), false);
    assert.throws(() => fake.create({ id: "x", label: "假 agent", source: { kind: "own" } }), /没有自带登录/);

    const dir = mkdtempSync(join(tmpdir(), "roster-acp-"));
    dirs.push(dir);
    const endpoint = { id: "p", name: "Fake", preset: "fakepreset", apiKey: "k1" };
    const byCatalog = await oneTurn(fake.create({ id: "x", label: "假 agent", source: { kind: "endpoint", endpoint } }), { cwd: dir }, "#vars");
    assert.match(byCatalog.said, /key=k1 url=https:\/\/fake\.example\/v1 /);
    // an endpoint that names its own address keeps it
    const addressed = { ...endpoint, baseUrl: "http://127.0.0.1:9/v1" };
    const byEndpoint = await oneTurn(fake.create({ id: "y", label: "假 agent", source: { kind: "endpoint", endpoint: addressed } }), { cwd: dir }, "#vars");
    assert.match(byEndpoint.said, /url=http:\/\/127\.0\.0\.1:9\/v1 /);
  });

  test("a preset the manifest does not name is taken by the protocol it speaks, with the arguments that protocol needs", async () => {
    const root = mkdtempSync(join(tmpdir(), "roster-ext-"));
    dirs.push(root);
    const presetter = join(root, "presetter");
    mkdirSync(presetter);
    writeFileSync(join(presetter, "package.json"), JSON.stringify({ name: "@test/presetter", version: "1.0.0", type: "module", roster: { api: 2, entry: "./index.js" } }));
    writeFileSync(
      join(presetter, "index.js"),
      `export const harness = { type: "presetter", label: "Presetter", sources: { own: false, apis: [] }, capabilities: () => ({}), create: () => ({}),
        presets: async () => [
          { id: "fakepreset", label: "Fake preset", api: "openai-completions", baseUrl: "https://fake.example/v1" },
          { id: "otherpreset", label: "Other preset", api: "some-other-protocol" },
        ] };`,
    );
    const agent = fakeAgentRoot({ own: false, env: { "openai-completions": { key: "FAKE_KEY", baseUrl: "FAKE_URL", args: ["--as", "openai"] } } });
    const ext = new Extensions([
      { dir: root, origin: "linked" },
      { dir: agent, origin: "linked" },
    ]);
    await ext.load();
    const fake = ext.types().find((t) => t.type === "fake");
    const presets = await fake.presets();
    assert.deepEqual(presets.map((p) => p.id), ["fakepreset"], "only the protocol it speaks");

    const dir = mkdtempSync(join(tmpdir(), "roster-acp-"));
    dirs.push(dir);
    const endpoint = { id: "p", name: "Fake", preset: "fakepreset", apiKey: "k1" };
    const { said } = await oneTurn(fake.create({ id: "x", label: "假 agent", source: { kind: "endpoint", endpoint } }), { cwd: dir }, "#vars #args");
    assert.match(said, /key=k1 url=https:\/\/fake\.example\/v1 /);
    assert.match(said, /args .*--as openai/);

    const other = { id: "q", name: "Other", preset: "otherpreset", apiKey: "k2" };
    await assert.rejects(oneTurn(fake.create({ id: "y", label: "假 agent", source: { kind: "endpoint", endpoint: other } }), { cwd: dir }, "#vars"), /协议对不上/);
  });

  test("an agent is told the directory it works in, whatever the shell Roster was started from says", async () => {
    const ext = new Extensions([{ dir: fakeAgentRoot({}), origin: "linked" }]);
    await ext.load();
    const dir = mkdtempSync(join(tmpdir(), "roster-acp-"));
    dirs.push(dir);
    process.env.PWD = "/somewhere/else";
    try {
      const { said } = await oneTurn(ext.types()[0].create({ id: "x", label: "假 agent", source: { kind: "own" } }), { cwd: dir }, "#pwd");
      assert.ok(said.includes(`pwd ${dir} `), said);
    } finally {
      delete process.env.PWD;
    }
  });

  test("a bare model id picks the one provider pair that names it", async () => {
    const ext = new Extensions([{ dir: fakeAgentRoot({}), origin: "linked" }]);
    await ext.load();
    const dir = mkdtempSync(join(tmpdir(), "roster-acp-"));
    dirs.push(dir);
    process.env.FAKE_ACP_PAIRED = "1";
    const runtime = ext.types()[0].create({ id: "x", label: "假 agent", source: { kind: "own" } }).create();
    const infos = [];
    runtime.subscribe((e) => {
      if (e.type === "session.info") infos.push(e.info);
    });
    try {
      await runtime.start({ cwd: dir, model: "m2" });
      // what the session ran with before the pick was made is reported too, so wait for the pick itself
      await until(() => infos.at(-1)?.model === JSON.stringify(["fake", "m2"]), 15_000);
      assert.equal(infos.at(-1).modelLabel, "Model Two");
    } finally {
      delete process.env.FAKE_ACP_PAIRED;
      await runtime.dispose();
    }
  });

  test("several one-time choices make a question, which is skipped rather than answered for a person", async () => {
    const ext = new Extensions([{ dir: fakeAgentRoot({}), origin: "linked" }]);
    await ext.load();
    const dir = mkdtempSync(join(tmpdir(), "roster-acp-"));
    dirs.push(dir);
    const factory = ext.types()[0].create({ id: "x", label: "假 agent", source: { kind: "own" } });
    const { said } = await oneTurn(factory, { cwd: dir, onToolCall: async () => ({ action: "allow" }) }, "#question");
    assert.match(said, /answered skip /);
  });

  test("an ask shows what the agent said of it, and arguments sent as JSON text are read as arguments", async () => {
    const ext = new Extensions([{ dir: fakeAgentRoot({ permissionModes: false, toolEffects: { Write: "write" } }), origin: "linked" }]);
    await ext.load();
    const dir = mkdtempSync(join(tmpdir(), "roster-acp-"));
    dirs.push(dir);
    const db = openDb(join(dir, "roster.db"));
    const store = new Store(db);
    const secrets = new Secrets(db, NO_VAULT);
    const executor = store.createExecutor({ name: "假 agent", type: "fake", source_kind: "own", provider_id: null, model: null });
    const registry = Registry.from(ext.types(), store.listExecutors(), (row) => ({ id: row.id, label: row.name, source: sourceOf(row, store, secrets) }));
    const sources = new Sources(store, secrets, () => registry, async () => []);
    const orch = new Orchestrator(store, () => {}, registry, sources, new AttachmentStore(join(dir, "attachments")));
    const bot = store.createBot({ name: "甲", title: null, avatar: null, system_prompt: null, executor_id: executor.id, model: null, permission_tier: "read" });
    const conv = store.createConversation({ title: "t", repoPath: dir, worktreePath: dir, botIds: [bot.id] });
    const askedAbout = async (text) => {
      await orch.send(conv.id, text);
      await until(() => store.listMessages(conv.id).some((m) => m.status === "pending"), 15_000);
      const card = JSON.parse(store.listMessages(conv.id).find((m) => m.status === "pending").body_json);
      orch.resolvePermission(conv.id, card.requestId, false);
      await settle(store, conv.id, 15_000);
      return card.call;
    };
    try {
      const announced = await askedAbout("#json-args");
      assert.deepEqual([announced.name, announced.effect, announced.input], ["Write", "write", { path: "notes.md", content: "x" }]);
      assert.equal(announced.detail, "Requesting approval to Writing notes.md");
      // asked about before it was announced, the call is known by its title alone
      const unannounced = await askedAbout("#unannounced");
      assert.deepEqual([unannounced.name, unannounced.effect, unannounced.input], ["Write", "write", {}]);
      assert.equal(unannounced.detail, "Requesting approval to Writing other.md");
    } finally {
      await orch.disposeAll();
    }
  });

  test("a pinned mode is where every session starts", async () => {
    const ext = new Extensions([{ dir: fakeAgentRoot({ permissionModes: false, pinnedMode: "yolo" }), origin: "linked" }]);
    await ext.load();
    const dir = mkdtempSync(join(tmpdir(), "roster-acp-"));
    dirs.push(dir);
    const { said } = await oneTurn(ext.types()[0].create({ id: "x", label: "假 agent", source: { kind: "own" } }), { cwd: dir }, "#mode");
    assert.match(said, /mode yolo /);
  });

  test("a model an agent takes in its environment goes there, with the values that come with the protocol", async () => {
    const vars = { key: "FAKE_KEY", baseUrl: "FAKE_URL", model: "FAKE_MODEL", set: { FAKE_KIND: "openai" } };
    const ext = new Extensions([{ dir: fakeAgentRoot({ own: false, env: { "openai-completions": vars } }), origin: "linked" }]);
    await ext.load();
    const dir = mkdtempSync(join(tmpdir(), "roster-acp-"));
    dirs.push(dir);
    const endpoint = { id: "p", name: "Custom", preset: "custom", api: "openai-completions", apiKey: "k", baseUrl: "http://127.0.0.1:9/v1", models: ["m9"] };
    const factory = ext.types()[0].create({ id: "x", label: "假 agent", source: { kind: "endpoint", endpoint } });
    const runtime = factory.create();
    let said = "";
    let ended = false;
    const infos = [];
    runtime.subscribe((e) => {
      if (e.type === "assistant.text") said += e.delta;
      if (e.type === "turn.end") ended = true;
      if (e.type === "session.info") infos.push(e.info);
    });
    try {
      await runtime.start({ cwd: dir, model: "m2" });
      await runtime.send("#vars");
      await until(() => ended, 15_000);
      assert.match(said, /key=k url=http:\/\/127\.0\.0\.1:9\/v1 model=m2 kind=openai /);
      // the session is not switched to it as well, which could pick a same-named model from another source
      assert.equal(infos.at(-1).model, "m1");
    } finally {
      await runtime.dispose();
    }
    // with nobody's pick, the endpoint's first model stands in
    const unpicked = await oneTurn(factory, { cwd: dir }, "#vars");
    assert.match(unpicked.said, /model=m9 /);
  });

  test("a launcher npm left without an extension runs on the host's own runtime, and a program that cannot start is only reported", async () => {
    const ext = new Extensions([{ dir: fakeAgentRoot({ command: ["@program", "agent", "stdio"] }), origin: "linked" }]);
    await ext.load();
    const type = ext.types()[0];
    const bin = mkdtempSync(join(tmpdir(), "roster-bin-"));
    dirs.push(bin);
    copyFileSync(fileURLToPath(new URL("./fixtures/acp-agent.mjs", import.meta.url)), join(bin, "agent.mjs"));
    // a node this machine does not have: only the host's runtime can run it
    const launcher = join(bin, "agent");
    writeFileSync(launcher, `#!/nowhere/bin/node\nimport(require("node:url").pathToFileURL(require("node:path").join(__dirname, "agent.mjs")).href);\n`, { mode: 0o755 });
    assert.equal((await type.login(launcher)).state, "ok");
    await assert.rejects(type.login(join(bin, "missing")), /ENOENT/);
  });
});

describe("program updates", () => {
  test("a program that updates itself is asked what is out, and its updater runs as a job keeping what it printed", async () => {
    const program = selfUpdatingProgram();
    const root = mkdtempSync(join(tmpdir(), "roster-installer-"));
    dirs.push(root);
    const installer = new Installer(join(root, "extensions"), join(root, "agents"), () => {});
    const check = ["update", "--check", "--json"];
    assert.deepEqual(await installer.checkUpdate(program, check), { current: "1.0.0", latest: "1.1.0", available: true });

    process.env.FAKE_UPDATE_FAIL = "1";
    try {
      const failed = await installer.updateProgram("fake", program, ["update"]);
      assert.deepEqual([failed.state, failed.update, failed.log], ["failed", true, ["download failed"]], "colour codes stay out of the log");
    } finally {
      delete process.env.FAKE_UPDATE_FAIL;
    }
    const job = await installer.updateProgram("fake", program, ["update"]);
    assert.equal(job.state, "done");
    assert.deepEqual(job.log, ["Downloading 10%", "Downloading 100%", "Updated to 1.1.0"], "each redraw of a progress bar is a line of its own");
    assert.equal((await installer.checkUpdate(program, check)).available, false);

    await assert.rejects(installer.checkUpdate(program, ["--version"]), /最新的版本号/, "an answer without a version is no answer");
    await assert.rejects(installer.checkUpdate(join(root, "missing"), check), /ENOENT/);
  });

  test("only a program found on this machine updates itself, and the view carries what its check last said", async () => {
    const program = selfUpdatingProgram();
    const ext = new Extensions([{ dir: fakeAgentRoot({}), origin: "linked" }]);
    await ext.load();
    const root = mkdtempSync(join(tmpdir(), "roster-harnesses-"));
    dirs.push(root);
    const update = { args: ["update"], check: ["update", "--check", "--json"] };
    const catalog = [{ id: "fake", label: "Fake", description: "", program: { npm: "@test/fake", bin: "roster-test-fake", update } }];
    let found = [];
    const detector = { current: () => ({ at: 0, programs: found, hints: [], shell: { name: "", ok: true } }) };
    const installer = new Installer(join(root, "extensions"), join(root, "agents"), () => {});
    const harnesses = new Harnesses(catalog, ext, detector, installer);
    assert.equal(harnesses.updater("fake"), null, "nothing found, nothing to update");

    found = [{ id: "fake", path: program, version: "1.0.0", found: "known-path" }];
    assert.deepEqual([harnesses.view()[0].updatable, harnesses.view()[0].update], [true, undefined], "not asked yet");
    assert.equal((await harnesses.checkUpdate("fake")).available, true);
    assert.deepEqual(harnesses.view()[0].update, { current: "1.0.0", latest: "1.1.0", available: true });
    await installer.updateProgram("fake", program, ["update"]);
    assert.equal((await harnesses.checkUpdate("fake")).available, true, "the answer is kept a while");
    assert.equal((await harnesses.checkUpdate("fake", true)).available, false, "until it is asked afresh");
  });

  test("sessions on a harness whose program was replaced let go of the old process: an idle one now, a running one when its turn ends", async () => {
    let created = 0;
    const edit = { id: "e1", name: "edit", effect: "write", input: { path: "notes.md" } };
    const inner = played([{ gate: edit }, { start: edit }, { end: { id: "e1", isError: false, content: "ok" } }, "改好了。"]);
    const h = harness({ pi: { ...inner, create: () => (created++, inner.create()) } });
    const conv = h.group([h.bot("甲", { permission_tier: "write" })]);
    const turn = async (text) => {
      await h.orch.send(conv.id, text);
      await settle(h.store, conv.id);
    };
    await turn("改一");
    await turn("改二");
    assert.equal(created, 1, "one process serves turn after turn");
    h.orch.programChanged("other");
    await turn("改三");
    assert.equal(created, 1, "another harness's update leaves it alone");
    h.orch.programChanged("scripted");
    await turn("改四");
    assert.equal(created, 2, "an idle session starts the new program on its next turn");

    // mid-turn, waiting on a person: the turn ends on the process it began on
    const botId = h.store.activeMembers(conv.id)[0].bot_id;
    h.store.updateBot(botId, { permission_tier: "read" });
    await h.orch.send(conv.id, "改五");
    await until(() => h.store.listMessages(conv.id).some((m) => m.status === "pending"));
    h.orch.programChanged("scripted");
    const card = h.store.listMessages(conv.id).find((m) => m.status === "pending");
    h.orch.resolvePermission(conv.id, JSON.parse(card.body_json).requestId, true);
    await settle(h.store, conv.id);
    assert.equal(created, 2, "the turn finished where it started");
    h.store.updateBot(botId, { permission_tier: "write" });
    await turn("改六");
    assert.equal(created, 3, "and the next one starts the new program");
  });
});

describe("languages", () => {
  test("a group turn, its roster and its instruction are written in the current language", async () => {
    const out = await inLocale("en", () =>
      composeDelivery({
        shape: "group",
        title: "t",
        mode: "leader",
        selfId: "a",
        leaderId: "a",
        members: [{ id: "a", name: "Alice", title: "Frontend" }, { id: "b", name: "Bob", title: null }],
        names: new Map([["a", "Alice"], ["b", "Bob"]]),
        items: [{ seq: 1, memberId: null, kind: "human", text: "@Alice build the login page", at: 0 }, { seq: 2, memberId: "b", kind: "bot", text: "on it", at: 0 }],
        asks: new Set(["lead"]),
        fresh: true,
      }).text,
    );
    assert.match(out, /mode="leader-led"/);
    assert.match(out, /- Alice \(you, leader\): Frontend/);
    assert.match(out, /- User: /);
    assert.match(out, /<message from="User"/);
    assert.match(out, /<message from="Bob"/);
    assert.match(out, /You are Alice\. You are the leader of this group\./);
  });

  test("a notice reads in the language it is opened in, and a bot catching up reads it that way too", async () => {
    const h = harness();
    const conv = h.group([h.bot("甲")]);
    const b = h.bot("乙");
    h.orch.addMember(conv.id, b.id);
    // one written before notices had keys stays as it was written
    h.store.append(conv.id, null, null, { type: "system.notice", display: "message", text: "旧的通知" });
    assert.deepEqual(h.said(conv.id), ["* 乙 加入了群聊", "* 旧的通知"]);

    await inLocale("en", async () => {
      assert.deepEqual(h.said(conv.id), ["* 乙 joined the group", "* 旧的通知"]);
      await h.orch.send(conv.id, "@乙 hello");
      await settle(h.store, conv.id);
      const caughtUp = h.sent.find((s) => s.preset === "preset:乙").text;
      assert.match(caughtUp, /<notice time="[^"]+">乙 joined the group<\/notice>/);
      assert.match(caughtUp, /The user mentioned you in the group/);
    });
  });

  test("the scripted leader loop reads and answers English prompts", async () => {
    await inLocale("en", async () => {
      const h = harness();
      const lead = h.bot("Lead");
      const conv = h.group([lead, h.bot("Alice"), h.bot("Bob")], { mode: "leader", leaderBotId: lead.id });
      await h.orch.send(conv.id, "build a login page");
      await settle(h.store, conv.id);
      const lines = h.said(conv.id);
      assert.deepEqual(lines.slice(1).map((l) => l.split(":")[0]).sort(), ["Alice", "Bob", "Lead", "Lead"]);
      assert.match(lines.at(-1), /^Lead: Summary: /);
    });
  });

  test("a default title in either language gives way to the first message", () => {
    for (const title of ["Chat with Pi", "与 Pi 的会话", "New group", "新群聊", "New conversation"]) assert.match(title, UNTITLED);
    for (const title of ["Chat with", "登录页", "New groups"]) assert.doesNotMatch(title, UNTITLED);
  });

  test("a default title is listed in the current language, and a typed one as typed", async () => {
    const h = harness();
    const pi = h.bot("Pi");
    const direct = h.group([pi], { title: "与 Pi 的会话" });
    const group = h.group([pi, h.bot("Bob")]);
    const typed = h.group([pi], { title: "登录页" });
    const titles = () => Object.fromEntries(h.store.listConversations().map((c) => [c.id, c.title]));
    await inLocale("en", () =>
      assert.deepEqual([direct, group, typed].map((c) => titles()[c.id]), ["Chat with Pi", "New group", "登录页"]),
    );
    assert.deepEqual([direct, group].map((c) => titles()[c.id]), ["与 Pi 的会话", "新群聊"]);
    // the first message still sees the stored default and replaces it
    await inLocale("en", () => h.orch.send(direct.id, "fix the login page"));
    await settle(h.store, direct.id);
    assert.equal(titles()[direct.id], "fix the login page");
  });

  test("an agent named in one language still follows a new source after a switch, and new names use the new one", async () => {
    const h = settingsHarness();
    const official = await h.settings.createProvider({ name: "官方", preset: "anthropic", key: "sk-aaaaaaaaaaaaaaaa" });
    const agent = await h.settings.createExecutor({ type: "alpha", source_kind: "own" });
    assert.equal(agent.name, "alpha · 订阅");
    await inLocale("en", async () => {
      const moved = await h.settings.updateExecutor(agent.id, { name: agent.name, source_kind: "endpoint", provider_id: official.id });
      assert.equal(moved.name, "alpha · 官方");
      assert.equal((await h.settings.updateExecutor(agent.id, { name: moved.name, source_kind: "own" })).name, "alpha · Subscription");
      await assert.rejects(h.settings.createExecutor({ type: "beta", source_kind: "own" }), /has no sign-in of its own/);
    });
  });

  test("the system language is the shell's list first, and Traditional Chinese is not shown in Simplified", () => {
    assert.equal(matchLocale(["zh-Hant-TW", "en-US"]), "en");
    assert.equal(matchLocale(["zh_CN.UTF-8"]), "zh-CN");
    assert.equal(matchLocale(["zh-Hans-CN", "en-CN"]), "zh-CN");
    assert.equal(matchLocale(["ja-JP"]), null);
    const saved = process.env.ROSTER_SYSTEM_LOCALES;
    try {
      process.env.ROSTER_SYSTEM_LOCALES = "zh-Hans-CN,en-CN";
      assert.equal(systemLocale(), "zh-CN");
      process.env.ROSTER_SYSTEM_LOCALES = "fr-FR,en-GB";
      assert.equal(systemLocale(), "en");
    } finally {
      if (saved === undefined) delete process.env.ROSTER_SYSTEM_LOCALES;
      else process.env.ROSTER_SYSTEM_LOCALES = saved;
    }
  });

  test("an adapter writes in the language it is handed, and logos are named in the current one", async () => {
    const endpoint = { id: "p1", name: "DS", preset: "deepseek", apiKey: "sk-test", models: ["deepseek-flash"] };
    const check = (tag) => piHarness.create({ id: "e1", label: "pi", source: { kind: "endpoint", endpoint }, locale: tag }).check();
    assert.equal((await check("en")).detail, "1 model to pick from");
    assert.equal((await check("zh-CN")).detail, "1 个模型可选");
    assert.throws(() => piHarness.create({ id: "e2", label: "pi", source: { kind: "own" }, locale: "en" }), /no sign-in of its own/);
    assert.equal(logos()[0].name, "狐狸");
    await inLocale("en", () => assert.equal(logos()[0].name, "Fox"));
  });

  test("a preference is kept across a reopen", () => {
    const dir = mkdtempSync(join(tmpdir(), "roster-pref-"));
    dirs.push(dir);
    const file = join(dir, "roster.db");
    const db = openDb(file);
    const store = new Store(db);
    assert.equal(store.preference("locale"), null);
    store.setPreference("locale", "en");
    store.setPreference("locale", "zh-CN");
    db.close();
    assert.equal(new Store(openDb(file)).preference("locale"), "zh-CN");
  });
});

describe("directories", () => {
  let h;
  beforeEach(() => {
    h = harness();
  });

  /** A chat-space conversation, made the way the server makes one: the folder first, then the row under that id. */
  const chat = (bots) => {
    const id = randomUUID();
    const dir = join(h.dir, "chats", id);
    mkdirSync(dir, { recursive: true });
    return h.store.createConversation({ id, title: "闲聊", repoPath: dir, worktreePath: dir, dirKind: "chat", botIds: bots.map((b) => b.id) });
  };

  test("one bot in a repository is a group; one bot in a chat space is a direct chat", () => {
    const pi = h.bot("Pi");
    const repo = h.group([pi]);
    assert.equal(repo.dir_kind, "repo");
    assert.equal(repo.shape, "group");
    const direct = chat([pi]);
    assert.equal(direct.dir_kind, "chat");
    assert.equal(direct.shape, "direct");
    assert.equal(direct.repo_path, join(h.dir, "chats", direct.id), "the row carries the id the folder was made under");
    assert.equal(chat([pi, h.bot("Go")]).shape, "group");
  });

  test("recent directories are the repositories picked, newest activity first, each once", async () => {
    const pi = h.bot("Pi");
    const a = mkdtempSync(join(tmpdir(), "roster-a-"));
    const b = mkdtempSync(join(tmpdir(), "roster-b-"));
    dirs.push(a, b);
    const first = h.group([pi], { repoPath: a, worktreePath: a });
    h.group([pi], { repoPath: b, worktreePath: b });
    h.group([pi], { repoPath: a, worktreePath: a });
    chat([pi]);
    await new Promise((r) => setTimeout(r, 5));
    h.store.append(first.id, null, null, { type: "system.notice", display: "message", text: "hi" });
    assert.deepEqual(h.store.recentDirs(10), [a, b]);
    assert.deepEqual(h.store.recentDirs(1), [a]);
  });

  test("alone in a group, a bot reads the person's words as they are; a second member turns them into a transcript", async () => {
    const conv = h.group([h.bot("Pi")]);
    await h.orch.send(conv.id, "写个 hello");
    await settle(h.store, conv.id);
    assert.equal(h.sent.at(-1).text, "写个 hello");
    assert.equal(h.sent.at(-1).cwd, h.dir);
    await h.orch.addMember(conv.id, h.bot("Go").id);
    await h.orch.send(conv.id, "@Go 看看");
    await settle(h.store, conv.id);
    assert.match(h.sent.at(-1).text, /<group_chat /);
  });

  test("moving a group restarts every member from the transcript in the new directory and says so", async () => {
    const conv = h.group([h.bot("甲"), h.bot("乙")]);
    await h.orch.send(conv.id, "@所有人 开始");
    await settle(h.store, conv.id);
    for (const m of h.store.activeMembers(conv.id)) h.store.setResumeToken(m.id, "old-session");
    const dir2 = mkdtempSync(join(tmpdir(), "roster-move-"));
    dirs.push(dir2);

    assert.equal(await h.orch.setDirectory(conv.id, dir2, "repo"), true);
    assert.equal(h.said(conv.id).at(-1), `* 工作目录改为 ${dir2}`);
    for (const m of h.store.activeMembers(conv.id)) {
      assert.equal(m.delivered_seq, 0, "owed the transcript again");
      assert.equal(m.resume_token, null, "a session opened elsewhere cannot be resumed here");
    }
    const after = h.store.getConversation(conv.id);
    assert.equal(after.repo_path, dir2);
    assert.equal(after.worktree_path, dir2);

    await h.orch.send(conv.id, "@乙 继续");
    await settle(h.store, conv.id);
    const last = h.sent.at(-1);
    assert.equal(last.cwd, dir2);
    assert.match(last.text, /<members>/, "a fresh member is told who is in the group");
    assert.match(last.text, /开始/);
    assert.match(last.text, /工作目录改为/);

    // the same place again is not a change
    assert.equal(await h.orch.setDirectory(conv.id, dir2, "repo"), false);
    assert.equal(h.said(conv.id).filter((s) => s.startsWith("* 工作目录")).length, 1);
  });

  test("moving to a chat space is named as such, and the shape stays", async () => {
    const conv = h.group([h.bot("Pi")]);
    const space = join(h.dir, "chats", conv.id);
    mkdirSync(space, { recursive: true });
    assert.equal(await h.orch.setDirectory(conv.id, space, "chat"), true);
    assert.equal(h.said(conv.id).at(-1), `* 工作目录改为聊天空间（${space}）`);
    const after = h.store.getConversation(conv.id);
    assert.equal(after.dir_kind, "chat");
    assert.equal(after.shape, "group");
  });

  test("not while a member is working, and never for a direct chat", async () => {
    const pi = h.bot("Pi");
    const conv = h.group([pi]);
    await h.orch.send(conv.id, "干活");
    await assert.rejects(h.orch.setDirectory(conv.id, join(h.dir, "x"), "repo"), /正在干活/);
    await settle(h.store, conv.id);
    await assert.rejects(h.orch.setDirectory(chat([pi]).id, h.dir, "repo"), /单聊/);
  });
});

/** Starts a scripted core on its own data directory: the process, its exit, and its URL once it reports ready. */
function startCore(dir) {
  const core = spawn(process.execPath, [fileURLToPath(new URL("../dist/main.js", import.meta.url))], {
    env: { ...process.env, ROSTER_DATA_DIR: dir, ROSTER_PORT: "0", ROSTER_SCRIPTED: "1" },
    stdio: ["pipe", "pipe", "inherit"],
  });
  core.stdin.end();
  const exited = new Promise((resolve) => core.once("exit", (code, signal) => resolve({ code, signal })));
  const url = new Promise((resolve, reject) => {
    let out = "";
    core.stdout.on("data", (d) => {
      out += d;
      const ready = /"roster":"ready".*"url":"([^"]+)"/.exec(out);
      if (ready) resolve(ready[1]);
    });
    void exited.then(() => reject(new Error("core exited before it was ready")));
  });
  return { core, exited, url };
}

describe("locations", () => {
  test("a conversation works in a chat space unless a directory is named; directories picked before are offered again", { timeout: 20_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "roster-loc-"));
    dirs.push(dir);
    const { core, url } = startCore(dir);
    try {
      const base = await url;
      const call = async (path, method = "GET", body) => {
        const res = await fetch(new URL(path, base), {
          method,
          ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
        });
        return { status: res.status, body: await res.json() };
      };
      const state = (await call("/api/state")).body;
      const bot = state.bots[0];
      assert.ok(bot, "scripted mode seeds a bot");
      assert.equal("defaultDir" in state, false, "core has no working directory of its own");

      const chat = (await call("/api/conversations", "POST", { botIds: [bot.id] })).body.conversation;
      assert.equal(chat.dir_kind, "chat");
      assert.equal(chat.shape, "direct");
      assert.equal(chat.repo_path, join(dir, "chats", chat.id));
      assert.ok(statSync(chat.repo_path).isDirectory());
      assert.deepEqual((await call("/api/locations")).body, { chats: join(dir, "chats"), recent: [] });

      const repo = (await call("/api/conversations", "POST", { botIds: [bot.id], repoPath: dir })).body.conversation;
      assert.equal(repo.dir_kind, "repo");
      assert.equal(repo.shape, "group", "one bot in a repository is a group");
      assert.deepEqual((await call("/api/locations")).body.recent, [dir]);

      const relative = await call("/api/conversations", "POST", { botIds: [bot.id], repoPath: "packages" });
      assert.equal(relative.status, 400);
      assert.match(relative.body.error, /完整路径|full path/);
      const missing = await call("/api/conversations", "POST", { botIds: [bot.id], repoPath: join(dir, "nope") });
      assert.equal(missing.status, 400);

      assert.equal((await call(`/api/conversations/${repo.id}`, "PATCH", { chat: true })).status, 200);
      const moved = (await call("/api/state")).body.conversations.find((c) => c.id === repo.id);
      assert.equal(moved.dir_kind, "chat");
      assert.equal(moved.repo_path, join(dir, "chats", repo.id));
      const notices = (await call(`/api/conversations/${repo.id}/messages`)).body.messages.filter((m) => m.author_kind === "system");
      assert.match(JSON.parse(notices.at(-1).body_json).text, /聊天空间|chat space/);
      const refused = await call(`/api/conversations/${chat.id}`, "PATCH", { repoPath: dir });
      assert.equal(refused.status, 400, "a direct chat has no other place to be");

      // a group's face: one of the bundled logos, or its members' again
      const logo = state.logos[0].id;
      assert.equal((await call(`/api/conversations/${repo.id}`, "PATCH", { avatar: "nope" })).status, 400);
      assert.equal((await call(`/api/conversations/${repo.id}`, "PATCH", { avatar: logo })).status, 200);
      const faced = (await call("/api/state")).body.conversations.find((c) => c.id === repo.id);
      assert.equal(faced.avatar, logo);
      assert.equal((await call(`/api/conversations/${repo.id}`, "PATCH", { avatar: null })).status, 200);
      assert.equal((await call("/api/state")).body.conversations.find((c) => c.id === repo.id).avatar, null);

      assert.equal((await call(`/api/conversations/${chat.id}`, "DELETE")).body.ok, true);
      assert.equal(existsSync(join(dir, "chats", chat.id)), false, "the chat space goes with the conversation");
    } finally {
      core.kill("SIGKILL");
    }
  });
});

describe("shutdown", () => {
  test("SIGTERM ends core even while a window holds the event stream open", { timeout: 20_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "roster-test-"));
    dirs.push(dir);
    const { core, exited, url: ready } = startCore(dir);
    let timer;
    try {
      const url = await ready;
      const stream = await new Promise((resolve, reject) => get(new URL("/api/stream", url), resolve).on("error", reject));
      stream.resume();

      core.kill("SIGTERM");
      const late = new Promise((resolve) => (timer = setTimeout(() => resolve("still running"), 3000)));
      // under core's own deadline, so only a clean exit passes
      assert.deepEqual(await Promise.race([exited, late]), { code: 0, signal: null });
    } finally {
      clearTimeout(timer);
      core.kill("SIGKILL");
    }
  });
});
