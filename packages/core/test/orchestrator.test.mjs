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
import { literal } from "@roster/ext-pi-agent";
import { aboutReader } from "../dist/about.js";
import { openDb } from "../dist/db/index.js";
import { AttachmentStore, MAX_BYTES } from "../dist/attachments.js";
import { composeDelivery } from "../dist/delivery.js";
import { Rejection } from "../dist/errors.js";
import { checkEndpoint, ensureExecutors, ExecutorSettings } from "../dist/executors.js";
import { Extensions } from "../dist/extensions.js";
import { LOGO_IDS, LOGOS, LOGOS_DIR } from "../dist/logos.js";
import { findMentions } from "../dist/mentions.js";
import { Orchestrator } from "../dist/orchestrator.js";
import { Registry } from "../dist/registry.js";
import { scriptedFactory } from "../dist/scripted.js";
import { NO_VAULT, Secrets } from "../dist/secrets.js";
import { Sources } from "../dist/sources.js";
import { Store } from "../dist/store.js";

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
  for (const id of ["pi", "claude"]) store.createExecutor({ id, name: id, type: "scripted", settings: {} });
  const sent = [];
  const inner = scriptedFactory("pi", 1);
  const spy = {
    ...inner,
    create(source) {
      const rt = inner.create(source);
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
      model_source: null,
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
    const factory = { ...scripted, capabilities: () => ({ ...scripted.capabilities("own"), permissionModes: true }) };
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
    assert.equal(new Set(LOGO_IDS).size, LOGOS.length, "logo ids must be unique");
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
  test("existing members keep their place; the event sequence skips past legacy rows", () => {
    const dir = mkdtempSync(join(tmpdir(), "roster-mig-"));
    dirs.push(dir);
    const file = join(dir, "roster.db");
    const db = openDb(file);
    const store = new Store(db);
    store.createExecutor({ name: "pi", type: "pi-agent", settings: {} });
    const pi = store.listExecutors()[0];
    const bot = store.createBot({
      name: "Pi", title: null, avatar: null, system_prompt: null,
      executor_id: pi.id, model_source: null, model: null, permission_tier: "read",
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
        executor_id: "nowhere", model_source: null, model: null, permission_tier: "read",
      }),
    );
  });

  test("an endpoint bound to an executor becomes the source of every bot on it", () => {
    const dir = mkdtempSync(join(tmpdir(), "roster-src-"));
    dirs.push(dir);
    const file = join(dir, "roster.db");
    const db = openDb(file);
    const store = new Store(db);
    const executor = store.createExecutor({ name: "乙", type: "beta", settings: {} });
    const provider = store.createProvider({ name: "DS", preset: "deepseek", api: null, base_url: null, models: [], headers: {}, key_env: null, secret_ref: null });
    const bot = store.createBot({ name: "甲", title: null, avatar: null, system_prompt: null, executor_id: executor.id, model_source: null, model: "m", permission_tier: "read" });
    const conv = store.createConversation({ title: "t", repoPath: dir, worktreePath: dir, botIds: [bot.id] });
    // the database as it was: the binding on the executor, nothing on the bot or its member
    db.prepare(`UPDATE executors SET provider_ids_json = ? WHERE id = ?`).run(JSON.stringify([provider.id]), executor.id);
    db.prepare(`UPDATE members SET spec_json = json_remove(spec_json, '$.model_source')`).run();
    db.exec("PRAGMA user_version = 2");
    db.close();

    const reopened = new Store(openDb(file));
    assert.equal(reopened.getBot(bot.id).model_source, provider.id);
    assert.equal(reopened.activeMembers(conv.id)[0].spec.model_source, provider.id);
    assert.equal(reopened.listConversations()[0].members[0].stale, false, "the member ran on that endpoint all along");
  });
});

/** A harness type that runs on scripts but reports what source it was handed, so tests can see what reached it. */
function fakeHarness(type, { own = false, apis = ["openai-completions"], presets = [], catalog } = {}) {
  const caps = { interceptToolCall: true, mutateToolInput: false, midRunInject: [], costLimit: false, mcp: false, branch: false, permissionModes: false };
  return {
    type,
    label: type,
    sources: { own, apis },
    capabilities: () => caps,
    fields: [{ key: "path", label: "路径", kind: "path" }],
    presets: async () => presets,
    ...(catalog ? { catalog } : {}),
    create: (instance) => ({
      ...scriptedFactory(instance.id, 1, instance.label),
      type,
      sources: { own, apis },
      check: async (source) => ({ ok: true, detail: source.kind === "endpoint" ? (source.endpoint.apiKey ?? "none") : "own" }),
    }),
  };
}

function settingsHarness(vault = { key: randomBytes(32), keystore: "keychain" }) {
  const dir = mkdtempSync(join(tmpdir(), "roster-settings-"));
  dirs.push(dir);
  const db = openDb(join(dir, "roster.db"));
  const store = new Store(db);
  const secrets = new Secrets(db, vault);
  const types = [
    fakeHarness("alpha", {
      own: true,
      apis: ["anthropic-messages"],
      presets: [{ id: "anthropic", label: "Anthropic", api: "anthropic-messages", models: 0 }],
    }),
    fakeHarness("beta", {
      presets: [{ id: "deepseek", label: "DeepSeek", api: "openai-completions", models: 2 }],
      catalog: async (e) =>
        e.preset === "deepseek" ? ["ds-flash", "ds-pro"].map((id) => ({ id, available: Boolean(e.apiKey), contextWindow: 1_000_000 })) : [],
    }),
  ];
  const build = () => Registry.from(types, store.listExecutors());
  let registry = build();
  const settings = new ExecutorSettings(store, secrets, () => types, () => registry, () => {
    registry = build();
    orch.useRegistry(registry);
  });
  const sources = new Sources(store, secrets, () => registry, (t) => settings.presets(t));
  const orch = new Orchestrator(store, () => {}, registry, sources);
  const bot = (name, executor_id, model_source = null) =>
    store.createBot({ name, title: null, avatar: null, system_prompt: null, executor_id, model_source, model: null, permission_tier: "read" });
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

    const executor = await h.settings.createExecutor({ name: "乙执行器", type: "beta" });
    // the bot names the endpoint; the executor is handed it, key and all, when a session starts
    const source = h.sources.resolve(executor.id, provider.id);
    assert.equal(source.endpoint.apiKey, "sk-secret-value-123456");
    assert.equal((await h.registry().get(executor.id).check(source)).detail, "sk-secret-value-123456");
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
    const executor = await h.settings.createExecutor({ name: "乙执行器", type: "beta" });
    const conv = h.store.createConversation({ title: "t", repoPath: h.dir, worktreePath: h.dir, botIds: [h.bot("甲", executor.id, provider.id).id] });
    const stale = () => h.store.listConversations().find((c) => c.id === conv.id).members[0].stale;

    assert.equal(stale(), false);
    await h.settings.updateProvider(provider.id, { key: "k2-bbbbbbbbbbbb" });
    assert.equal(stale(), false, "a rotated key reaches the next session with nothing to re-sync");
    await h.settings.updateProvider(provider.id, { base_url: "https://b.example/v1" });
    assert.equal(stale(), true);
  });

  test("what is still in use cannot be deleted, and a bot's source has to fit its executor", async () => {
    const h = settingsHarness();
    const provider = await h.settings.createProvider({ name: "DS", preset: "deepseek", key: "sk-xxxxxxxxxxxxxx" });
    const alpha = await h.settings.createExecutor({ name: "甲执行器", type: "alpha" });
    const beta = await h.settings.createExecutor({ name: "乙执行器", type: "beta" });
    assert.match((await h.sources.usable(alpha.id, provider.id)).reason, /协议对不上/);
    assert.deepEqual(await h.sources.usable(beta.id, provider.id), { ok: true });
    // beta has no sign-in of its own, so a bot on it must name an endpoint; alpha brings one
    assert.match((await h.sources.usable(beta.id, null)).reason, /没有自带的登录/);
    assert.deepEqual(await h.sources.usable(alpha.id, null), { ok: true });

    h.bot("乙", beta.id, provider.id);
    assert.throws(() => h.settings.deleteProvider(provider.id), (err) => err instanceof Rejection && err.status === 409);
    assert.throws(() => h.settings.deleteExecutor(beta.id), (err) => err instanceof Rejection && err.status === 409);
    // the groups a bot picks from: alpha's own sign-in, beta's compatible endpoints
    assert.deepEqual((await h.sources.groups(alpha.id)).map((g) => g.source), [null]);
    assert.deepEqual((await h.sources.groups(beta.id)).map((g) => [g.source, g.label]), [[provider.id, "DS"]]);
  });

  test("an executor added while the app runs is there for the very next lookup", async () => {
    const h = settingsHarness();
    const executor = await h.settings.createExecutor({ name: "新执行器", type: "beta", settings: { path: "/bin/x", stray: "dropped" } });
    assert.deepEqual(executor.settings, { path: "/bin/x" }, "only fields the type declares are kept");
    assert.ok(executor.id in h.orch.capabilities());
    assert.deepEqual(h.orch.capabilities()[executor.id].own, undefined, "beta has no sign-in of its own");
    assert.ok(h.orch.capabilities()[executor.id].endpoint);
    const listed = h.orch.executors().find((e) => e.id === executor.id);
    assert.deepEqual([listed.type, listed.label, listed.sources], ["beta", "新执行器", { own: false, apis: ["openai-completions"] }]);
  });

  test("an agent that is ready gets one executor of its own, however it became ready", async () => {
    const h = settingsHarness();
    const alpha = { type: "alpha", label: "甲" };
    const beta = { type: "beta", label: "乙" };
    assert.deepEqual(ensureExecutors(h.store, [alpha]).map((e) => [e.type, e.name, e.settings]), [["alpha", "甲", {}]]);
    assert.deepEqual(ensureExecutors(h.store, [alpha]), [], "a second pass makes nothing");

    // an extra setup of alpha is not a reason to skip beta, and its name does not clash with beta's own
    await h.settings.createExecutor({ name: "乙", type: "alpha", settings: { path: "/opt/alpha-beta" } });
    assert.deepEqual(ensureExecutors(h.store, [alpha, beta]).map((e) => [e.type, e.name]), [["beta", "乙 2"]]);
    assert.deepEqual(h.store.listExecutors().map((e) => e.type), ["alpha", "alpha", "beta"]);
  });

  test("an endpoint's models are listed per agent that drives it, and a preset's before there is a key", async () => {
    const h = settingsHarness();
    const provider = await h.settings.createProvider({ name: "DS", preset: "deepseek", key: "sk-xxxxxxxxxxxxxx" });
    const saved = await h.settings.providerModels(provider.id);
    assert.deepEqual(
      saved.groups.map((g) => [g.type, g.models.map((m) => [m.id, m.available, m.contextWindow])]),
      [["beta", [["ds-flash", true, 1_000_000], ["ds-pro", true, 1_000_000]]]],
      "alpha speaks another protocol, so only beta's catalog applies",
    );
    const preview = await h.settings.presetModels("deepseek");
    assert.deepEqual(preview.groups[0].models.map((m) => m.available), [false, false], "no key yet, nothing is available");
    await assert.rejects(h.settings.presetModels("nope"), (err) => err instanceof Rejection && err.status === 404);

    const custom = await h.settings.createProvider({
      name: "网关",
      preset: "custom",
      api: "openai-completions",
      base_url: "https://a.example/v1",
      models: ["m1"],
      key: "k1-aaaaaaaaaaaa",
    });
    // beta's catalog knows nothing of it, so its own list stands in
    assert.deepEqual((await h.settings.providerModels(custom.id)).groups.map((g) => [g.type, g.models.map((m) => m.id)]), [["beta", ["m1"]]]);
  });

  test("a check brings back the ids the endpoint listed", async () => {
    const server = createServer((req, res) => {
      if (req.headers.authorization !== "Bearer good") return res.writeHead(401).end();
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [{ id: "a" }, { id: "b" }] }));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const endpoint = { id: "x", name: "x", preset: "custom", api: "openai-completions", baseUrl: `http://127.0.0.1:${server.address().port}/v1` };
      assert.deepEqual(await checkEndpoint({ ...endpoint, apiKey: "good" }), { ok: true, detail: "连上了，API 列出 2 个模型", models: ["a", "b"] });
      assert.deepEqual(await checkEndpoint({ ...endpoint, apiKey: "bad" }), { ok: false, detail: "密钥被拒绝（401）" });
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
  pkg("code", { api: 1, entry: "./index.js" }, {
    "index.js": `export const harness = { type: "coded", label: "Coded", sources: { own: false, apis: ["openai-completions"] }, capabilities: () => ({}), fields: [], create: () => ({}) };`,
  });
  const acp = pkg("agent", { api: 1, type: "fake", label: "Fake Agent", acp: { command: ["node", "./agent.mjs"] } });
  copyFileSync(fileURLToPath(new URL("./fixtures/acp-agent.mjs", import.meta.url)), join(acp, "agent.mjs"));
  pkg("old", { api: 0, entry: "./index.js" }, { "index.js": "export const harness = {};" });
  pkg("broken", { api: 1, type: "gone", acp: { command: ["node", "some-package/bin/agent.js"] } });
  return root;
}

describe("extensions", () => {
  test("a root is scanned: code exports a type, a manifest becomes an ACP type, the rest say why not", async () => {
    const ext = new Extensions([{ dir: extensionRoot(), origin: "linked" }]);
    const loaded = await ext.load();
    const byName = Object.fromEntries(loaded.map((e) => [e.name, e]));
    assert.equal(byName["@test/code"].type, "coded");
    assert.equal(byName["@test/agent"].type, "fake");
    assert.equal(byName["@test/agent"].label, "Fake Agent");
    assert.match(byName["@test/old"].error, /契约 v0/);
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
    const executor = store.createExecutor({ name: "假 agent", type: "fake", settings: {} });
    const registry = Registry.from(ext.types(), store.listExecutors());
    const sources = new Sources(store, secrets, () => registry, async () => []);
    const pushed = [];
    const attachments = new AttachmentStore(join(dir, "attachments"));
    const orch = new Orchestrator(store, (m) => pushed.push(m), registry, sources, attachments);
    const bot = store.createBot({ name: "甲", title: null, avatar: null, system_prompt: "be brief", executor_id: executor.id, model_source: null, model: null, permission_tier: "read" });
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
    assert.deepEqual(status.options[member.id].models.map((m) => [m.id, m.source]), [["m1", null], ["m2", null]]);
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

    const login = await registry.get(executor.id).login();
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
      const fake = ext.types().find((t) => t.type === "fake").create({ id: "x", label: "假 agent", settings: {} });
      const login = await fake.login();
      assert.equal(login.state, "none");
      const check = await fake.check({ kind: "own" });
      assert.equal(check.ok, false);
      assert.match(check.detail, /没有登录/);
    } finally {
      delete process.env.FAKE_ACP_LOGGED_OUT;
    }
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
