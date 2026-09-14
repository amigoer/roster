import { Cpu, KeyRound, Puzzle } from "lucide-react";
import { CUSTOM_PRESET, type ProviderPreset, type ProviderRecord, type SourceRef } from "./api";
import { ProviderIcon, type Provider } from "./provider-icon";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/**
 * The one look an executor, an endpoint or an extension has, wherever it
 * shows: settings, the contact list, the session bar. A person recognises the
 * mark faster than the name.
 */

/** Every protocol speaks for a specific vendor, so the picker can show its mark without guessing. */
export const API_BRAND: Record<string, Provider> = {
  "openai-completions": "openai",
  "openai-responses": "openai",
  "anthropic-messages": "claude",
  "google-generative-ai": "google",
  "mistral-conversations": "mistral",
};

export const API_LABEL: Record<string, string> = {
  "openai-completions": "OpenAI 兼容（Chat Completions）",
  "openai-responses": "OpenAI Responses",
  "anthropic-messages": "Anthropic 兼容（Messages）",
  "google-generative-ai": "Google Gemini",
  "mistral-conversations": "Mistral",
};

/**
 * A preset or a saved endpoint only ever carries free text (its preset id, its
 * name, a custom base_url), never a vendor field, so the brand is read off
 * whichever of those happens to name it. The wire protocol is deliberately
 * left out: plenty of third parties speak someone else's protocol.
 */
export function brandFromText(hay: string): Provider {
  const h = hay.toLowerCase();
  if (h.includes("deepseek")) return "deepseek";
  if (h.includes("anthropic") || h.includes("claude")) return "claude";
  if (h.includes("mistral")) return "mistral";
  if (h.includes("google") || h.includes("gemini") || h.includes("generativelanguage")) return "google";
  if (h.includes("openai") || h.includes("gpt")) return "openai";
  return "unknown";
}

export const brandOfProvider = (p: Pick<ProviderRecord, "preset" | "name" | "base_url"> | SourceRef): Provider =>
  brandFromText(`${p.preset} ${p.name} ${"base_url" in p ? (p.base_url ?? "") : ""}`);

export const brandOfPreset = (p: Pick<ProviderPreset, "id" | "label">): Provider => brandFromText(`${p.id} ${p.label}`);

/** The harness itself, not the models it calls. Types from the catalog carry their brand; the rest go by name. */
export const HARNESS_BRAND: Record<string, Provider> = {
  "claude-code": "claude",
  "pi-agent": "pi",
  codex: "openai",
  "gemini-cli": "google",
};

export const brandOfType = (type: string, brand?: string): Provider =>
  (brand as Provider | undefined) ?? HARNESS_BRAND[type] ?? brandFromText(type);

const SIZE = {
  xs: "size-5 rounded-[23%] [&>svg]:size-3",
  sm: "size-7 rounded-[23%] [&>svg]:size-3.5",
  md: "size-9 rounded-[23%] [&>svg]:size-4",
  lg: "size-11 rounded-[23%] [&>svg]:size-5",
} as const;

const LETTER = { xs: "text-[10px]", sm: "text-xs", md: "text-sm", lg: "text-base" } as const;

const TILE = "inline-flex shrink-0 items-center justify-center";
// a grey tile vanishes into a selected row, and a grey mark reads as disabled
const RAISED = "bg-background ring-border ring-1 ring-inset dark:bg-muted";

/** A vendor without a mark still gets a face of its own: thirty identical key icons read as one blur. */
export const initialOf = (text: string): string => (text.match(/[a-z0-9]/i)?.[0] ?? "").toUpperCase();

export function Mark({
  brand,
  fallback,
  initial,
  size = "md",
  className,
}: {
  brand: Provider | undefined;
  fallback: React.ReactNode;
  /** shown instead of the fallback when there is no mark */
  initial?: string;
  size?: keyof typeof SIZE;
  className?: string;
}) {
  const known = brand !== undefined && brand !== "unknown";
  const lettered = !known && Boolean(initial);
  return (
    <span
      className={cn(TILE, known || lettered ? RAISED : "bg-muted text-muted-foreground", SIZE[size], className)}
    >
      {/* an explicit text colour also keeps shadcn's muted-svg rule in menus off the monochrome marks */}
      {known ? (
        <ProviderIcon provider={brand} className="text-foreground" />
      ) : lettered ? (
        <span className={cn("text-foreground font-semibold", LETTER[size])}>{initial}</span>
      ) : (
        fallback
      )}
    </span>
  );
}

export function ExecutorTile({ type, brand, size }: { type: string; brand?: string; size?: keyof typeof SIZE }) {
  return <Mark brand={brandOfType(type, brand)} fallback={<Cpu />} size={size} />;
}

export function ProviderTile({ provider, size }: { provider?: Pick<ProviderRecord, "preset" | "name" | "base_url"> | SourceRef; size?: keyof typeof SIZE }) {
  return (
    <Mark
      brand={provider ? brandOfProvider(provider) : undefined}
      fallback={provider ? <KeyRound /> : <Cpu />}
      // a custom endpoint keeps the key: it is nobody's brand
      initial={provider && provider.preset !== CUSTOM_PRESET ? initialOf(provider.preset) : undefined}
      size={size}
    />
  );
}

export function PresetTile({ preset, size }: { preset: Pick<ProviderPreset, "id" | "label">; size?: keyof typeof SIZE }) {
  return <Mark brand={brandOfPreset(preset)} fallback={<KeyRound />} initial={initialOf(preset.id)} size={size} />;
}

/** A protocol's name without the wire detail, where a line has no room for it. */
export const apiShort = (api: string | null | undefined): string => (API_LABEL[api ?? ""] ?? api ?? "").replace(/（.*）$/, "");

export function HarnessTile({ type, brand, size }: { type: string; brand?: string; size?: keyof typeof SIZE }) {
  return <Mark brand={brandOfType(type, brand)} fallback={<Puzzle />} size={size} />;
}

/** A page of Roster's own settings: no vendor behind it, but it is no less there than a known mark. */
export function SettingTile({ children }: { children: React.ReactNode }) {
  return <span className={cn(TILE, RAISED, "text-foreground", SIZE.md)}>{children}</span>;
}

/** The endpoint's protocol in words, or its preset's name when it has one. */
export function providerKind(p: Pick<ProviderRecord, "preset" | "api">, presets: readonly ProviderPreset[]): string {
  if (p.preset === CUSTOM_PRESET) return API_LABEL[p.api ?? ""] ?? p.api ?? "自定义";
  return presets.find((x) => x.id === p.preset)?.label ?? p.preset;
}

export type Tone = "ok" | "warn" | "bad" | "quiet";

const TONE: Record<Tone, string> = {
  ok: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  warn: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  bad: "border-destructive/30 bg-destructive/10 text-destructive",
  quiet: "",
};

/** One badge for every state: signed in, missing, found on this machine, contract mismatch. */
export function StatusBadge({ tone, children, className }: { tone: Tone; children: React.ReactNode; className?: string }) {
  return (
    <Badge variant="outline" className={cn("px-1.5 py-0 text-[10px] font-normal", TONE[tone], className)}>
      {children}
    </Badge>
  );
}
