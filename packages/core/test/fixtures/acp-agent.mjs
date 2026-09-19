// A minimal ACP agent over stdio, enough to drive the host end to end: it
// greets, edits one file behind a permission request when asked to, says what
// images it was handed, and reports usage.
import { createInterface } from "node:readline";

const out = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
const notify = (method, params) => out({ jsonrpc: "2.0", method, params });
const reply = (id, result) => out({ jsonrpc: "2.0", id, result });
const fail = (id, code, message, data) => out({ jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } });

let nextId = 100;
const pending = new Map();
const request = (method, params) =>
  new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    out({ jsonrpc: "2.0", id, method, params });
  });

const loggedOut = process.env.FAKE_ACP_LOGGED_OUT === "1";
// an agent that can only resume a session, never load one
const resumable = process.env.FAKE_ACP_RESUME === "1";
// an agent routing to several providers names each model as a provider/model pair
const paired = process.env.FAKE_ACP_PAIRED === "1";
const modelId = (id) => (paired ? JSON.stringify(["fake", id]) : id);
let resumed = false;
let options = [
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: modelId("m1"),
    options: [
      { value: modelId("m1"), name: "Model One" },
      { value: modelId("m2"), name: "Model Two" },
    ],
  },
];
const ONCE = [
  { optionId: "allow", name: "Yes", kind: "allow_once" },
  { optionId: "reject", name: "No", kind: "reject_once" },
];
const modes = { currentModeId: "ask", availableModes: [{ id: "ask", name: "Ask" }, { id: "yolo", name: "Yolo" }] };
let cancelPrompt = null;
/** what the client put in the session's _meta, said back when a prompt asks for #meta */
let sessionMeta = null;

// a real agent's log on the way down: colored, with one line carrying a whole response body
const noise = `\x1b[2m2026-09-16T17:13:48Z\x1b[0m \x1b[31mERROR\x1b[0m models: failed to decode; body: {"models":[${'"x",'.repeat(50_000)}]}\n`;

function failTurn(id, text) {
  process.stderr.write(noise);
  if (text.includes("#crash")) {
    // no newline: the last words of a dying process are often an unfinished line
    process.stderr.write("thread 'main' panicked: out of cheese", () => setTimeout(() => process.exit(3), 50));
    return;
  }
  const data = text.includes("#fail-details")
    ? { details: "spawn codex ENOENT" }
    : {
        message: JSON.stringify({ type: "error", status: 400, error: { type: "invalid_request_error", message: "The 'm9' model is not supported" } }),
        codex_error_info: "other",
      };
  fail(id, -32603, "Internal error", data);
}

async function prompt(id, params) {
  const sessionId = params.sessionId;
  const text = params.prompt.map((b) => b.text ?? "").join("");
  if (text.includes("#fail") || text.includes("#crash")) return failTurn(id, text);
  const update = (u) => notify("session/update", { sessionId, update: u });
  update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi " } });
  if (text.includes("#meta")) update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: `meta ${JSON.stringify(sessionMeta)} ` } });
  if (text.includes("#env")) update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: `env ${process.env.FAKE_PINNED} ${process.env.FAKE_PLAIN} ` } });
  if (text.includes("#vars")) update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: `key=${process.env.FAKE_KEY} url=${process.env.FAKE_URL} ` } });
  if (text.includes("#session")) update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: `session ${sessionId} resumed ${resumed} ` } });
  const images = params.prompt.filter((b) => b.type === "image" && b.data);
  if (images.length > 0) {
    update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: `saw ${images.map((b) => b.mimeType).join(",")} ` } });
  }
  let cancelled = false;
  cancelPrompt = () => {
    cancelled = true;
  };
  if (text.includes("#write")) {
    update({ sessionUpdate: "tool_call", toolCallId: "t1", title: "Edit notes.md", kind: "edit", status: "pending", rawInput: { path: "notes.md" } });
    const always = [
      { optionId: "allow-always", name: "Always", kind: "allow_always" },
      { optionId: "reject-always", name: "Never", kind: "reject_always" },
    ];
    // some agents list the lasting choices first, and #always-only offers nothing else; either way it says what it got
    const offered = text.includes("#always-only") ? always : text.includes("#always-first") ? [...always, ...ONCE] : ONCE;
    const r = await request("session/request_permission", {
      sessionId,
      toolCall: { toolCallId: "t1", kind: "edit", rawInput: { path: "notes.md" } },
      options: offered,
    });
    const picked = r?.outcome?.outcome === "selected" ? offered.find((o) => o.optionId === r.outcome.optionId) : undefined;
    const allowed = picked?.kind === "allow_once" || picked?.kind === "allow_always";
    if (offered !== ONCE) update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: `answered ${picked?.optionId ?? r?.outcome?.outcome} ` } });
    update({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: allowed ? "completed" : "failed", rawOutput: allowed ? "ok" : "denied" });
  }
  if (text.includes("#bare")) {
    // what the call is was said once, in tool_call; the ask names it by id alone
    update({ sessionUpdate: "tool_call", toolCallId: "t2", title: "write", kind: "other", status: "pending", rawInput: { file_path: "notes.md" } });
    const r = await request("session/request_permission", { sessionId, toolCall: { toolCallId: "t2" }, options: ONCE });
    const allowed = r?.outcome?.outcome === "selected" && r.outcome.optionId === "allow";
    update({ sessionUpdate: "tool_call_update", toolCallId: "t2", status: allowed ? "completed" : "failed", rawOutput: allowed ? "ok" : "denied" });
  }
  update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: cancelled ? "" : "done" } });
  update({ sessionUpdate: "usage_update", used: 1200, size: 100000 });
  cancelPrompt = null;
  reply(id, { stopReason: cancelled ? "cancelled" : "end_turn" });
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.id !== undefined && msg.method === undefined) {
    pending.get(msg.id)?.(msg.result);
    pending.delete(msg.id);
    return;
  }
  const { id, method, params } = msg;
  switch (method) {
    case "initialize": {
      const authMethods = [{ id: "fake-login", name: "Log in", description: "Run fake login", type: "terminal", args: ["login"] }];
      // the older terminal-auth convention: an agent method naming a command, offered to a client that says it shows one
      if (params.clientCapabilities?._meta?.["terminal-auth"] === true) {
        authMethods.push({ id: "fake-meta-login", name: "Log in with fake", _meta: { "terminal-auth": { command: "fake-cli", args: ["auth", "login"] } } });
      }
      reply(id, {
        protocolVersion: 1,
        agentCapabilities: { loadSession: false, promptCapabilities: { image: true }, ...(resumable ? { sessionCapabilities: { resume: {} } } : {}) },
        authMethods,
      });
      notify("_auth/status_update", { authStatus: loggedOut ? { kind: "none", label: "Not logged in" } : { kind: "subscription", label: "Pro" } });
      return;
    }
    case "session/new":
      if (loggedOut) return fail(id, -32000, "Authentication required");
      sessionMeta = params._meta ?? null;
      reply(id, { sessionId: "s1", configOptions: options, modes });
      notify("session/update", {
        sessionId: "s1",
        update: {
          sessionUpdate: "available_commands_update",
          availableCommands: [
            { name: "compact", description: "Compact" },
            { name: "review", description: "Review changes", input: { hint: "<branch>" } },
          ],
        },
      });
      return;
    case "session/resume":
      if (!resumable) return fail(id, -32601, "no such method session/resume");
      resumed = true;
      reply(id, { configOptions: options, modes });
      return;
    case "session/set_config_option":
      options = options.map((o) => (o.id === params.configId ? { ...o, currentValue: params.value } : o));
      reply(id, { configOptions: options });
      return;
    case "session/set_mode":
      modes.currentModeId = params.modeId;
      reply(id, {});
      return;
    case "session/prompt":
      void prompt(id, params);
      return;
    case "session/cancel":
      cancelPrompt?.();
      return;
    case "authenticate":
      reply(id, {});
      return;
    default:
      if (id !== undefined) fail(id, -32601, `no such method ${method}`);
  }
});
rl.on("close", () => process.exit(0));
