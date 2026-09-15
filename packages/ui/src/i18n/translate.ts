import { createElement, Fragment, type ReactNode } from "react";

/** Kept in step with core/src/i18n/translate.ts. */

/** A message that reads differently by count, picked with Intl.PluralRules; "other" stands in for a missing form. */
export type Plural = { readonly other: string } & { readonly [K in Exclude<Intl.LDMLPluralRule, "other">]?: string };

export type Message = string | Plural;

type Placeholders<S> = S extends `${string}{${infer P}}${infer R}` ? P | Placeholders<R> : never;

/** What a message has to be given: every {name} in it, and count when it is plural. */
export type ParamsOf<M> = M extends string ? Placeholders<M> : Placeholders<M[keyof M]> | "count";

export type ParamValue = string | number;

/** A key's params as a rest argument, so a message without placeholders takes none. */
export type Params<C, K extends keyof C> = [ParamsOf<C[K]>] extends [never]
  ? []
  : [params: { readonly [P in ParamsOf<C[K]>]: ParamValue }];

/** Params that can be elements: a name set in bold, a path in monospace. */
export type RichParams<C, K extends keyof C> = { readonly [P in ParamsOf<C[K]>]: P extends "count" ? number : ReactNode };

/** Keys whose translation names a placeholder the source message is never given. */
type Mismatched<S, T> = {
  [K in keyof S & keyof T]: [ParamsOf<T[K]>] extends [ParamsOf<S[K]>] ? never : K;
}[keyof S & keyof T];

/**
 * Checks a translation against its source: every key present, none extra, and
 * no placeholder the source does not pass. A bad entry fails to compile where
 * it is written.
 */
export const translation =
  <S>() =>
  <const T extends { readonly [K in keyof S]: Message }>(
    messages: T & NoInfer<{ readonly [K in Mismatched<S, T> | Exclude<keyof T, keyof S>]: never }>,
  ): T =>
    messages;

const pluralRules = new Map<string, Intl.PluralRules>();

function pick(locale: string, message: Message, count: unknown): string {
  if (typeof message === "string") return message;
  let rules = pluralRules.get(locale);
  if (!rules) pluralRules.set(locale, (rules = new Intl.PluralRules(locale)));
  return message[rules.select(Number(count ?? 0))] ?? message.other;
}

const PLACEHOLDER = /\{(\w+)\}/g;

export function format(locale: string, message: Message, params?: Readonly<Record<string, ParamValue>>): string {
  const text = pick(locale, message, params?.["count"]);
  // a brace nothing fills is left as written
  return params ? text.replace(PLACEHOLDER, (whole, name: string) => (Object.hasOwn(params, name) ? String(params[name]) : whole)) : text;
}

/** The same message with elements where its placeholders are. */
export function formatRich(locale: string, message: Message, params: Readonly<Record<string, ReactNode>>): ReactNode {
  const text = pick(locale, message, params["count"]);
  const parts: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(PLACEHOLDER)) {
    const name = m[1]!;
    if (!Object.hasOwn(params, name)) continue;
    parts.push(text.slice(last, m.index), params[name]);
    last = m.index + m[0].length;
  }
  parts.push(text.slice(last));
  return createElement(Fragment, null, ...parts);
}
