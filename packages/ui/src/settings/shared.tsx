import { Check, ChevronRight, Loader, Trash2, X } from "lucide-react";
import {
  CUSTOM_PRESET,
  type CheckItem,
  type ExecutorRecord,
  type ExecutorSettings,
  type HarnessTypeInfo,
  type HarnessView,
  type ProviderPreset,
  type ProviderRecord,
} from "../api";
import { useI18n, type Translate } from "../i18n";
import { ROW } from "../list";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { RadioGroupItem } from "@/components/ui/radio-group";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

/**
 * Where the settings window is. The list column holds the six pages and never
 * grows; each page holds its own collection, and opening an item drills into
 * it. For a collection, no id is the overview, null is a new item, a string an
 * existing one.
 */
export type SettingsRoute =
  | { page: "appearance" }
  | { page: "language" }
  | { page: "about" }
  | { page: "harness"; id?: string }
  /** type: the harness a new agent starts on, when it was opened from that harness's page */
  | { page: "agent"; id?: string | null; type?: string }
  /** preset and keyEnv: a key found on this machine, so adding starts past the picker */
  | { page: "provider"; id?: string | null; preset?: string; keyEnv?: string };

/** Where the operating system keeps the key that opens stored keys, as a person knows it. */
export function keystoreName(t: Translate, keystore: string): string {
  if (keystore === "keychain" || keystore === "dpapi" || keystore === "gnome_libsecret") return t(`vault.${keystore}`);
  return keystore.startsWith("kwallet") ? "KWallet" : t("vault.system");
}

/** Every preset any type offers, once each. */
export function presetsOf(view: ExecutorSettings): ProviderPreset[] {
  const seen = new Map<string, ProviderPreset>();
  for (const list of Object.values(view.presets)) {
    for (const p of list) if (!seen.has(p.id)) seen.set(p.id, p);
  }
  return [...seen.values()].sort((a, b) => a.label.localeCompare(b.label));
}

/** The same rule core enforces: a preset has to be one this type knows, a custom endpoint has to speak its protocol. */
export function fits(type: HarnessTypeInfo, provider: ProviderRecord, view: ExecutorSettings): boolean {
  if (provider.preset === CUSTOM_PRESET) return provider.api !== null && type.sources.apis.includes(provider.api);
  return (view.presets[type.type] ?? []).some((p) => p.id === provider.preset);
}

export function keyLine(t: Translate, p: ProviderRecord): string {
  if (p.key.source === "env") return p.key.set ? t("provider.keyFromEnv", { name: p.key_env ?? "" }) : t("provider.envUnset", { name: p.key_env ?? "" });
  return p.key.set ? t("provider.keyHint", { hint: p.key.hint ?? "" }) : t("common.noKey");
}

/** What a person calls an agent's source. */
export function sourceName(t: Translate, view: ExecutorSettings, e: Pick<ExecutorRecord, "source_kind" | "provider_id">): string {
  return e.source_kind === "own" ? t("source.own") : (view.providers.find((p) => p.id === e.provider_id)?.name ?? t("source.deleted"));
}

/** The line under an agent's name: its pairing and model, or just the model when the name already says the pairing. */
export function agentLine(t: Translate, view: ExecutorSettings, harnessLabel: string, e: ExecutorRecord): string {
  const pairing = `${harnessLabel} · ${sourceName(t, view, e)}`;
  if (e.name.startsWith(pairing)) return e.model ? t("settings.defaultModelIs", { model: e.model }) : t("settings.defaultModelHarness");
  return `${pairing}${e.model ? ` · ${e.model}` : ""}`;
}

/**
 * One badge says where a harness stands: its version once it runs, since where
 * the program came from is nobody's concern, or what keeps it from running.
 */
export function harnessStatus(t: Translate, h: HarnessView): { tone: "ok" | "warn" | "bad"; text: string } | null {
  if (h.adapter === "error") return { tone: "bad", text: t("harness.status.adapterError") };
  if (h.adapter === "missing") return { tone: "warn", text: t("harness.status.noAdapter") };
  if (!h.state.usable) return { tone: "warn", text: t("harness.status.noProgram") };
  return h.state.version ? { tone: "ok", text: h.state.version } : null;
}

/** The amber every page uses for a line that says something is wrong but not broken. */
export const WARN_TEXT = "text-amber-600 dark:text-amber-400";

/** The body of every settings page: one scrolling column of the same width, so drilling in moves nothing sideways. */
export function Page({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className={cn("mx-auto max-w-2xl space-y-6 px-8 py-8", className)}>{children}</div>
    </ScrollArea>
  );
}

/** How an overview opens: what the page is, in a line, and its one action at the right. */
export function PageHeader({ title, description, action }: { title: string; description?: string; action?: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0 space-y-1">
        <h2 className="text-lg font-semibold">{title}</h2>
        {description && <p className="text-muted-foreground text-sm leading-relaxed">{description}</p>}
      </div>
      {action && <div className="shrink-0 pt-0.5">{action}</div>}
    </div>
  );
}

/** A collection with nothing in it says what would go there and how. */
export function EmptyNote({ children }: { children: React.ReactNode }) {
  return <p className="text-muted-foreground rounded-xl border border-dashed px-5 py-6 text-center text-sm leading-relaxed">{children}</p>;
}

/** The label over one group of rows on an overview. */
export function GroupLabel({ children, count, badge }: { children: React.ReactNode; count?: number; badge?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-1.5 px-1 text-xs font-medium">
      <span className="truncate">{children}</span>
      {count !== undefined && <span className="text-muted-foreground tabular-nums">{count}</span>}
      {badge}
    </div>
  );
}

/** Rows of a collection, framed: the same card the harness page lists its agents in. */
export function ListCard({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn("rounded-xl border p-1", className)}>{children}</div>;
}

/** One item of a collection: its mark, its name, one line about it, and what sits before the chevron. */
export function ListRow({
  onClick,
  media,
  title,
  badge,
  line,
  warn,
  end,
}: {
  onClick: () => void;
  media: React.ReactNode;
  title: string;
  /** beside the name: a status */
  badge?: React.ReactNode;
  line?: string;
  /** the line reads amber: something is wrong with the item */
  warn?: boolean;
  /** a count or a note at the right */
  end?: string;
}) {
  return (
    <button type="button" onClick={onClick} className={cn(ROW, "hover:bg-accent")}>
      {media}
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="truncate text-sm font-medium">{title}</span>
          {badge}
        </span>
        {line && <span className={cn("block truncate text-xs", warn ? WARN_TEXT : "text-muted-foreground")}>{line}</span>}
      </span>
      {end && <span className="text-muted-foreground shrink-0 text-xs tabular-nums">{end}</span>}
      <ChevronRight className="text-muted-foreground size-3.5 shrink-0" />
    </button>
  );
}

export function CheckResult({ result }: { result: { ok: boolean; items: CheckItem[] } | "running" | null }) {
  const { t } = useI18n();
  if (!result) return null;
  if (result === "running") {
    return (
      <p className="text-muted-foreground flex items-center gap-1.5 text-sm">
        <Loader className="size-3.5 animate-spin" />
        {t("check.running")}
      </p>
    );
  }
  return (
    <ul className="space-y-1.5 rounded-lg border px-3 py-2.5">
      {result.items.map((item, i) => (
        <li key={i} className="flex items-start gap-2 text-sm">
          {item.ok ? (
            <Check className="mt-0.5 size-3.5 shrink-0 text-emerald-600" />
          ) : (
            <X className="text-destructive mt-0.5 size-3.5 shrink-0" />
          )}
          <span className="min-w-0">
            {t.rich("common.labelDetail", {
              label: <span className="font-medium">{item.label}</span>,
              detail: <span className="text-muted-foreground">{item.detail}</span>,
            })}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** An editor: a scrolling form over a fixed row of save, cancel and, for a saved item, delete. */
export function EditorFrame({
  title,
  description,
  children,
  error,
  busy,
  canSave,
  saveLabel,
  onSave,
  onCancel,
  onDelete,
}: {
  /** left out when the page opens on its own header */
  title?: string;
  description?: string;
  children: React.ReactNode;
  error: string | null;
  busy: boolean;
  canSave: boolean;
  saveLabel: string;
  onSave: () => void;
  onCancel: () => void;
  onDelete?: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Page>
        {title && (
          <div className="space-y-1">
            <h2 className="text-lg font-semibold">{title}</h2>
            {description && <p className="text-muted-foreground text-sm">{description}</p>}
          </div>
        )}
        {children}
      </Page>
      <Separator />
      <div className="flex shrink-0 items-center justify-end gap-2 px-8 py-3">
        {onDelete && (
          <Button variant="ghost" className="text-muted-foreground hover:text-destructive" onClick={onDelete}>
            <Trash2 />
            {t("common.delete")}
          </Button>
        )}
        {error && <span className="text-destructive mr-auto ml-2 text-xs">{error}</span>}
        <span className={cn(!error && "mr-auto")} />
        <Button variant="outline" onClick={onCancel}>
          {t("common.cancel")}
        </Button>
        <Button onClick={onSave} disabled={busy || !canSave}>
          {busy && <Loader className="animate-spin" />}
          {saveLabel}
        </Button>
      </div>
    </div>
  );
}

export function ConfirmDelete({
  open,
  onOpenChange,
  title,
  description,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  onConfirm: () => void;
}) {
  const { t } = useI18n();
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={onConfirm}>
            {t("common.delete")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** A selectable card: a radio the eye reads as a tile. */
export function Choice({
  value,
  selected,
  disabled,
  className,
  children,
}: {
  value: string;
  selected: boolean;
  disabled?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <label
      className={cn(
        "flex cursor-pointer items-center gap-2.5 rounded-xl border px-3 py-2.5 transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring",
        selected ? "border-foreground/40 bg-accent" : "hover:bg-accent/50",
        disabled && "cursor-default opacity-50 hover:bg-transparent",
        className,
      )}
    >
      <RadioGroupItem value={value} disabled={disabled} className="sr-only" />
      {children}
    </label>
  );
}
