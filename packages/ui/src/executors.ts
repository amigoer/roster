import { createContext, useContext } from "react";
import type { Bot, Capabilities, CapabilitySet, Executor, SourceRef } from "./api";

/** The executors core knows, as /api/state ships them. */
export const Executors = createContext<readonly Executor[]>([]);

/** Every endpoint by name, so a bot's source can be labelled anywhere without its key. */
export const SourceRefs = createContext<readonly SourceRef[]>([]);

/** Looks an executor up by id; an id no longer configured still reads as itself rather than as nothing. */
export function useExecutor(): (id: string) => Executor {
  const list = useContext(Executors);
  return (id) => list.find((e) => e.id === id) ?? { id, type: "", label: id, sources: { own: true, apis: [] } };
}

/** Executor ids in the order they came, except that an agent's extra setups sit right under its own. */
export function byAgent(ids: readonly string[], typeOf: (id: string) => string): string[] {
  const first = new Map<string, number>();
  ids.forEach((id, i) => {
    const type = typeOf(id);
    if (!first.has(type)) first.set(type, i);
  });
  return ids
    .map((id, i) => ({ id, i, at: first.get(typeOf(id)) ?? i }))
    .sort((a, b) => a.at - b.at || a.i - b.i)
    .map((x) => x.id);
}

export const OWN_SOURCE_LABEL = "自带登录";

/** What a bot's model source is called: the endpoint's name, or the agent's own sign-in. */
export function useSourceLabel(): (bot: Pick<Bot, "model_source">) => string {
  const refs = useContext(SourceRefs);
  return (bot) => (bot.model_source ? (refs.find((r) => r.id === bot.model_source)?.name ?? "已删除的模型 API") : OWN_SOURCE_LABEL);
}

/** The capabilities that apply to a bot: the channel its model source runs over. */
export function capsOf(caps: Record<string, CapabilitySet>, bot: Pick<Bot, "executor_id" | "model_source">): Capabilities | undefined {
  const set = caps[bot.executor_id];
  if (!set) return undefined;
  return bot.model_source ? set.endpoint : set.own;
}
