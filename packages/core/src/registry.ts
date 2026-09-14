import type { BotRuntimeFactory, HarnessType, InstanceConfig } from "@roster/adapter-api";
import type { ExecutorRow } from "./store.js";

export interface RegistryEntry {
  factory: BotRuntimeFactory;
  /** the type the factory was made from, which is what knows presets */
  type: HarnessType;
}

/** A factory handed in on its own stands for its own type: enough for tests and scripted runs. */
function typeOf(factory: BotRuntimeFactory): HarnessType {
  return {
    type: factory.type,
    label: factory.label,
    sources: { own: true, apis: [] },
    capabilities: () => factory.capabilities,
    create: () => factory,
  };
}

/** Executors by id. Every lookup goes through here, so the set can change while the app runs. */
export class Registry {
  #entries: Map<string, RegistryEntry>;
  #problems: Map<string, string>;

  constructor(
    entries: Readonly<Record<string, BotRuntimeFactory | RegistryEntry>>,
    problems: Readonly<Record<string, string>> = {},
  ) {
    this.#entries = new Map(
      Object.entries(entries).map(([id, e]) => [id, "factory" in e ? e : { factory: e, type: typeOf(e) }]),
    );
    this.#problems = new Map(Object.entries(problems));
  }

  /**
   * An executor that cannot be built is left out, with the reason kept: its
   * type is not loaded, its model API is gone, or its type refuses the source.
   * Bots on it fail to start with that reason.
   */
  static from(
    types: readonly HarnessType[],
    executors: readonly ExecutorRow[],
    instanceOf: (row: ExecutorRow, type: HarnessType) => InstanceConfig,
  ): Registry {
    const built: Record<string, RegistryEntry> = {};
    const problems: Record<string, string> = {};
    for (const row of executors) {
      const type = types.find((t) => t.type === row.type);
      if (!type) {
        problems[row.id] = `这个版本不认识「${row.type}」，装上对应的适配器才能用`;
        continue;
      }
      try {
        built[row.id] = { type, factory: type.create(instanceOf(row, type)) };
      } catch (err) {
        problems[row.id] = err instanceof Error ? err.message : String(err);
      }
    }
    return new Registry(built, problems);
  }

  get(id: string): BotRuntimeFactory | undefined {
    return this.#entries.get(id)?.factory;
  }

  entry(id: string): RegistryEntry | undefined {
    return this.#entries.get(id);
  }

  /** Why an executor could not be built, when it could not. */
  problem(id: string): string | undefined {
    return this.#problems.get(id);
  }

  ids(): string[] {
    return [...this.#entries.keys()];
  }

  entries(): Array<[id: string, executor: BotRuntimeFactory]> {
    return [...this.#entries.entries()].map(([id, e]) => [id, e.factory]);
  }
}
