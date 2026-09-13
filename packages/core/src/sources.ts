import type {
  HarnessType,
  ModelOption,
  ModelSource,
  ProviderConfig,
  ProviderPreset,
  SourceKind,
} from "@roster/adapter-api";
import type { Registry } from "./registry.js";
import type { Secrets } from "./secrets.js";
import type { ProviderRow, Store } from "./store.js";

export const CUSTOM_PRESET = "custom";

/**
 * Variables read once from the login shell. An app opened from the dock never
 * sees what .zshrc exports, and that is where people keep their keys.
 */
let shellEnv: Readonly<Record<string, string>> = {};

export function setShellEnv(env: Readonly<Record<string, string>>): void {
  shellEnv = env;
}

/** The process's own value first; the login shell's only where the process has none. */
export function envVar(name: string): string | undefined {
  return process.env[name] ?? shellEnv[name];
}

/** A provider as an adapter takes it: the key resolved, and only in memory. */
export function providerConfigOf(row: ProviderRow, secrets: Secrets): ProviderConfig {
  const apiKey = row.key_env ? envVar(row.key_env) : row.secret_ref ? secrets.get(row.secret_ref) : undefined;
  return {
    id: row.id,
    name: row.name,
    preset: row.preset,
    ...(row.api ? { api: row.api } : {}),
    ...(row.base_url ? { baseUrl: row.base_url } : {}),
    ...(apiKey ? { apiKey } : {}),
    ...(row.models.length > 0 ? { models: row.models } : {}),
    ...(Object.keys(row.headers).length > 0 ? { headers: row.headers } : {}),
  };
}

/** The same rule the UI shows: a preset has to be one this type knows, a custom endpoint has to speak its protocol. */
export function fits(type: HarnessType, provider: Pick<ProviderRow, "preset" | "api">, presets: readonly ProviderPreset[]): boolean {
  if (provider.preset === CUSTOM_PRESET) return provider.api !== null && type.sources.apis.includes(provider.api);
  return presets.some((p) => p.id === provider.preset);
}

/** One place a bot's models can come from, and what it offers. */
export interface ModelGroup {
  /** an endpoint id, or null for the agent's own sign-in */
  source: string | null;
  label: string;
  models: ModelOption[];
}

export const kindOf = (sourceId: string | null | undefined): SourceKind => (sourceId ? "endpoint" : "own");

/**
 * Where a bot's models come from, resolved against what is configured right
 * now. An executor never holds an endpoint; the bot names one, and this turns
 * the name into what the adapter takes, key included.
 */
export class Sources {
  constructor(
    private store: Store,
    private secrets: Secrets,
    private registry: () => Registry,
    private presetsOf: (type: HarnessType) => Promise<ProviderPreset[]>,
  ) {}

  /** Throws when the source is gone or the executor cannot use it. */
  resolve(executorId: string, sourceId: string | null): ModelSource {
    const entry = this.registry().entry(executorId);
    if (!entry) throw new Error(`unknown executor ${executorId}`);
    if (!sourceId) {
      if (!entry.factory.sources.own) {
        throw new Error(`「${entry.factory.label}」没有自带的登录，给这个 bot 选一个模型 API`);
      }
      return { kind: "own" };
    }
    const row = this.store.getProvider(sourceId);
    if (!row || row.archived_at) throw new Error("这个 bot 用的模型 API 已经删除了");
    return { kind: "endpoint", endpoint: providerConfigOf(row, this.secrets) };
  }

  /** Whether a bot on this executor may name this source at all. */
  async usable(executorId: string, sourceId: string | null): Promise<{ ok: true } | { ok: false; reason: string }> {
    const entry = this.registry().entry(executorId);
    if (!entry) return { ok: false, reason: "没有这个执行器" };
    if (!sourceId) {
      return entry.factory.sources.own
        ? { ok: true }
        : { ok: false, reason: `「${entry.factory.label}」没有自带的登录，要选一个模型 API` };
    }
    const row = this.store.getProvider(sourceId);
    if (!row || row.archived_at) return { ok: false, reason: "要用的模型 API 不存在" };
    const presets = await this.presetsOf(entry.type).catch(() => []);
    return fits(entry.type, row, presets)
      ? { ok: true }
      : { ok: false, reason: `「${row.name}」接不到「${entry.factory.label}」上：协议对不上` };
  }

  /** Every model a bot on this executor could pick, grouped by where it comes from. */
  async groups(executorId: string): Promise<ModelGroup[]> {
    const entry = this.registry().entry(executorId);
    if (!entry) return [];
    const { factory, type } = entry;
    const groups: ModelGroup[] = [];
    if (factory.sources.own) {
      const models = (await factory.models?.().catch(() => [])) ?? [];
      groups.push({ source: null, label: "自带登录", models });
    }
    if (type.sources.apis.length === 0) return groups;
    const presets = await this.presetsOf(type).catch(() => []);
    for (const row of this.store.listProviders()) {
      if (!fits(type, row, presets)) continue;
      const endpoint = providerConfigOf(row, this.secrets);
      const listed = row.models.map((id) => ({ id, available: Boolean(endpoint.apiKey), provider: row.name }));
      const models = (await type.catalog?.(endpoint).catch(() => undefined)) ?? listed;
      groups.push({ source: row.id, label: row.name, models: models.length > 0 ? models : listed });
    }
    return groups;
  }
}
