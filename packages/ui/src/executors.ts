import { createContext, useContext } from "react";
import type { Executor, SourceRef } from "./api";

/** The agents core knows, as /api/state ships them. */
export const Executors = createContext<readonly Executor[]>([]);

/** Every model API by name, so an agent's source can be labelled anywhere without its key. */
export const SourceRefs = createContext<readonly SourceRef[]>([]);

/** What each base is called, by type id; one not loaded goes by its id. */
export const BaseLabels = createContext<Readonly<Record<string, string>>>({});

/** Looks an agent up by id; one deleted since still reads as something rather than as nothing. */
export function useExecutor(): (id: string) => Executor {
  const list = useContext(Executors);
  return (id) =>
    list.find((e) => e.id === id) ?? {
      id,
      type: "",
      label: "已删除的 agent",
      source_kind: "own",
      provider_id: null,
      model: null,
      problem: "这个 agent 已经删除了",
    };
}

export const OWN_SOURCE_LABEL = "订阅";

/** What an agent's source is called: 订阅 for the base's own sign-in, the model API's name otherwise. */
export function useSourceLabel(): (executor: Pick<Executor, "source_kind" | "provider_id">) => string {
  const refs = useContext(SourceRefs);
  return (e) =>
    e.source_kind === "own" ? OWN_SOURCE_LABEL : (refs.find((r) => r.id === e.provider_id)?.name ?? "已删除的模型 API");
}

/** Agents grouped by base, bases in the order they first appear. */
export function byBase<T extends Pick<Executor, "type">>(list: readonly T[]): Array<[type: string, items: T[]]> {
  const groups = new Map<string, T[]>();
  for (const e of list) groups.set(e.type, [...(groups.get(e.type) ?? []), e]);
  return [...groups.entries()];
}
