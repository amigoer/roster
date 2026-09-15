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

export function format(locale: string, message: Message, params?: Readonly<Record<string, ParamValue>>): string {
  let text: string;
  if (typeof message === "string") {
    text = message;
  } else {
    let rules = pluralRules.get(locale);
    if (!rules) pluralRules.set(locale, (rules = new Intl.PluralRules(locale)));
    text = message[rules.select(Number(params?.["count"] ?? 0))] ?? message.other;
  }
  // a brace nothing fills is left as written
  return params ? text.replace(/\{(\w+)\}/g, (whole, name: string) => (Object.hasOwn(params, name) ? String(params[name]) : whole)) : text;
}
