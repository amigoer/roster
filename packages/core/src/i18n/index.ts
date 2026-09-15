import { en } from "./en.js";
import { format, type ParamValue, type Params } from "./translate.js";
import { zhCN } from "./zh-CN.js";

/**
 * Everything core writes for a person or an agent to read goes through here, in
 * the one language Roster is set to. What it stores for later -- a notice in a
 * transcript -- is kept as a key and its params, and read out in whatever the
 * language is by then.
 */

export type Locale = "en" | "zh-CN";

/** A language, or whatever the system is in. */
export type LocalePreference = Locale | "system";

export type Key = keyof typeof en;

export type ParamsFor<K extends Key> = Params<typeof en, K>;

export const LOCALES: readonly Locale[] = ["en", "zh-CN"];

const CATALOGS: { readonly [L in Locale]: { readonly [K in Key]: (typeof en)[K] | (typeof zhCN)[K] } } = { en, "zh-CN": zhCN };

let current: Locale = "en";

export const locale = (): Locale => current;

export function setLocale(next: Locale): void {
  current = next;
}

export const isLocale = (v: unknown): v is Locale => LOCALES.includes(v as Locale);

export const isPreference = (v: unknown): v is LocalePreference => v === "system" || isLocale(v);

export const isKey = (v: unknown): v is Key => typeof v === "string" && Object.hasOwn(en, v);

export function t<K extends Key>(key: K, ...params: Params<typeof en, K>): string {
  return format(current, CATALOGS[current][key], params[0]);
}

/** The message in every locale, for recognising text Roster wrote before a switch. */
export function everyLocale<K extends Key>(key: K, ...params: Params<typeof en, K>): string[] {
  return LOCALES.map((l) => format(l, CATALOGS[l][key], params[0]));
}

/** A key read back from storage, which may predate or postdate this build; null when this build does not know it. */
export function stored(key: string, params?: Readonly<Record<string, ParamValue>>): string | null {
  return isKey(key) ? format(current, CATALOGS[current][key], params) : null;
}

/** Items run together the way the current language lists them. */
export const list = (items: readonly string[]): string => items.join(t("list.separator"));

/**
 * The first supported locale in a list ordered the way browsers and operating
 * systems order preferred languages. Any Simplified Chinese tag counts; a
 * Traditional one is passed over rather than shown in the other script.
 * Kept in step with ui/src/i18n/index.tsx.
 */
export function matchLocale(tags: readonly string[]): Locale | null {
  for (const tag of tags) {
    // POSIX spells them zh_CN.UTF-8
    const [lang, ...rest] = tag.split(".")[0]!.replace(/_/g, "-").toLowerCase().split("-");
    if (lang === "en") return "en";
    if (lang === "zh" && !rest.some((s) => s === "hant" || s === "tw" || s === "hk" || s === "mo")) return "zh-CN";
  }
  return null;
}

/**
 * The system's language. The desktop shell passes the operating system's own
 * list, since a process started from the dock has no LANG and its Intl
 * defaults to en-US whatever the system is set to.
 */
export function systemLocale(): Locale {
  const shell = (process.env["ROSTER_SYSTEM_LOCALES"] ?? "").split(",").filter(Boolean);
  const own = [process.env["LC_ALL"], process.env["LC_MESSAGES"], process.env["LANG"]].filter((v): v is string => Boolean(v));
  return matchLocale([...shell, ...own, Intl.DateTimeFormat().resolvedOptions().locale]) ?? "en";
}

export const resolveLocale = (preference: LocalePreference): Locale => (preference === "system" ? systemLocale() : preference);
