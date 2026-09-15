import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { en } from "./en";
import { format, formatRich, type ParamValue, type Params, type RichParams } from "./translate";
import { zhCN } from "./zh-CN";

export type Locale = "en" | "zh-CN";

/** A language, or whatever the system is in. */
export type LocalePreference = Locale | "system";

export type Key = keyof typeof en;

/** What core says: the language picked, and the one it came out as. */
export type LocaleState = { preference: LocalePreference; resolved: Locale };

/** Each language under its own name, so someone who cannot read the current one still finds theirs. */
export const LOCALES: ReadonlyArray<{ id: Locale; name: string }> = [
  { id: "en", name: "English" },
  { id: "zh-CN", name: "简体中文" },
];

const CATALOGS: { readonly [L in Locale]: { readonly [K in Key]: (typeof en)[K] | (typeof zhCN)[K] } } = { en, "zh-CN": zhCN };

export const isLocale = (v: unknown): v is Locale => LOCALES.some((l) => l.id === v);

/**
 * The first supported locale in a list ordered the way browsers and operating
 * systems order preferred languages. Kept in step with core/src/i18n/index.ts.
 */
export function matchLocale(tags: readonly string[]): Locale | null {
  for (const tag of tags) {
    const [lang, ...rest] = tag.split(".")[0]!.replace(/_/g, "-").toLowerCase().split("-");
    if (lang === "en") return "en";
    if (lang === "zh" && !rest.some((s) => s === "hant" || s === "tw" || s === "hk" || s === "mo")) return "zh-CN";
  }
  return null;
}

export interface Translate {
  <K extends Key>(key: K, ...params: Params<typeof en, K>): string;
  rich<K extends Key>(key: K, params: RichParams<typeof en, K>): ReactNode;
}

function translator(locale: Locale): Translate {
  const catalog = CATALOGS[locale];
  const t = ((key: Key, params?: Readonly<Record<string, ParamValue>>) => format(locale, catalog[key], params)) as Translate;
  t.rich = (key, params) => formatRich(locale, catalog[key], params);
  return t;
}

/** Chinese keeps the two-digit 24-hour clock it always had; English reads the way English clocks do. */
const CLOCK: Record<Locale, Intl.DateTimeFormatOptions> = {
  en: { hour: "numeric", minute: "2-digit" },
  "zh-CN": { hour: "2-digit", minute: "2-digit", hourCycle: "h23" },
};

export interface I18n {
  locale: Locale;
  preference: LocalePreference;
  t: Translate;
  /** items run together the way the language lists them */
  list(items: readonly string[]): string;
  /** a time of day */
  clock(ts: number): string;
  /** a month and day, without the year */
  day(ts: number): string;
  sync(state: LocaleState): void;
}

const CACHE = "roster.locale";

/** The language core last settled on, so the window paints in it before core has answered. */
function cached(): LocaleState {
  try {
    const saved = JSON.parse(localStorage.getItem(CACHE) ?? "null") as Partial<LocaleState> | null;
    if (saved && isLocale(saved.resolved) && (saved.preference === "system" || isLocale(saved.preference))) {
      return { preference: saved.preference, resolved: saved.resolved };
    }
  } catch {
    // nothing remembered: guess from the browser until core says
  }
  return { preference: "system", resolved: matchLocale(navigator.languages) ?? "en" };
}

let current = cached();
// before the first render, so fonts pick the right glyphs from the start
document.documentElement.lang = current.resolved;
let currentT = translator(current.resolved);

/** For code outside components, such as the API client: it reads the language at the moment it is called. */
export function translate<K extends Key>(key: K, ...params: Params<typeof en, K>): string {
  return currentT(key, ...params);
}

const I18nContext = createContext<I18n | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState(current);
  const sync = useCallback(
    (next: LocaleState) =>
      setState((prev) => (prev.preference === next.preference && prev.resolved === next.resolved ? prev : next)),
    [],
  );

  const value = useMemo<I18n>(() => {
    const locale = state.resolved;
    const t = translator(locale);
    const clock = new Intl.DateTimeFormat(locale, CLOCK[locale]);
    const day = new Intl.DateTimeFormat(locale, { month: "numeric", day: "numeric" });
    return {
      locale,
      preference: state.preference,
      t,
      list: (items) => items.join(t("common.listSeparator")),
      clock: (ts) => clock.format(ts),
      day: (ts) => day.format(ts),
      sync,
    };
  }, [state, sync]);

  useEffect(() => {
    current = state;
    currentT = value.t;
    document.documentElement.lang = state.resolved;
    try {
      localStorage.setItem(CACHE, JSON.stringify(state));
    } catch {
      // a language that cannot be remembered is asked of core again next time
    }
  }, [state, value]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18n {
  const i18n = useContext(I18nContext);
  if (!i18n) throw new Error("useI18n is only for components under I18nProvider");
  return i18n;
}
