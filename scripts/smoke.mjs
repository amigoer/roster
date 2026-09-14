/** End-to-end smoke test: boot core, talk to a real bot, assert the log. */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ROSTER_DATA_DIR names a data dir with at least one bot set up; extensions are linked from packages/
const dataDir = process.env.ROSTER_DATA_DIR ?? mkdtempSync(join(tmpdir(), "roster-smoke-"));
const workDir = mkdtempSync(join(tmpdir(), "roster-work-"));
const log = console.log;

const core = spawn(process.execPath, ["packages/core/dist/main.js"], {
  env: { ...process.env, ROSTER_DATA_DIR: dataDir, ROSTER_EXTENSIONS: process.env.ROSTER_EXTENSIONS ?? "packages", ROSTER_PORT: "0" },
  stdio: ["ignore", "pipe", "pipe"],
});
core.stderr.on("data", (d) => process.stderr.write(`[core] ${d}`));

const base = await new Promise((resolve, reject) => {
  let buf = "";
  core.stdout.on("data", (d) => {
    buf += d;
    for (const line of buf.split("\n")) {
      try {
        const m = JSON.parse(line);
        if (m.roster === "ready") resolve(m.url);
      } catch {}
    }
  });
  setTimeout(() => reject(new Error("core never reported ready")), 15_000);
});
log(`core up at ${base}`);

const j = async (p, init) => {
  const r = await fetch(new URL(p, base), {
    ...init,
    headers: init?.body ? { "content-type": "application/json" } : undefined,
  });
  return r.json();
};

const fails = [];
const check = (name, ok) => {
  log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) fails.push(name);
};

// collect the SSE stream in the background, the way the UI does
const seen = [];
const es = await fetch(new URL("/api/stream", base));
void (async () => {
  const reader = es.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    for (const line of buf.split("\n")) {
      if (line.startsWith("data: ")) {
        try {
          seen.push(JSON.parse(line.slice(6)));
        } catch {}
      }
    }
    buf = buf.slice(buf.lastIndexOf("\n") + 1);
  }
})();

try {
  // nothing is seeded any more: the bots live in the data dir this is pointed at
  const state = await j("/api/state");
  const bot = state.bots.find((b) => process.env.ROSTER_SMOKE_BOT ? b.name === process.env.ROSTER_SMOKE_BOT : true);
  check("a bot exists to talk to (set up an agent and a bot on it first)", Boolean(bot));
  if (!bot) throw new Error("no bot");
  log(`talking to ${bot.name} on ${state.executors.find((e) => e.id === bot.executor_id)?.label ?? bot.executor_id}`);

  const { conversation } = await j("/api/conversations", {
    method: "POST",
    body: JSON.stringify({ title: "smoke", repoPath: workDir, botIds: [bot.id] }),
  });
  check("conversation created as a one-member group", conversation.shape === "direct");

  log("sending a real prompt to the model...");
  await j(`/api/conversations/${conversation.id}/messages`, {
    method: "POST",
    body: JSON.stringify({ text: "用三句话解释什么是 git worktree。" }),
  });

  // wait for the bot's finalized reply to land as a row
  const deadline = Date.now() + 90_000;
  let msgs = [];
  while (Date.now() < deadline) {
    msgs = (await j(`/api/conversations/${conversation.id}/messages`)).messages;
    if (msgs.some((m) => m.author_kind === "bot" && m.card_kind === "text")) break;
    await new Promise((r) => setTimeout(r, 1000));
  }

  const human = msgs.find((m) => m.author_kind === "human");
  const bot = msgs.find((m) => m.author_kind === "bot" && m.card_kind === "text");
  check("human message persisted", Boolean(human));
  check("bot reply persisted as one finalized row", Boolean(bot));
  if (bot) log(`   bot said: ${JSON.parse(bot.body_json).text.slice(0, 120)}`);

  // the invariant: many deltas on the wire collapse to exactly one stored row
  const deltas = seen.filter((s) => s.kind === "delta").length;
  const botRows = msgs.filter((m) => m.author_kind === "bot" && m.card_kind === "text").length;
  check(`${deltas} deltas collapsed into ${botRows} stored row`, deltas > 5 && botRows === 1);

  const convs = (await j("/api/state")).conversations;
  check("conversation returns to waiting_input", convs[0]?.attention === "waiting_input");
  check("run_state back to idle", convs[0]?.run_state === "idle");
} finally {
  core.kill("SIGTERM");
  if (!process.env.ROSTER_DATA_DIR) rmSync(dataDir, { recursive: true, force: true });
  rmSync(workDir, { recursive: true, force: true });
}

log(fails.length ? `\n${fails.length} FAILED` : "\nall green");
process.exit(fails.length ? 1 : 0);
