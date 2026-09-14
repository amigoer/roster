import type { HarnessType, LoginState, ModelOption, ModelSource, ProviderConfig, ProviderPreset, SourceKind } from "@roster/adapter-api";
import { Rejection } from "./errors.js";
import type { Registry } from "./registry.js";
import type { Secrets } from "./secrets.js";
import { CUSTOM_PRESET, envVar, fits, providerConfigOf } from "./sources.js";
import type { ExecutorInput, ExecutorRow, ProviderInput, ProviderRow, Store } from "./store.js";

const PRESETS_REUSE_MS = 10 * 60_000;
const LOGIN_REUSE_MS = 30_000;
const CHECK_TIMEOUT_MS = 8_000;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

type Body = Record<string, unknown>;

const text = (v: unknown, max: number): string | null => {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
};

export interface CheckItem {
  label: string;
  ok: boolean;
  detail: string;
}

/** An endpoint check also brings back the ids the endpoint listed, when it lists any. */
export type EndpointCheck = Omit<CheckItem, "label"> & { models?: string[] };

/** The models one agent offers from an endpoint. */
export interface CatalogGroup {
  type: string;
  label: string;
  models: ModelOption[];
}

/** Where an endpoint's model list lives, and how to prove a key to it — one per wire protocol. */
function endpointRequest(p: ProviderConfig, preset?: ProviderPreset): { url: string; headers: Record<string, string> } | null {
  const baseUrl = (p.baseUrl ?? preset?.baseUrl)?.replace(/\/+$/, "");
  const api = p.api ?? preset?.api;
  if (!baseUrl || !p.apiKey) return null;
  if (api === "anthropic-messages") {
    return {
      url: `${baseUrl}/v1/models`,
      headers:
        p.preset === CUSTOM_PRESET
          ? { authorization: `Bearer ${p.apiKey}`, "anthropic-version": "2023-06-01" }
          : { "x-api-key": p.apiKey, "anthropic-version": "2023-06-01" },
    };
  }
  if (api === "openai-completions" || api === "openai-responses" || api === "mistral-conversations") {
    return { url: `${baseUrl}/models`, headers: { authorization: `Bearer ${p.apiKey}` } };
  }
  if (api === "google-generative-ai") {
    // the Generative Language API takes its key on the query string, not a header
    return { url: `${baseUrl}/models?key=${encodeURIComponent(p.apiKey)}`, headers: {} };
  }
  return null;
}

/** OpenAI-shaped `{ data: [{ id }] }` or Gemini-shaped `{ models: [{ name: "models/x" }] }`. */
function parseModelIds(body: unknown): string[] | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (Array.isArray(b["data"])) {
    return b["data"]
      .map((m) => (m && typeof m === "object" ? String((m as Record<string, unknown>)["id"] ?? "") : ""))
      .filter(Boolean);
  }
  if (Array.isArray(b["models"])) {
    return b["models"]
      .map((m) => {
        if (!m || typeof m !== "object") return "";
        const r = m as Record<string, unknown>;
        return String(r["name"] ?? r["id"] ?? "");
      })
      .map((s) => s.replace(/^models\//, ""))
      .filter(Boolean);
  }
  return null;
}

/**
 * Asks an endpoint for its model list: it is authenticated, so a bad key shows,
 * and it is free, so testing a setup never spends anything.
 */
export async function checkEndpoint(p: ProviderConfig, preset?: ProviderPreset): Promise<EndpointCheck> {
  if (!p.apiKey) return { ok: false, detail: "还没有可用的密钥" };
  const req = endpointRequest(p, preset);
  if (!req) {
    return (p.baseUrl ?? preset?.baseUrl)
      ? { ok: true, detail: "密钥已配置；这种协议没法不花钱地提前验证" }
      : { ok: true, detail: "密钥已配置，没有地址可以探测" };
  }
  try {
    const res = await fetch(req.url, { headers: { ...p.headers, ...req.headers }, signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) });
    if (res.status === 401 || res.status === 403) return { ok: false, detail: `密钥被拒绝（${res.status}）` };
    if (res.status === 404) return { ok: true, detail: "地址连得上，但它不提供模型列表，密钥要到第一次对话才知道对不对" };
    if (!res.ok) return { ok: false, detail: `API 返回 ${res.status}` };
    const models = parseModelIds(await res.json().catch(() => null));
    return models ? { ok: true, detail: `连上了，API 列出 ${models.length} 个模型`, models } : { ok: true, detail: "连上了" };
  } catch (err) {
    return { ok: false, detail: `连不上：${err instanceof Error ? err.message : String(err)}` };
  }
}

/** Same probe as checkEndpoint, but for actually populating the model list rather than just counting it. */
export async function fetchModels(p: ProviderConfig, preset?: ProviderPreset): Promise<{ ok: boolean; models?: string[]; detail: string }> {
  if (!p.apiKey) return { ok: false, detail: "还没有可用的密钥" };
  const req = endpointRequest(p, preset);
  if (!req) return { ok: false, detail: "这种协议不提供模型列表，手动填一下" };
  try {
    const res = await fetch(req.url, { headers: { ...p.headers, ...req.headers }, signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) });
    if (res.status === 401 || res.status === 403) return { ok: false, detail: `密钥被拒绝（${res.status}）` };
    if (!res.ok) return { ok: false, detail: `API 返回 ${res.status}` };
    const models = parseModelIds(await res.json().catch(() => null));
    if (!models || models.length === 0) return { ok: false, detail: "API 没有返回模型列表" };
    return { ok: true, models: [...new Set(models)].sort(), detail: `拉到 ${new Set(models).size} 个模型` };
  } catch (err) {
    return { ok: false, detail: `连不上：${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * Gives every agent a bot could run on an executor, so an agent that is ready
 * needs nothing more before bots are built on it. The oldest executor of a type
 * is the agent's own; any later one is an extra setup someone added.
 */
export function ensureExecutors(store: Store, usable: ReadonlyArray<Pick<HarnessType, "type" | "label">>): ExecutorRow[] {
  const live = store.listExecutors();
  const made: ExecutorRow[] = [];
  for (const t of usable) {
    if (live.some((e) => e.type === t.type)) continue;
    let name = t.label;
    // names are unique, and a setup someone added may already carry this one
    for (let n = 2; store.executorNameTaken(name); n++) name = `${t.label} ${n}`;
    made.push(store.createExecutor({ name, type: t.type, settings: {} }));
  }
  return made;
}

/** What the settings page shows of a type: its shape, never its code. */
export function typeView(t: HarnessType) {
  const caps: Partial<Record<SourceKind, ReturnType<HarnessType["capabilities"]>>> = {};
  if (t.sources.own) caps.own = t.capabilities("own");
  if (t.sources.apis.length > 0) caps.endpoint = t.capabilities("endpoint");
  return { type: t.type, label: t.label, sources: t.sources, capabilities: caps, fields: t.fields };
}

/**
 * Executors and the endpoints bots call, as the settings page edits them.
 * Every change rebuilds the registry, so the next session started anywhere
 * runs on what was just saved.
 */
export class ExecutorSettings {
  #presets = new Map<string, { at: number; value: Promise<ProviderPreset[]> }>();
  #logins = new Map<string, { at: number; value: Promise<LoginState> }>();

  constructor(
    private store: Store,
    private secrets: Secrets,
    private types: () => readonly HarnessType[],
    private registry: () => Registry,
    private changed: () => void,
  ) {}

  presets(type: HarnessType): Promise<ProviderPreset[]> {
    const cached = this.#presets.get(type.type);
    if (cached && Date.now() - cached.at < PRESETS_REUSE_MS) return cached.value;
    const entry = { at: Date.now(), value: type.presets?.() ?? Promise.resolve([]) };
    this.#presets.set(type.type, entry);
    entry.value.catch(() => this.#presets.delete(type.type));
    return entry.value;
  }

  /** Every preset any type offers, for validating what a person picked. */
  async #allPresets(): Promise<ProviderPreset[]> {
    return (await Promise.all(this.types().map((t) => this.presets(t).catch(() => [])))).flat();
  }

  async view() {
    const types = this.types();
    const presets = Object.fromEntries(
      await Promise.all(types.map(async (t) => [t.type, await this.presets(t).catch(() => [])] as const)),
    );
    return {
      types: types.map(typeView),
      presets,
      executors: this.store.listExecutors().map((e) => ({
        ...e,
        // an executor whose extension is gone stays listed, so it can be seen and deleted
        known: types.some((t) => t.type === e.type),
      })),
      providers: this.store.listProviders().map((p) => this.#providerView(p)),
      vault: { encrypted: this.secrets.encrypted, keystore: this.secrets.keystore },
    };
  }

  // ---- executors ----

  async createExecutor(body: Body): Promise<ExecutorRow> {
    const row = this.store.createExecutor(await this.#executorInput(body));
    this.changed();
    return row;
  }

  async updateExecutor(id: string, body: Body): Promise<ExecutorRow> {
    const current = this.#liveExecutor(id);
    const { name, settings } = await this.#executorInput(body, current);
    const row = this.store.updateExecutor(id, { name, settings });
    this.#logins.delete(id);
    this.changed();
    return row;
  }

  deleteExecutor(id: string): void {
    const current = this.#liveExecutor(id);
    const bots = this.store.liveBotsOn(id);
    if (bots.length > 0) {
      throw new Rejection(`还有 bot 在用「${current.name}」：${bots.map((b) => b.name).join("、")}。先给它们换一个 agent`, 409);
    }
    this.store.archiveExecutor(id);
    this.#logins.delete(id);
    this.changed();
  }

  /** Whether the agent's own sign-in is there. Spawns the agent, so the answer is reused for a while. */
  login(id: string, fresh = false): Promise<LoginState> {
    this.#liveExecutor(id);
    const executor = this.registry().get(id);
    if (!executor) return Promise.resolve({ state: "unknown", detail: "这个版本不认识它的类型", methods: [] });
    if (!executor.sources.own) return Promise.resolve({ state: "none", detail: "这个 agent 没有自带登录", methods: [] });
    const cached = this.#logins.get(id);
    if (!fresh && cached && Date.now() - cached.at < LOGIN_REUSE_MS) return cached.value;
    const value = (executor.login?.() ?? Promise.resolve<LoginState>({ state: "unknown", methods: [] })).catch(
      (err: unknown): LoginState => ({ state: "unknown", detail: err instanceof Error ? err.message : String(err), methods: [] }),
    );
    this.#logins.set(id, { at: Date.now(), value });
    return value;
  }

  async authenticate(id: string, methodId: string): Promise<LoginState> {
    this.#liveExecutor(id);
    const executor = this.registry().get(id);
    if (!executor?.authenticate) throw new Rejection("这个 agent 不能由 Roster 代为登录");
    await executor.authenticate(methodId);
    return this.login(id, true);
  }

  /** The agent's own sign-in, and whether the program starts at all. Endpoints are checked on their own page. */
  async check(id: string): Promise<{ ok: boolean; items: CheckItem[] }> {
    const row = this.#liveExecutor(id);
    const executor = this.registry().get(id);
    if (!executor) return { ok: false, items: [{ label: row.name, ok: false, detail: "这个版本不认识它的类型：装上对应的扩展" }] };
    const items: CheckItem[] = [];
    if (executor.sources.own) {
      const login = await this.login(id, true);
      items.push({
        label: "自带登录",
        ok: login.state === "ok",
        detail:
          login.state === "ok"
            ? `已登录${login.account ? `（${login.account}）` : ""}`
            : login.state === "none"
              ? "没有登录"
              : (login.detail ?? "没问到登录状态"),
      });
    }
    const source: ModelSource = { kind: "own" };
    if (executor.check && (executor.sources.own || executor.sources.apis.length === 0)) {
      const r = await executor.check(source).catch((err: unknown) => ({
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
      }));
      items.push({ label: row.name, ok: r.ok, detail: r.detail ?? "" });
    }
    if (items.length === 0) items.push({ label: row.name, ok: true, detail: "它只接模型 API；到模型 API 页面测试密钥" });
    return { ok: items.every((i) => i.ok), items };
  }

  // ---- providers ----

  async createProvider(body: Body) {
    const { key, ...input } = await this.#providerInput(body);
    const row = this.store.createProvider({ ...input, secret_ref: key ? this.secrets.put(key) : null });
    this.changed();
    return this.#providerView(row);
  }

  async updateProvider(id: string, body: Body) {
    const current = this.#liveProvider(id);
    const { key, ...input } = await this.#providerInput(body, current);
    let secretRef = current.secret_ref;
    // an environment variable takes over from a kept key, and a cleared field means no key at all
    if (input.key_env || key === "") {
      if (secretRef) this.secrets.delete(secretRef);
      secretRef = null;
    } else if (key) {
      secretRef = this.secrets.put(key, secretRef ?? undefined);
    }
    const row = this.store.updateProvider(id, { ...input, secret_ref: secretRef });
    this.changed();
    return this.#providerView(row);
  }

  deleteProvider(id: string): void {
    const current = this.#liveProvider(id);
    const users = this.store.botsUsingSource(id);
    if (users.length > 0) {
      throw new Rejection(`还有 bot 在用「${current.name}」：${users.map((b) => b.name).join("、")}。先给它们换个模型来源`, 409);
    }
    this.store.archiveProvider(id);
    if (current.secret_ref) this.secrets.delete(current.secret_ref);
    this.changed();
  }

  async checkProvider(id: string): Promise<CheckItem & { models?: string[] }> {
    const p = this.#liveProvider(id);
    return { label: p.name, ...(await this.#endpoint(p, await this.#allPresets())) };
  }

  /** What each agent that can drive this endpoint offers from it: the lists a bot's model is picked from. */
  async providerModels(id: string): Promise<{ groups: CatalogGroup[] }> {
    const row = this.#liveProvider(id);
    return { groups: await this.#catalogs(row, providerConfigOf(row, this.secrets)) };
  }

  /** The same for a preset nobody has added yet, so its models can be seen before there is a key. */
  async presetModels(presetId: string): Promise<{ groups: CatalogGroup[] }> {
    const preset = (await this.#allPresets()).find((p) => p.id === presetId);
    if (!preset) throw new Rejection(`没有「${presetId}」这个预设`, 404);
    const endpoint: ProviderConfig = { id: `preset:${presetId}`, name: preset.label, preset: presetId };
    return { groups: await this.#catalogs({ preset: presetId, api: null }, endpoint) };
  }

  async #catalogs(row: Pick<ProviderRow, "preset" | "api">, endpoint: ProviderConfig): Promise<CatalogGroup[]> {
    const groups: CatalogGroup[] = [];
    for (const type of this.types()) {
      if (type.sources.apis.length === 0 || !fits(type, row, await this.presets(type).catch(() => []))) continue;
      const catalog = (await type.catalog?.(endpoint).catch(() => undefined)) ?? [];
      // without a catalog, a custom endpoint's own list is all there is
      const models = catalog.length > 0 ? catalog : (endpoint.models ?? []).map((m) => ({ id: m, available: Boolean(endpoint.apiKey) }));
      if (models.length > 0) groups.push({ type: type.type, label: type.label, models });
    }
    return groups;
  }

  /**
   * Pulls the model list for a custom endpoint straight from the form: no save
   * needed first. Editing an existing provider without retyping its key falls
   * back to the one already stored, same as saving does.
   */
  async probeModels(body: Body): Promise<{ ok: boolean; models?: string[]; detail: string }> {
    const api = text(body["api"], 60);
    const baseUrl = text(body["base_url"], 500);
    if (!api || !baseUrl) return { ok: false, detail: "先填地址和协议" };
    const providerId = text(body["provider_id"], 80);
    const headers: Record<string, string> = {};
    let apiKey = text(body["key"], 1000) ?? undefined;
    if (!apiKey && providerId) {
      const current = this.store.getProvider(providerId);
      if (current) {
        apiKey = current.key_env ? envVar(current.key_env) : current.secret_ref ? this.secrets.get(current.secret_ref) : undefined;
        Object.assign(headers, current.headers);
      }
    }
    if (!apiKey) return { ok: false, detail: "先填密钥" };
    return fetchModels({ id: providerId ?? "probe", name: "", preset: CUSTOM_PRESET, api, baseUrl, apiKey, headers });
  }

  // ---- helpers ----

  #endpoint(p: ProviderRow, presets: readonly ProviderPreset[]) {
    if (p.key_env && !envVar(p.key_env)) {
      return Promise.resolve({ ok: false, detail: `环境变量 ${p.key_env} 没有设置（登录 shell 里也没有）` });
    }
    if (p.secret_ref && this.secrets.get(p.secret_ref) === undefined) {
      return Promise.resolve({ ok: false, detail: "保存的密钥解不开了（换过机器或钥匙串），重新填一次" });
    }
    return checkEndpoint(providerConfigOf(p, this.secrets), presets.find((x) => x.id === p.preset));
  }

  #liveExecutor(id: string): ExecutorRow {
    const row = this.store.getExecutor(id);
    if (!row || row.archived_at) throw new Rejection("没有这个 agent 配置", 404);
    return row;
  }

  #liveProvider(id: string): ProviderRow {
    const row = this.store.getProvider(id);
    if (!row || row.archived_at) throw new Rejection("没有这个模型 API", 404);
    return row;
  }

  async #executorInput(body: Body, current?: ExecutorRow): Promise<ExecutorInput> {
    const type = this.types().find((t) => t.type === (current?.type ?? String(body["type"] ?? "")));
    if (!type) throw new Rejection(current ? "它的适配器没有装，先装上再改" : "没有这种 agent");
    const name = text(body["name"] ?? current?.name, 40);
    if (!name) throw new Rejection("配置要有个名字");
    if (this.store.executorNameTaken(name, current?.id)) throw new Rejection(`「${name}」这个名字已经用过了`);

    const raw = (body["settings"] ?? current?.settings ?? {}) as Body;
    const settings: Record<string, string> = {};
    // only what the type declares is kept, so a stale field from another type cannot ride along
    for (const f of type.fields) {
      const value = text(raw[f.key], 2000);
      if (!value) {
        if (f.required) throw new Rejection(`「${f.label}」要填`);
        continue;
      }
      if (f.kind === "select" && !f.options?.some((o) => o.id === value)) throw new Rejection(`「${f.label}」只能从选项里选`);
      settings[f.key] = value;
    }
    return { name, type: type.type, settings };
  }

  async #providerInput(body: Body, current?: ProviderRow): Promise<ProviderInput & { key: string | undefined }> {
    const name = text(body["name"] ?? current?.name, 40);
    if (!name) throw new Rejection("模型 API 要有个名字");
    if (this.store.providerNameTaken(name, current?.id)) throw new Rejection(`已经有叫「${name}」的模型 API 了`);

    const preset = text(body["preset"] ?? current?.preset, 80);
    if (!preset) throw new Rejection("选一个预设，或者选自定义");
    const custom = preset === CUSTOM_PRESET;
    if (!custom && !(await this.#allPresets()).some((p) => p.id === preset)) {
      throw new Rejection(`没有「${preset}」这个预设`);
    }

    const pick = (key: string) => (key in body ? body[key] : current?.[key as keyof ProviderRow]);
    let api: string | null = null;
    let base_url: string | null = null;
    let models: string[] = [];
    if (custom) {
      api = text(pick("api"), 60);
      const apis = new Set(this.types().flatMap((t) => t.sources.apis));
      if (!api || !apis.has(api)) throw new Rejection("自定义 API 要选一种协议");
      base_url = text(pick("base_url"), 500);
      if (!base_url || !/^https?:\/\/[^\s]+$/.test(base_url)) throw new Rejection("地址要以 http:// 或 https:// 开头");
      const rawModels = pick("models");
      models = (Array.isArray(rawModels) ? rawModels : String(rawModels ?? "").split(/[\n,]/))
        .map((m) => String(m).trim())
        .filter(Boolean)
        .slice(0, 100);
      if (models.length === 0) throw new Rejection("自定义 API 至少要写一个模型 id");
      if (models.some((m) => m.length > 200)) throw new Rejection("模型 id 太长了");
    }

    const rawHeaders = (pick("headers") ?? {}) as Body;
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(rawHeaders).slice(0, 20)) {
      const value = text(v, 2000);
      if (!value) continue;
      if (!HEADER_NAME.test(k)) throw new Rejection(`请求头名字不合法：${k}`);
      headers[k] = value;
    }

    const key_env = text(pick("key_env"), 120);
    if (key_env && !ENV_NAME.test(key_env)) throw new Rejection("环境变量名只能是字母、数字和下划线");
    const key = "key" in body ? String(body["key"] ?? "").trim().slice(0, 1000) : undefined;

    return { name, preset, api, base_url, models, headers, key_env, key };
  }

  /** Everything about a provider except the key, which shows only as whether it is there and how it ends. */
  #providerView(row: ProviderRow) {
    const { secret_ref, ...rest } = row;
    const stored = secret_ref ? this.secrets.hint(secret_ref) : undefined;
    return {
      ...rest,
      key: row.key_env
        ? { source: "env" as const, set: Boolean(envVar(row.key_env)), hint: null }
        : { source: "stored" as const, set: stored !== undefined, hint: stored ?? null },
    };
  }
}
