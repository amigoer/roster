import type { HarnessType, LoginState, ModelOption, ProviderConfig, ProviderPreset, SourceKind } from "@roster/adapter-api";
import { Rejection } from "./errors.js";
import { everyLocale, list, locale, t } from "./i18n/index.js";
import type { Registry } from "./registry.js";
import type { Secrets } from "./secrets.js";
import { CUSTOM_PRESET, envVar, fits, providerConfigOf, Sources } from "./sources.js";
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

/** Where an endpoint's model list lives, and how to prove a key to it — one per wire protocol. */
function endpointRequest(p: ProviderConfig, preset?: ProviderPreset): { url: string; headers: Record<string, string> } | null {
  const baseUrl = (p.baseUrl ?? preset?.baseUrl)?.replace(/\/+$/, "");
  const api = p.api ?? preset?.api;
  if (!baseUrl || !p.apiKey) return null;
  // the list is what pickers offer, so it is asked for in one page rather than the first 20 or 50
  if (api === "anthropic-messages") {
    return {
      url: `${baseUrl}/v1/models?limit=1000`,
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
    return { url: `${baseUrl}/models?pageSize=1000&key=${encodeURIComponent(p.apiKey)}`, headers: {} };
  }
  return null;
}

/** OpenAI-shaped `{ data: [{ id }] }` or Gemini-shaped `{ models: [{ name: "models/x" }] }`, each id once and sorted. */
function parseModelIds(body: unknown): string[] | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  let ids: string[];
  if (Array.isArray(b["data"])) {
    ids = b["data"].map((m) => (m && typeof m === "object" ? String((m as Record<string, unknown>)["id"] ?? "") : ""));
  } else if (Array.isArray(b["models"])) {
    ids = b["models"].map((m) => {
      if (!m || typeof m !== "object") return "";
      const r = m as Record<string, unknown>;
      return String(r["name"] ?? r["id"] ?? "").replace(/^models\//, "");
    });
  } else {
    return null;
  }
  // sorted, so a list that comes back in another order is not a change
  return [...new Set(ids.filter(Boolean))].sort();
}

/**
 * Asks an endpoint for its model list: it is authenticated, so a bad key shows,
 * and it is free, so testing a setup never spends anything.
 */
export async function checkEndpoint(p: ProviderConfig, preset?: ProviderPreset): Promise<EndpointCheck> {
  if (!p.apiKey) return { ok: false, detail: t("check.endpoint.noKey") };
  const req = endpointRequest(p, preset);
  if (!req) {
    return (p.baseUrl ?? preset?.baseUrl)
      ? { ok: true, detail: t("check.endpoint.unverifiable") }
      : { ok: true, detail: t("check.endpoint.noAddress") };
  }
  try {
    const res = await fetch(req.url, { headers: { ...p.headers, ...req.headers }, signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) });
    if (res.status === 401 || res.status === 403) return { ok: false, detail: t("check.endpoint.rejected", { status: res.status }) };
    if (res.status === 404) return { ok: true, detail: t("check.endpoint.noList") };
    if (!res.ok) return { ok: false, detail: t("check.endpoint.status", { status: res.status }) };
    const models = parseModelIds(await res.json().catch(() => null));
    return models
      ? { ok: true, detail: t("check.endpoint.listed", { count: models.length }), models }
      : { ok: true, detail: t("check.endpoint.connected") };
  } catch (err) {
    return { ok: false, detail: t("check.endpoint.unreachable", { message: err instanceof Error ? err.message : String(err) }) };
  }
}

/** Same probe as checkEndpoint, but for actually populating the model list rather than just counting it. */
export async function fetchModels(p: ProviderConfig, preset?: ProviderPreset): Promise<{ ok: boolean; models?: string[]; detail: string }> {
  if (!p.apiKey) return { ok: false, detail: t("check.endpoint.noKey") };
  const req = endpointRequest(p, preset);
  if (!req) return { ok: false, detail: t("probe.noList") };
  try {
    const res = await fetch(req.url, { headers: { ...p.headers, ...req.headers }, signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) });
    if (res.status === 401 || res.status === 403) return { ok: false, detail: t("check.endpoint.rejected", { status: res.status }) };
    if (!res.ok) return { ok: false, detail: t("check.endpoint.status", { status: res.status }) };
    const models = parseModelIds(await res.json().catch(() => null));
    if (!models || models.length === 0) return { ok: false, detail: t("probe.empty") };
    return { ok: true, models, detail: t("probe.fetched", { count: models.length }) };
  } catch (err) {
    return { ok: false, detail: t("check.endpoint.unreachable", { message: err instanceof Error ? err.message : String(err) }) };
  }
}

/** What the settings page shows of a type: its shape, never its code. */
export function typeView(t: HarnessType) {
  const caps: Partial<Record<SourceKind, ReturnType<HarnessType["capabilities"]>>> = {};
  if (t.sources.own) caps.own = t.capabilities("own");
  if (t.sources.apis.length > 0) caps.endpoint = t.capabilities("endpoint");
  return { type: t.type, label: t.label, sources: t.sources, capabilities: caps };
}

/** A pairing of type and source nobody has made an executor of yet, offered where an executor is picked. */
export interface Candidate {
  type: string;
  source_kind: SourceKind;
  provider_id: string | null;
  /** the name it would get */
  name: string;
}

/**
 * Executors, the endpoints they call and what each type needs on this machine,
 * as the settings page edits them. Every change rebuilds the registry, so the
 * next session started anywhere runs on what was just saved.
 */
export class ExecutorSettings {
  #presets = new Map<string, { at: number; value: Promise<ProviderPreset[]> }>();
  /** by harness type: the sign-in belongs to the program on this machine; the answer's wording to the language it was asked in */
  #logins = new Map<string, { at: number; locale: string; value: Promise<LoginState> }>();
  #sources: Sources;

  constructor(
    private store: Store,
    private secrets: Secrets,
    private types: () => readonly HarnessType[],
    private registry: () => Registry,
    private changed: () => void,
    /** the program a type runs: the person's pick, else what the machine has */
    private programOf: (type: string) => string | undefined = () => undefined,
    /** whether a type has what it needs to run on this machine: its program, when it has one */
    private ready: (type: string) => boolean = () => true,
  ) {
    this.#sources = new Sources(store, secrets, registry, (t) => this.presets(t));
  }

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
    const registry = this.registry();
    return {
      types: types.map(typeView),
      presets,
      executors: this.store.listExecutors().map((e) => ({
        ...e,
        // one that cannot run stays listed with the reason, so it can be seen, fixed or deleted
        problem: registry.entry(e.id) ? null : (registry.problem(e.id) ?? t("error.agent.unbuildable")),
      })),
      providers: this.store.listProviders().map((p) => this.#providerView(p)),
      /** program paths a person picked, by type */
      programs: this.store.harnessPrograms(),
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
    const { name, source_kind, provider_id, model, long_cache } = await this.#executorInput(body, current);
    const row = this.store.updateExecutor(id, { name, source_kind, provider_id, model, long_cache });
    this.changed();
    return row;
  }

  /** Blocked while a bot names it or a member of an open conversation still runs on it. */
  deleteExecutor(id: string): void {
    const current = this.#liveExecutor(id);
    const bots = this.store.liveBotsOn(id);
    if (bots.length > 0) {
      throw new Rejection(t("error.executor.inUseByBots", { name: current.name, bots: list(bots.map((b) => b.name)) }), 409);
    }
    const members = this.store.membersOn(id);
    if (members.length > 0) {
      const count = new Set(members.map((m) => m.conversation_id)).size;
      throw new Rejection(t("error.executor.inUseByMembers", { count, name: current.name }), 409);
    }
    this.store.archiveExecutor(id);
    this.changed();
  }

  /**
   * An agent on a sign-in its harness does not have comes only from data older
   * than the rule, and can never start. When the harness has exactly one agent
   * on a model API that runs, everything on the stray one moves there;
   * otherwise it stays, saying why, for a person to fix. How many moved is the
   * answer.
   */
  mergeStrayOwn(): number {
    let merged = 0;
    for (const stray of this.store.listExecutors()) {
      const type = this.types().find((t) => t.type === stray.type);
      if (stray.source_kind !== "own" || !type || type.sources.own) continue;
      const into = this.store
        .listExecutors()
        .filter((e) => e.type === stray.type && e.source_kind === "endpoint" && this.registry().entry(e.id));
      if (into.length !== 1) continue;
      this.store.mergeExecutor(stray.id, into[0]!.id);
      merged++;
    }
    if (merged > 0) this.changed();
    return merged;
  }

  /** Whether this executor reaches its models: the sign-in or the model API behind it, then the program itself. */
  async check(id: string): Promise<{ ok: boolean; items: CheckItem[] }> {
    const row = this.#liveExecutor(id);
    const entry = this.registry().entry(id);
    if (!entry) {
      return { ok: false, items: [{ label: row.name, ok: false, detail: this.registry().problem(id) ?? t("error.agent.unbuildable") }] };
    }
    const items: CheckItem[] = [];
    if (row.source_kind === "own") {
      const login = await this.login(row.type, true);
      items.push({
        label: t("source.own"),
        ok: login.state === "ok",
        detail:
          login.state === "ok"
            ? login.account
              ? t("check.login.okAs", { account: login.account })
              : t("check.login.ok")
            : login.state === "none"
              ? t("check.login.none")
              : (login.detail ?? t("check.login.unknown")),
      });
    } else {
      const provider = row.provider_id ? this.store.getProvider(row.provider_id) : undefined;
      if (provider) items.push({ label: provider.name, ...(await this.#endpoint(provider, await this.#allPresets())) });
    }
    if (entry.factory.check) {
      const r = await entry.factory.check().catch((err: unknown) => ({
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
      }));
      items.push({ label: entry.type.label, ok: r.ok, detail: r.detail ?? "" });
    }
    return { ok: items.every((i) => i.ok), items };
  }

  /** Pairings of type and source that would run but have no executor yet, so one can be made where it is needed. */
  async candidates(): Promise<Candidate[]> {
    const live = this.store.listExecutors();
    const providers = this.store.listProviders();
    const out: Candidate[] = [];
    for (const type of this.types()) {
      // a harness whose program is nowhere would only offer an agent that cannot start
      if (!this.ready(type.type)) continue;
      if (type.sources.own && !live.some((e) => e.type === type.type && e.source_kind === "own")) {
        out.push({ type: type.type, source_kind: "own", provider_id: null, name: this.#nameFor(type, t("source.own")) });
      }
      if (type.sources.apis.length === 0) continue;
      const presets = await this.presets(type).catch(() => []);
      for (const p of providers) {
        if (!fits(type, p, presets) || live.some((e) => e.type === type.type && e.provider_id === p.id)) continue;
        out.push({ type: type.type, source_kind: "endpoint", provider_id: p.id, name: this.#nameFor(type, p.name) });
      }
    }
    return out;
  }

  /** The models an executor of this type on this source would offer, before there is one. */
  async draftModels(typeId: string, providerId: string | null): Promise<ModelOption[]> {
    const type = this.#type(typeId);
    if (providerId) return this.#sources.endpointModels(this.#liveProvider(providerId));
    if (!type.sources.own) return [];
    // the own catalog only the agent itself can tell, so a throwaway executor asks it
    const factory = type.create({ id: "draft", label: type.label, source: { kind: "own" }, program: this.programOf(typeId) });
    return (await factory.models?.().catch(() => [])) ?? [];
  }

  // ---- harness types ----

  /** Whether the agent's own sign-in is there on this machine. Spawns the agent, so the answer is reused for a while. */
  login(typeId: string, fresh = false): Promise<LoginState> {
    const type = this.types().find((t) => t.type === typeId);
    if (!type) return Promise.resolve({ state: "unknown", detail: t("login.unknownType"), methods: [] });
    if (!type.sources.own || !type.login) return Promise.resolve({ state: "none", detail: t("login.noOwn"), methods: [] });
    const lang = locale();
    const cached = this.#logins.get(typeId);
    if (!fresh && cached && cached.locale === lang && Date.now() - cached.at < LOGIN_REUSE_MS) return cached.value;
    const value = type
      .login(this.programOf(typeId), lang)
      .catch((err: unknown): LoginState => ({ state: "unknown", detail: err instanceof Error ? err.message : String(err), methods: [] }));
    this.#logins.set(typeId, { at: Date.now(), locale: lang, value });
    return value;
  }

  async authenticate(typeId: string, methodId: string): Promise<LoginState> {
    const type = this.#type(typeId);
    if (!type.authenticate) throw new Rejection(t("error.authenticate.unsupported"));
    await type.authenticate(methodId, this.programOf(typeId));
    // executors on its sign-in probed while signed out; rebuilding drops what they cached
    this.changed();
    return this.login(typeId, true);
  }

  /** The program a type runs on this machine; empty goes back to the one found, then Roster's own install. */
  setProgram(typeId: string, body: Body): { program: string | null } {
    this.#type(typeId);
    const program = text(body["program"], 2000);
    this.store.setHarnessProgram(typeId, program);
    this.#logins.delete(typeId);
    this.changed();
    return { program };
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
    const users = this.store.executorsOnProvider(id);
    if (users.length > 0) {
      throw new Rejection(t("error.provider.inUse", { name: current.name, agents: list(users.map((e) => e.name)) }), 409);
    }
    this.store.archiveProvider(id);
    if (current.secret_ref) this.secrets.delete(current.secret_ref);
    this.changed();
  }

  /** Whether the key opens the endpoint. A preset's model list is refreshed from what its API answered; relisted says whether that changed it. */
  async checkProvider(id: string): Promise<{ check: CheckItem & { models?: string[] }; relisted: boolean }> {
    const p = this.#liveProvider(id);
    const check = await this.#endpoint(p, await this.#allPresets());
    const relisted = this.#relist(p, check.models);
    if (relisted) this.changed();
    return { check: { label: p.name, ...check }, relisted };
  }

  /** Every preset endpoint with a key is asked what it serves now. Whether any list changed is the answer. */
  async refreshModels(): Promise<boolean> {
    const presets = await this.#allPresets();
    const rows = this.store.listProviders().filter((p) => p.preset !== CUSTOM_PRESET);
    const changes = await Promise.all(rows.map(async (p) => this.#relist(p, (await this.#endpoint(p, presets)).models)));
    const relisted = changes.some(Boolean);
    if (relisted) this.changed();
    return relisted;
  }

  /**
   * Pulls the model list for a custom endpoint straight from the form: no save
   * needed first. Editing an existing provider without retyping its key falls
   * back to the one already stored, same as saving does.
   */
  async probeModels(body: Body): Promise<{ ok: boolean; models?: string[]; detail: string }> {
    const api = text(body["api"], 60);
    const baseUrl = text(body["base_url"], 500);
    if (!api || !baseUrl) return { ok: false, detail: t("probe.needAddress") };
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
    if (!apiKey) return { ok: false, detail: t("probe.needKey") };
    return fetchModels({ id: providerId ?? "probe", name: "", preset: CUSTOM_PRESET, api, baseUrl, apiKey, headers });
  }

  // ---- helpers ----

  /** A preset serves exactly what its API listed; a custom endpoint keeps the list a person gave it. */
  #relist(row: ProviderRow, listed: readonly string[] | undefined): boolean {
    if (row.preset === CUSTOM_PRESET || !listed || listed.join("\n") === row.models.join("\n")) return false;
    this.store.setListedModels(row.id, listed);
    return true;
  }

  #endpoint(p: ProviderRow, presets: readonly ProviderPreset[]): Promise<EndpointCheck> {
    if (p.key_env && !envVar(p.key_env)) {
      return Promise.resolve({ ok: false, detail: t("check.endpoint.envMissing", { name: p.key_env }) });
    }
    if (p.secret_ref && this.secrets.get(p.secret_ref) === undefined) {
      return Promise.resolve({ ok: false, detail: t("check.endpoint.sealed") });
    }
    return checkEndpoint(providerConfigOf(p, this.secrets), presets.find((x) => x.id === p.preset));
  }

  #liveExecutor(id: string): ExecutorRow {
    const row = this.store.getExecutor(id);
    if (!row || row.archived_at) throw new Rejection(t("error.executor.notFound"), 404);
    return row;
  }

  #type(typeId: string): HarnessType {
    const type = this.types().find((t) => t.type === typeId);
    if (!type) throw new Rejection(t("error.harness.notFound"), 404);
    return type;
  }

  /** "Claude Code · Subscription", numbered past any live executor that already has it. */
  #nameFor(type: HarnessType, sourceLabel: string, exceptId?: string): string {
    const wanted = `${type.label} · ${sourceLabel}`;
    let name = wanted;
    for (let n = 2; this.store.executorNameTaken(name, exceptId); n++) name = `${wanted} ${n}`;
    return name;
  }

  /** Whether a name is one #nameFor could have given this pairing, in whichever language it was given. */
  #isNameFor(name: string, type: HarnessType, sourceLabels: readonly string[]): boolean {
    return sourceLabels.some((label) => {
      const wanted = `${type.label} · ${label}`;
      return name === wanted || (name.startsWith(`${wanted} `) && /^\d+$/.test(name.slice(wanted.length + 1)));
    });
  }

  #liveProvider(id: string): ProviderRow {
    const row = this.store.getProvider(id);
    if (!row || row.archived_at) throw new Rejection(t("error.provider.notFound"), 404);
    return row;
  }

  /**
   * The type is fixed once made: another type is another executor. The source
   * has to be one the type runs on, and a type has at most one executor on its
   * own sign-in, since the sign-in is the program's and there is only one.
   */
  async #executorInput(body: Body, current?: ExecutorRow): Promise<ExecutorInput> {
    const type = this.types().find((t) => t.type === (current?.type ?? String(body["type"] ?? "")));
    if (!type) throw new Rejection(current ? t("error.executor.adapterMissing") : t("error.executor.noHarness"));

    const kind = body["source_kind"] ?? current?.source_kind;
    if (kind !== "own" && kind !== "endpoint") throw new Rejection(t("error.executor.sourceKind"));
    const provider_id = kind === "endpoint" ? text(body["provider_id"] ?? current?.provider_id, 80) : null;
    if (kind === "endpoint" && !provider_id) throw new Rejection(t("error.executor.pickProvider"));
    const usable = await this.#sources.usable(type, kind, provider_id);
    if (!usable.ok) throw new Rejection(usable.reason);
    if (kind === "own") {
      const other = this.store.listExecutors().find((e) => e.type === type.type && e.source_kind === "own" && e.id !== current?.id);
      if (other) throw new Rejection(t("error.executor.ownTaken", { label: type.label, name: other.name }));
    }

    const model = "model" in body ? text(body["model"], 120) : (current?.model ?? null);
    const providerName = (providerId: string | null) => (providerId ? this.store.getProvider(providerId)?.name : undefined);
    /** A model API goes by its own name; a source without one, by the word for it in any language. */
    const labelsOf = (k: SourceKind, providerId: string | null): string[] => {
      const named = k === "endpoint" ? providerName(providerId) : undefined;
      return named ? [named] : everyLocale(k === "own" ? "source.own" : "source.endpoint");
    };
    const given = text(body["name"] ?? current?.name, 40);
    // a name that only ever said the old pairing follows the new one
    const follows =
      current !== undefined &&
      given === current.name &&
      (kind !== current.source_kind || provider_id !== current.provider_id) &&
      this.#isNameFor(current.name, type, labelsOf(current.source_kind, current.provider_id));
    const label = kind === "own" ? t("source.own") : (providerName(provider_id) ?? t("source.endpoint"));
    const name = (follows ? null : given) ?? this.#nameFor(type, label, current?.id);
    if (this.store.executorNameTaken(name, current?.id)) throw new Rejection(t("error.executor.nameTaken", { name }));
    const long_cache = "long_cache" in body ? (body["long_cache"] === true ? 1 : 0) : (current?.long_cache ?? 0);
    return { name, type: type.type, source_kind: kind, provider_id, model, long_cache };
  }

  async #providerInput(body: Body, current?: ProviderRow): Promise<ProviderInput & { key: string | undefined }> {
    const name = text(body["name"] ?? current?.name, 40);
    if (!name) throw new Rejection(t("error.provider.nameRequired"));
    if (this.store.providerNameTaken(name, current?.id)) throw new Rejection(t("error.provider.nameTaken", { name }));

    const preset = text(body["preset"] ?? current?.preset, 80);
    if (!preset) throw new Rejection(t("error.provider.presetRequired"));
    const custom = preset === CUSTOM_PRESET;
    if (!custom && !(await this.#allPresets()).some((p) => p.id === preset)) {
      throw new Rejection(t("error.provider.unknownPreset", { preset }));
    }

    const pick = (key: string) => (key in body ? body[key] : current?.[key as keyof ProviderRow]);
    let api: string | null = null;
    let base_url: string | null = null;
    // a preset's list is only ever what its API answered, so a save leaves it as it was
    let models: string[] = !custom && current?.preset === preset ? current.models : [];
    if (custom) {
      api = text(pick("api"), 60);
      const apis = new Set(this.types().flatMap((t) => t.sources.apis));
      if (!api || !apis.has(api)) throw new Rejection(t("error.provider.protocolRequired"));
      base_url = text(pick("base_url"), 500);
      if (!base_url || !/^https?:\/\/[^\s]+$/.test(base_url)) throw new Rejection(t("error.provider.badUrl"));
      const rawModels = pick("models");
      models = (Array.isArray(rawModels) ? rawModels : String(rawModels ?? "").split(/[\n,]/))
        .map((m) => String(m).trim())
        .filter(Boolean)
        .slice(0, 100);
      if (models.length === 0) throw new Rejection(t("error.provider.modelsRequired"));
      if (models.some((m) => m.length > 200)) throw new Rejection(t("error.provider.modelTooLong"));
    }

    const rawHeaders = (pick("headers") ?? {}) as Body;
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(rawHeaders).slice(0, 20)) {
      const value = text(v, 2000);
      if (!value) continue;
      if (!HEADER_NAME.test(k)) throw new Rejection(t("error.provider.badHeader", { name: k }));
      headers[k] = value;
    }

    const key_env = text(pick("key_env"), 120);
    if (key_env && !ENV_NAME.test(key_env)) throw new Rejection(t("error.provider.badEnvName"));
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
