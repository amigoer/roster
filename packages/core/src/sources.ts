import type { HarnessType, ModelOption, ModelSource, ProviderConfig, ProviderPreset, SourceKind } from "@roster/adapter-api";
import type { Registry } from "./registry.js";
import type { Secrets } from "./secrets.js";
import type { ExecutorRow, ProviderRow, Store } from "./store.js";

export const CUSTOM_PRESET = "custom";

/** What a person calls the agent's own sign-in as a model source. */
export const OWN_SOURCE_LABEL = "订阅";

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

/** The source an executor names, key resolved. Throws when its model API is gone. */
export function sourceOf(row: Pick<ExecutorRow, "source_kind" | "provider_id">, store: Store, secrets: Secrets): ModelSource {
  if (row.source_kind === "own") return { kind: "own" };
  const provider = row.provider_id ? store.getProvider(row.provider_id) : undefined;
  if (!provider || provider.archived_at) throw new Error("它接的模型 API 已经删除了，换一个模型 API");
  return { kind: "endpoint", endpoint: providerConfigOf(provider, secrets) };
}

/**
 * Where executors' models come from, checked and listed against what is
 * configured right now. An executor names its source; bots only name the executor.
 */
export class Sources {
  constructor(
    private store: Store,
    private secrets: Secrets,
    private registry: () => Registry,
    private presetsOf: (type: HarnessType) => Promise<ProviderPreset[]>,
  ) {}

  /** Whether a type can run on this source: its own sign-in when it has one, or a model API that speaks its protocol. */
  async usable(type: HarnessType, kind: SourceKind, providerId: string | null): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (kind === "own") {
      return type.sources.own ? { ok: true } : { ok: false, reason: `「${type.label}」没有自带登录，要接一个模型 API` };
    }
    const row = providerId ? this.store.getProvider(providerId) : undefined;
    if (!row || row.archived_at) return { ok: false, reason: "要接的模型 API 不存在" };
    const presets = await this.presetsOf(type).catch(() => []);
    return fits(type, row, presets) ? { ok: true } : { ok: false, reason: `「${row.name}」接不到「${type.label}」上：协议对不上` };
  }

  /** The models a model API serves, whichever type drives it: the ids it listed, and nothing a harness knows about them. */
  endpointModels(provider: ProviderRow): ModelOption[] {
    const available = Boolean(providerConfigOf(provider, this.secrets).apiKey);
    return provider.models.map((id) => ({ id, available }));
  }

  /** Every model a bot on this executor could pick. */
  async models(executorId: string): Promise<ModelOption[]> {
    const entry = this.registry().entry(executorId);
    const row = this.store.getExecutor(executorId);
    if (!entry || !row) return [];
    if (row.source_kind === "own") return (await entry.factory.models?.().catch(() => [])) ?? [];
    const provider = row.provider_id ? this.store.getProvider(row.provider_id) : undefined;
    return provider ? this.endpointModels(provider) : [];
  }
}
