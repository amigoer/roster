import { useEffect, useState } from "react";
import type { Translate } from "./i18n";

/** A font the picker offers, and the CSS families it goes by, first installed wins. What people call it is in the catalog. */
export type FontOption = { id: "hiragino" | "heiti" | "yuanti" | "songti" | "kaiti" | "lxgw" | "sourcehan" | "misans" | "harmony"; families: string[] };

export const SYSTEM_FONT = "system";
export const CUSTOM_FONT = "custom";

/**
 * Fonts worth a card: what macOS and Windows ship for Chinese, and a few people
 * install themselves. A card only shows for a font this machine has.
 */
export const FONT_OPTIONS: FontOption[] = [
  { id: "hiragino", families: ["Hiragino Sans GB"] },
  { id: "heiti", families: ["Heiti SC", "SimHei"] },
  { id: "yuanti", families: ["Yuanti SC"] },
  { id: "songti", families: ["Songti SC", "SimSun"] },
  { id: "kaiti", families: ["Kaiti SC", "KaiTi", "STKaiti"] },
  { id: "lxgw", families: ["LXGW WenKai", "LXGW WenKai Screen"] },
  { id: "sourcehan", families: ["Source Han Sans SC", "Noto Sans CJK SC", "Noto Sans SC"] },
  { id: "misans", families: ["MiSans"] },
  { id: "harmony", families: ["HarmonyOS Sans SC"] },
];

export type TextSize = "small" | "normal" | "large" | "xlarge";
export const TEXT_SIZES: { id: TextSize; px: number }[] = [
  { id: "small", px: 13 },
  { id: "normal", px: 14 },
  { id: "large", px: 16 },
  { id: "xlarge", px: 18 },
];

export type Typography = { font: string; customFont: string; size: TextSize };

const probe = new Map<string, boolean>();

/** Whether this machine has the family: text set in it measures differently from the generic fallback alone. */
export function fontInstalled(family: string): boolean {
  const known = probe.get(family);
  if (known !== undefined) return known;
  let ok = false;
  try {
    const ctx = document.createElement("canvas").getContext("2d");
    if (ctx) {
      // the Latin run is what tells fonts apart; CJK glyphs are one em wide in all of them
      const sample = "Roster mixed 1234 永和九年";
      ok = ["monospace", "serif", "sans-serif"].some((generic) => {
        ctx.font = `32px ${generic}`;
        const base = ctx.measureText(sample).width;
        ctx.font = `32px "${family}", ${generic}`;
        return ctx.measureText(sample).width !== base;
      });
    }
  } catch {
    // no canvas: offer nothing beyond the default
  }
  probe.set(family, ok);
  return ok;
}

export function installedFamily(option: FontOption): string | null {
  return option.families.find(fontInstalled) ?? null;
}

/** A typed-in name, made safe to drop into a font-family list. */
export function cleanFamily(name: string): string {
  return name.replace(/["\;{}]/g, "").trim();
}

/** The family a choice resolves to, or null when it falls back to the stylesheet's default stack. */
export function chosenFamily(t: Typography): string | null {
  if (t.font === CUSTOM_FONT) {
    // a name this machine does not answer to would fall back anyway; say so rather than claim it
    const name = cleanFamily(t.customFont);
    return name && fontInstalled(name) ? name : null;
  }
  const option = FONT_OPTIONS.find((o) => o.id === t.font);
  return option ? installedFamily(option) : null;
}

/** What the settings row says about the font: nothing while it is the default. */
export function fontLabel(t: Translate, typography: Typography): string | null {
  if (typography.font === CUSTOM_FONT) return cleanFamily(typography.customFont) || t("appearance.otherFont");
  const option = FONT_OPTIONS.find((o) => o.id === typography.font);
  return option ? t(`font.${option.id}`) : null;
}

export function sizeLabel(t: Translate, typography: Typography): string | null {
  return typography.size === "normal" ? null : t(`size.${typography.size}.row`);
}

const KEYS = { font: "roster.font", custom: "roster.fontCustom", size: "roster.textSize" };

function read(): Typography {
  const t: Typography = { font: SYSTEM_FONT, customFont: "", size: "normal" };
  try {
    const font = localStorage.getItem(KEYS.font);
    if (font && (font === CUSTOM_FONT || FONT_OPTIONS.some((o) => o.id === font))) t.font = font;
    t.customFont = localStorage.getItem(KEYS.custom) ?? "";
    const size = localStorage.getItem(KEYS.size);
    if (TEXT_SIZES.some((s) => s.id === size)) t.size = size as TextSize;
  } catch {
    // preferences that cannot be remembered still apply for this session
  }
  return t;
}

function apply(t: Typography): void {
  const root = document.documentElement.style;
  const family = chosenFamily(t);
  // the default stack stays behind the chosen family for the glyphs it lacks
  if (family) root.setProperty("--app-font", `"${family}", var(--font-default)`);
  else root.removeProperty("--app-font");
  root.setProperty("--message-size", `${TEXT_SIZES.find((s) => s.id === t.size)?.px ?? 14}px`);
}

/** Font and text size, applied as CSS variables on the root. Call it once, at the root, like useTheme. */
export function useTypography() {
  const [typography, setTypography] = useState<Typography>(read);

  useEffect(() => {
    apply(typography);
    try {
      localStorage.setItem(KEYS.font, typography.font);
      localStorage.setItem(KEYS.custom, typography.customFont);
      localStorage.setItem(KEYS.size, typography.size);
    } catch {
      // ignore
    }
  }, [typography]);

  return {
    typography,
    setFont: (font: string) => setTypography((t) => ({ ...t, font })),
    setCustomFont: (customFont: string) => setTypography((t) => ({ ...t, font: CUSTOM_FONT, customFont })),
    setSize: (size: TextSize) => setTypography((t) => ({ ...t, size })),
  };
}
