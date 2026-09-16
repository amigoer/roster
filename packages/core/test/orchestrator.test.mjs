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
import { sourceOf, Sources } from "../dist/sources.js";
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
      return new Proxy(rt, {
        get(target, prop) {
          if (prop === "start") {
            return (opts) => {
              name = opts.systemPrompt ?? "?";
              return target.start(opts);
            };
          }
          if (prop === "send") {
            return (text, deliver, attachments = []) => {
              sent.push({ preset: name, text, attachments });
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

describe("session status", () => {
  const usage = (usedPercent) => ({ plan: "pro", windows: [{ kind: "session", usedPercent }] });

  test("a member is previewed before its first turn, then shown as its session reports", async () => {
    const scripted = scriptedFactory("pi", 1);
    const h = harness({ pi: { ...scripted, sessionInfo: async ({ model }) => ({ model: `preview:${model}` }) } });
    const conv = h.group([h.bot("甲", { model: "m1" })]);
    const [member] = h.store.activeMembers(conv.id);

    assert.deepEqual((await h.orch.status(conv.id)).sessions[member.id], { model: "preview:m1" });

    await h.orch.send(conv.id, "一");
    await settle(h.store, conv.id);

    const parts = [
      { name: "系统工具", tokens: 9_000 },
      { name: "系统提示词", tokens: 3_000 },
      { name: "消息", tokens: 3_000 },
    ];
    const context = { used: 15_000, max: 200_000, percent: 8, autoCompactAt: 84, parts };
    const { commands } = await scripted.sessionOptions();
    const reported = { model: "m1", modelLabel: "m1", mode: "default", effort: "high", fast: "off", context, commands };
    assert.deepEqual((await h.orch.status(conv.id)).sessions[member.id], reported);
    // a session restating the same picture is not news
    await h.orch.configure(conv.id, member.id, {});
    assert.deepEqual(h.pushed.filter((m) => m.kind === "session").map((m) => m.info), [reported]);
  });

  test("picks for a session are kept, reach it live, and survive into its next start", async () => {
    const h = harness({ pi: scriptedFactory("pi", 1) });
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
    assert.deepEqual(login.methods.map((m) => [m.id, m.terminal?.args.at(-1)]), [["fake-login", "login"]]);
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
      }).text,
    );
    assert.match(out, /mode="leader-led"/);
    assert.match(out, /- Alice \(you, leader\): Frontend/);
    assert.match(out, /- User: /);
    assert.match(out, /<message from="User"/);
    assert.match(out, /<message from="Bob"/);
    assert.match(out, /You are the leader of this group\./);
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

describe("shutdown", () => {
  test("SIGTERM ends core even while a window holds the event stream open", { timeout: 20_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "roster-test-"));
    dirs.push(dir);
    const core = spawn(process.execPath, [fileURLToPath(new URL("../dist/main.js", import.meta.url))], {
      env: { ...process.env, ROSTER_DATA_DIR: dir, ROSTER_PORT: "0", ROSTER_SCRIPTED: "1" },
      stdio: ["pipe", "pipe", "inherit"],
    });
    core.stdin.end();
    const exited = new Promise((resolve) => core.once("exit", (code, signal) => resolve({ code, signal })));
    let timer;
    try {
      const url = await new Promise((resolve, reject) => {
        let out = "";
        core.stdout.on("data", (d) => {
          out += d;
          const ready = /"roster":"ready".*"url":"([^"]+)"/.exec(out);
          if (ready) resolve(ready[1]);
        });
        void exited.then(() => reject(new Error("core exited before it was ready")));
      });
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
