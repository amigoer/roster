import type { BotRuntimeFactory, HarnessType } from "@roster/adapter-api";
import type { ExecutorRow } from "./store.js";

export interface RegistryEntry {
  factory: BotRuntimeFactory;
  /** the type the factory was made from, which is what knows presets and endpoint catalogs */
  type: HarnessType;
}

/** A factory handed in on its own stands for its own type: enough for tests and scripted runs. */
function typeOf(factory: BotRuntimeFactory): HarnessType {
  return {
    type: factory.type,
    label: factory.label,
    sources: factory.sources,
    capabilities: (kind) => factory.capabilities(kind),
    fields: [],
    create: () => factory,
  };
}

/** Executors by id. Every lookup goes through here, so the set can change while the app runs. */
export class Registry {
  #entries: Map<string, RegistryEntry>;

  constructor(entries: Readonly<Record<string, BotRuntimeFactory | RegistryEntry>>) {
    this.#entries = new Map(
      Object.entries(entries).map(([id, e]) => [id, "factory" in e ? e : { factory: e, type: typeOf(e) }]),
    );
  }

  /**
   * An executor whose type this build does not know is left out; bots on it
   * fail to start with "unknown executor". Defaults are what the host found
   * for a type -- the agent program on this machine -- and fill in only what
   * the executor's own settings leave empty.
   */
  static from(
    types: readonly HarnessType[],
    executors: readonly ExecutorRow[],
    defaults: (type: HarnessType) => Readonly<Record<string, string>> = () => ({}),
  ): Registry {
    const built: Record<string, RegistryEntry> = {};
    for (const row of executors) {
      const type = types.find((t) => t.type === row.type);
      if (!type) continue;
      const settings = { ...row.settings };
      for (const [k, v] of Object.entries(defaults(type))) if (!settings[k]?.trim()) settings[k] = v;
      built[row.id] = { type, factory: type.create({ id: row.id, label: row.name, settings }) };
    }
    return new Registry(built);
  }

  get(id: string): BotRuntimeFactory | undefined {
    return this.#entries.get(id)?.factory;
  }

  entry(id: string): RegistryEntry | undefined {
    return this.#entries.get(id);
  }

  ids(): string[] {
    return [...this.#entries.keys()];
  }

  entries(): Array<[id: string, executor: BotRuntimeFactory]> {
    return [...this.#entries.entries()].map(([id, e]) => [id, e.factory]);
  }
}
