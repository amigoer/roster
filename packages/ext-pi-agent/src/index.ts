import { readFile } from "node:fs/promises";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  VERSION,
} from "@earendil-works/pi-coding-agent";
import type {
  Attachment,
  BotRuntime,
  BotRuntimeFactory,
  Capabilities,
  Deliver,
  HarnessType,
  InstanceConfig,
  ModelSource,
  NormalizedEvent,
  ProviderConfig,
  ProviderPreset,
  SessionInfo,
  SessionOptions,
  StartOpts,
  ToolCall,
  ToolEffect,
  Unsubscribe,
} from "@roster/adapter-api";

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
/** Past this most provider APIs refuse the whole request, so the image is left to its path in the text. */
const IMAGE_MAX_BYTES = 3_750_000;

/** pi swaps these for a placeholder itself when the model takes no images. */
async function imagesOf(attachments: readonly Attachment[]): Promise<Array<{ type: "image"; data: string; mimeType: string }>> {
  const out = [];
  for (const a of attachments) {
    if (!IMAGE_TYPES.has(a.mime) || a.size > IMAGE_MAX_BYTES) continue;
    const data = await readFile(a.path).catch(() => null);
    if (data) out.push({ type: "image" as const, data: data.toString("base64"), mimeType: a.mime });
  }
  return out;
}

/**
 * pi-agent runs on whatever endpoint the bot names, and only on that: its own
 * auth file is not consulted, so one code path serves every bot. It has no
 * sign-in of its own to offer.
 */

/** The preset id of an endpoint a person described by hand. */
const CUSTOM_PRESET = "custom";

/**
 * pi's built-in tool names are a closed set, so the effect classification that
 * drives the permission tier and the write lock is a table, not a guess.
 * Unknown tools come from extensions and are treated as the worst case.
 */
const EFFECTS: Record<string, ToolEffect> = {
  read: "read",
  ls: "read",
  grep: "read",
  find: "read",
  write: "write",
  edit: "write",
  bash: "execute",
  powershell: "execute",
};

const effectOf = (name: string): ToolEffect => EFFECTS[name] ?? "execute";

export const PI_CAPABILITIES: Capabilities = {
  interceptToolCall: true,
  // tool_call exposes event.input as mutable and documents in-place patching
  mutateToolInput: true,
  midRunInject: ["steer", "followUp"],
  // pi has no maxBudgetUsd/maxTurns equivalent; the ceiling has to live in core
  costLimit: false,
  mcp: false,
  branch: true,
  permissionModes: false,
};

type Session = Awaited<ReturnType<typeof createAgentSession>>["session"];
type ProviderInput = Parameters<ModelRuntime["registerProvider"]>[1];
type ModelInput = NonNullable<ProviderInput["models"]>[number];
type PiModel = Awaited<ReturnType<ModelRuntime["getAvailable"]>>[number];

/** Everything pi's catalog speaks; a custom endpoint on any of these can be used. */
const PI_APIS = [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "google-generative-ai",
  "mistral-conversations",
  "azure-openai-responses",
  "bedrock-converse-stream",
  "google-vertex",
  "openai-codex-responses",
] as const;

/** Providers whose "key" is really cloud credentials or an account-scoped setup, which one pasted key cannot stand in for. */
const NOT_KEY_ONLY = new Set([
  "amazon-bedrock",
  "google-vertex",
  "azure-openai-responses",
  "cloudflare-ai-gateway",
  "cloudflare-workers-ai",
  "github-copilot",
]);

/**
 * pi reads a key as a template: a leading "!" runs the rest as a shell command
 * and "$NAME" pulls in an environment variable. A key a person pasted is
 * neither, so it goes in escaped.
 */
export const literal = (value: string): string => {
  const escaped = value.replaceAll("$", () => "$$");
  return escaped.startsWith("!") ? `$${escaped}` : escaped;
};

/** The id pi knows an endpoint by: its own for a preset, ours for a custom endpoint. */
const piIdOf = (p: ProviderConfig): string => (p.preset === CUSTOM_PRESET ? p.id : p.preset);

/** The protocol most of a provider's models speak; a preset is filed under it. */
function mainApi(models: readonly PiModel[]): string | undefined {
  const tally = new Map<string, number>();
  for (const m of models) tally.set(m.api, (tally.get(m.api) ?? 0) + 1);
  return [...tally.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
}

/** An id pi has no settings for gets modest, generic limits any endpoint takes. */
const genericModel = (id: string, api?: string): ModelInput => ({
  id,
  name: id,
  ...(api ? { api: api as NonNullable<ModelInput["api"]> } : {}),
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 16_384,
});

/** A bare id, or one prefixed with the provider pi knows the endpoint by. */
function bareId(id: string, endpoint: ProviderConfig): string {
  const provider = piIdOf(endpoint);
  return id.startsWith(`${provider}/`) ? id.slice(provider.length + 1) : id;
}

/**
 * A model runtime whose only models on the endpoint are the ones its API
 * listed, plus the one a bot asked for by hand. For an id pi's own catalog
 * also knows, pi keeps its request settings for it; nothing else of that
 * catalog shows. Keys stay in memory: registering one never writes to pi's
 * auth file.
 */
async function modelRuntime(endpoint: ProviderConfig, wanted?: string): Promise<ModelRuntime> {
  const runtime = await ModelRuntime.create();
  const p = endpoint;
  const apiKey = p.apiKey ? literal(p.apiKey) : undefined;
  const headers = p.headers ? Object.fromEntries(Object.entries(p.headers).map(([k, v]) => [k, literal(v)])) : undefined;
  const common = { ...(apiKey ? { apiKey } : {}), ...(headers ? { headers } : {}) };
  const ids = [...new Set([...(p.models ?? []), ...(wanted ? [bareId(wanted, p)] : [])])];
  if (p.preset !== CUSTOM_PRESET && runtime.getProvider(p.preset)) {
    const known = runtime.getModels(p.preset);
    const api = mainApi(known);
    runtime.registerProvider(p.preset, { ...common, models: ids.map((id) => known.find((m) => m.id === id) ?? genericModel(id, api)) });
    return runtime;
  }
  runtime.registerProvider(p.id, {
    ...common,
    name: p.name,
    ...(p.baseUrl ? { baseUrl: p.baseUrl } : {}),
    ...(p.api ? { api: p.api as NonNullable<ProviderInput["api"]> } : {}),
    models: ids.map((id) => genericModel(id)),
  });
  return runtime;
}

/** The model a session runs: the one asked for, else the first the endpoint listed. Undefined without a key to call it with. */
async function resolveModel(runtime: ModelRuntime, id: string | undefined, endpoint: ProviderConfig): Promise<PiModel | undefined> {
  const bare = id ? bareId(id, endpoint) : endpoint.models?.[0];
  return (await runtime.getAvailable()).find((m) => m.provider === piIdOf(endpoint) && m.id === bare);
}

/** What this adapter says to a person. */
const WORDS = {
  en: {
    noKey: (name: string) => `pi: “${name}” has no key to use`,
    noModels: (name: string) => `pi: “${name}” lists no models through its API; pick a model for the agent or bot`,
    noOwn: "pi-agent has no sign-in of its own; connect it to a model API",
    models: (count: number) => (count === 1 ? "1 model to pick from" : `${count} models to pick from`),
    unlisted: "The API lists no models; pick one for the agent or bot",
  },
  "zh-CN": {
    noKey: (name: string) => `pi: 「${name}」没有可用的密钥`,
    noModels: (name: string) => `pi: 「${name}」的 API 没有列出模型，给 agent 或 bot 指定一个模型`,
    noOwn: "pi-agent 没有自带登录，要接一个模型 API",
    models: (count: number) => `${count} 个模型可选`,
    unlisted: "API 没有列出模型，要给 agent 或 bot 指定一个",
  },
};

type Words = (typeof WORDS)["en"];

/** Any Chinese the host asks for reads the Simplified text; anything else reads English. */
const wordsFor = (locale: string | undefined): Words => (locale?.toLowerCase().startsWith("zh") ? WORDS["zh-CN"] : WORDS.en);

class PiRuntime implements BotRuntime {
  readonly capabilities = PI_CAPABILITIES;

  constructor(
    private endpoint: ProviderConfig,
    private words: Words,
  ) {}

  #session: Session | undefined;
  #unsubscribe: (() => void) | undefined;
  #handlers = new Set<(e: NormalizedEvent) => void>();
  #resumeToken: string | undefined;
  #running = false;
  #aborting = false;
  #failed = false;

  subscribe(handler: (e: NormalizedEvent) => void): Unsubscribe {
    this.#handlers.add(handler);
    return () => this.#handlers.delete(handler);
  }

  #emit(e: NormalizedEvent): void {
    for (const h of this.#handlers) h(e);
  }

  async start(opts: StartOpts): Promise<void> {
    if (this.#session) throw new Error("pi runtime already started");

    const runtime = await modelRuntime(this.endpoint, opts.model);
    const model = await resolveModel(runtime, opts.model, this.endpoint);
    if (!model) {
      // an id asked for or listed is registered, so only the key can be missing
      throw new Error(
        opts.model || this.endpoint.models?.length ? this.words.noKey(this.endpoint.name) : this.words.noModels(this.endpoint.name),
      );
    }

    const onToolCall = opts.onToolCall;
    const preset = opts.systemPrompt?.trim();
    const resourceLoader = new DefaultResourceLoader({
      cwd: opts.cwd,
      agentDir: getAgentDir(),
      // the user's own extensions are theirs; the gate must be the only one here
      noExtensions: true,
      // an override rather than appendSystemPrompt: that option treats any
      // string naming an existing file as a path to read
      ...(preset ? { appendSystemPromptOverride: (base: string[]) => [...base, preset] } : {}),
      extensionFactories: [
        {
          name: "roster-gate",
          factory: (pi) => {
            pi.on("tool_call", async (event) => {
              if (!onToolCall) return;
              const call: ToolCall = {
                id: event.toolCallId,
                name: event.toolName,
                input: event.input as Record<string, unknown>,
                effect: effectOf(event.toolName),
              };
              // This await can last as long as a human takes; pi imposes no timeout.
              const decision = await onToolCall(call);
              if (decision.action === "deny") {
                return decision.terminate === undefined
                  ? { block: true, reason: decision.reason }
                  : { block: true, reason: decision.reason, terminate: decision.terminate };
              }
              if (decision.action === "allow" && decision.input) {
                // pi reads arguments off the same object, so patch in place
                const target = event.input as Record<string, unknown>;
                for (const k of Object.keys(target)) delete target[k];
                Object.assign(target, decision.input);
              }
              return;
            });
          },
        },
      ],
    });
    await resourceLoader.reload();

    const created = await createAgentSession({
      cwd: opts.cwd,
      model,
      modelRuntime: runtime,
      resourceLoader,
      ...(opts.tools ? { tools: [...opts.tools] } : {}),
      // a persistent manager, not inMemory: "关掉再打开上下文还在" is core design #1
      sessionManager: opts.resumeToken
        ? SessionManager.open(opts.resumeToken)
        : SessionManager.create(opts.cwd),
    });
    this.#session = created.session;
    this.#resumeToken = created.session.sessionManager?.getSessionFile?.() ?? undefined;
    this.#unsubscribe = created.session.subscribe((event) => this.#normalize(event));
    // a timer, because the host only starts listening once this call has returned
    const info: SessionInfo = { model: `${model.provider}/${model.id}`, modelLabel: model.id, effort: null };
    setTimeout(() => this.#emit({ type: "session.info", display: "status", info }), 0);
  }

  #normalize(event: { type: string } & Record<string, unknown>): void {
    switch (event.type) {
      // pi's turn_start/turn_end wrap each model call inside a run; the
      // contract's turn is the whole run, which ends at agent_settled
      case "agent_start":
        this.#emit({ type: "turn.start", display: "status" });
        return;
      case "agent_end": {
        if (event["willRetry"] === true) return;
        const messages = (event["messages"] ?? []) as Array<{
          role?: string;
          stopReason?: string;
          errorMessage?: string;
        }>;
        const last = messages.filter((m) => m.role === "assistant").at(-1);
        if (last?.stopReason === "error") {
          this.#failed = true;
          this.#emit({
            type: "error",
            display: "message",
            message: last.errorMessage ?? "pi: the model call failed",
          });
        }
        return;
      }
      case "agent_settled": {
        const reason = this.#aborting ? "aborted" : this.#failed ? "error" : "done";
        this.#running = false;
        this.#aborting = false;
        this.#failed = false;
        this.#emit({ type: "turn.end", display: "status", reason });
        return;
      }
      case "message_update": {
        const inner = event["assistantMessageEvent"] as
          | { type: string; delta?: string; usage?: { input?: number; output?: number } }
          | undefined;
        if (!inner) return;
        if (inner.type === "text_delta" && inner.delta !== undefined) {
          this.#emit({ type: "assistant.text", display: "message", delta: inner.delta });
        } else if (inner.type === "thinking_delta" && inner.delta !== undefined) {
          this.#emit({ type: "assistant.thinking", display: "fold", delta: inner.delta });
        } else if (inner.type === "done" && inner.usage) {
          this.#emit({
            type: "cost",
            display: "status",
            ...(inner.usage.input !== undefined ? { inputTokens: inner.usage.input } : {}),
            ...(inner.usage.output !== undefined ? { outputTokens: inner.usage.output } : {}),
          });
        }
        return;
      }
      case "tool_execution_start":
        this.#emit({
          type: "tool.start",
          display: "fold",
          call: {
            id: String(event["toolCallId"]),
            name: String(event["toolName"]),
            input: (event["args"] ?? {}) as Record<string, unknown>,
            effect: effectOf(String(event["toolName"])),
          },
        });
        return;
      case "tool_execution_update":
        this.#emit({
          type: "tool.update",
          display: "fold",
          id: String(event["toolCallId"]),
          chunk: stringify(event["partialResult"]),
        });
        return;
      case "tool_execution_end":
        this.#emit({
          type: "tool.end",
          display: "fold",
          id: String(event["toolCallId"]),
          isError: Boolean(event["isError"]),
          content: stringify(event["result"]),
        });
        return;
      default:
        return;
    }
  }

  async send(text: string, deliver: Deliver = "now", attachments: readonly Attachment[] = []): Promise<void> {
    const session = this.#session;
    if (!session) throw new Error("pi runtime not started");
    // Roster delivers text verbatim; a message starting with "/" is not a command
    const expandPromptTemplates = false;
    const images = await imagesOf(attachments);
    // pi's own state, not one derived from turn events: a second message can
    // arrive before agent_start lands, and a bare prompt() would then throw
    if (session.isStreaming) {
      // "now" means "as soon as you can", which is followUp -- interrupting is a separate intent
      await session.prompt(text, {
        expandPromptTemplates,
        images,
        streamingBehavior: deliver === "steer" ? "steer" : "followUp",
      });
      return;
    }
    // prompt() only resolves once the whole run settles, but send() must return
    // on acceptance; preflight failures (no auth, bad model) still reject here
    await new Promise<void>((resolve, reject) => {
      let accepted = false;
      this.#running = true;
      session
        .prompt(text, {
          expandPromptTemplates,
          images,
          preflightResult: (ok) => {
            if (!ok) return;
            accepted = true;
            resolve();
          },
        })
        .catch((err: unknown) => {
          if (!accepted) {
            this.#running = false;
            reject(err);
            return;
          }
          // the run already settled and ended its turn; keep the reason visible
          this.#emit({
            type: "error",
            display: "message",
            message: err instanceof Error ? err.message : String(err),
          });
        });
    });
  }

  async abort(): Promise<void> {
    if (!this.#session || !this.#running) return;
    this.#aborting = true;
    await this.#session.abort();
  }

  get resumeToken(): string | undefined {
    return this.#resumeToken;
  }

  async dispose(): Promise<void> {
    this.#unsubscribe?.();
    this.#session?.dispose();
    this.#session = undefined;
    this.#handlers.clear();
  }
}

function stringify(v: unknown): string {
  if (typeof v === "string") return v;
  if (v === undefined || v === null) return "";
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

const endpointOf = (source: ModelSource, words: Words): ProviderConfig => {
  if (source.kind !== "endpoint") throw new Error(words.noOwn);
  return source.endpoint;
};

function piExecutor(instance: InstanceConfig): BotRuntimeFactory {
  const words = wordsFor(instance.locale);
  const endpoint = endpointOf(instance.source, words);
  const listed = endpoint.models ?? [];
  return {
    id: instance.id,
    label: instance.label,
    type: "pi-agent",
    capabilities: PI_CAPABILITIES,
    create: () => new PiRuntime(endpoint, words),
    async sessionInfo({ model }): Promise<SessionInfo> {
      const hit = await resolveModel(await modelRuntime(endpoint, model), model, endpoint);
      return hit ? { model: `${hit.provider}/${hit.id}`, modelLabel: hit.id, effort: null } : {};
    },
    async sessionOptions(): Promise<SessionOptions> {
      return {
        models: endpoint.apiKey ? listed.map((id) => ({ id, resolved: `${piIdOf(endpoint)}/${id}`, label: id, efforts: [] })) : [],
        efforts: [],
        modes: [],
        compact: false,
      };
    },
    // whether the key works is the endpoint's to say; this only proves pi can be set up on it
    async check() {
      await modelRuntime(endpoint);
      return { ok: true, detail: listed.length > 0 ? words.models(listed.length) : words.unlisted };
    },
  };
}

/** pi-agent as a harness type: runs on the endpoint its executor names, nothing else. */
export const piHarness: HarnessType = {
  type: "pi-agent",
  label: "pi-agent",
  version: VERSION,
  sources: { own: false, apis: PI_APIS },
  capabilities: () => PI_CAPABILITIES,
  async presets(): Promise<ProviderPreset[]> {
    const runtime = await ModelRuntime.create();
    const presets = await Promise.all(
      runtime.getProviders().map(async (p) => {
        const keyLabel = (p.auth as { apiKey?: { name?: string } } | undefined)?.apiKey?.name;
        // pi's models only tell which protocol the provider speaks; which ones it serves is its API's to say
        const api = mainApi(await p.getModels());
        if (!keyLabel || NOT_KEY_ONLY.has(p.id) || !api) return null;
        return { id: p.id, label: p.name ?? p.id, api, ...(p.baseUrl ? { baseUrl: p.baseUrl } : {}), keyLabel };
      }),
    );
    return presets.filter((p) => p !== null);
  },
  create: piExecutor,
};

export const harness = piHarness;
