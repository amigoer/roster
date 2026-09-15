import { useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  ChevronRight,
  Copy,
  Download,
  Info,
  KeyRound,
  Languages,
  Loader,
  Lock,
  LockOpen,
  Plus,
  RefreshCw,
  ScanSearch,
  Search,
  SunMoon,
  Trash2,
  X,
} from "lucide-react";
import { toast } from "sonner";
import {
  api,
  CUSTOM_PRESET,
  type HarnessView,
  type Bot,
  type CheckItem,
  type CredentialHint,
  type DetectedProgram,
  type Environment,
  type ExecutorRecord,
  type ExecutorSettings,
  type ExtensionsView,
  type HarnessTypeInfo,
  type InstallJob,
  type LoginState,
  type ModelOption,
  type ModelProbe,
  type ProviderPreset,
  type ProviderRecord,
  type SourceKind,
} from "./api";
import { coreOutdated, type AboutState } from "./about";
import { BotAvatar } from "./bot-avatar";
import { CapabilityNotes } from "./capabilities";
import { LOCALES, useI18n, type I18n, type Translate } from "./i18n";
import { LIST_BODY, ROW, rowState, SectionLabel } from "./list";
import { ProviderIcon } from "./provider-icon";
import type { Theme } from "./theme";
import { fontLabel, sizeLabel, type Typography } from "./typography";
import {
  API_BRAND,
  API_IDS,
  apiLabel,
  apiShort,
  brandFromText,
  ExecutorTile,
  HarnessTile,
  Mark,
  PresetTile,
  ProviderTile,
  providerKind,
  SettingTile,
  StatusBadge,
} from "./tiles";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Item, ItemActions, ItemContent, ItemDescription, ItemMedia, ItemTitle } from "@/components/ui/item";
import { Progress } from "@/components/ui/progress";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";

/**
 * Three things are set up here, in the order they build on each other:
 * harnesses (the programs, stateless), model APIs (keys), and agents -- a
 * harness bound to one source, which is what bots pick.
 */
export type SettingsSelection =
  | { kind: "appearance" }
  | { kind: "language" }
  | { kind: "about" }
  /** every harness Roster knows, to fetch more; an id scrolls to that harness's card */
  | { kind: "harnesses"; id?: string }
  | { kind: "harness"; id: string }
  /** null creates one, on the given harness when it was opened from that harness's page */
  | { kind: "agent"; id: string | null; type?: string }
  | { kind: "provider"; id: string | null }
  | null;

/** Protocols a hand-entered endpoint can speak; the rest need cloud setup a key alone does not cover. */
const CUSTOM_APIS = API_IDS;

/** Where the operating system keeps the key that opens stored keys, as a person knows it. */
function keystoreName(t: Translate, keystore: string): string {
  if (keystore === "keychain" || keystore === "dpapi" || keystore === "gnome_libsecret") return t(`vault.${keystore}`);
  return keystore.startsWith("kwallet") ? "KWallet" : t("vault.system");
}

/** Every preset any type offers, once each. */
function presetsOf(view: ExecutorSettings): ProviderPreset[] {
  const seen = new Map<string, ProviderPreset>();
  for (const list of Object.values(view.presets)) {
    for (const p of list) if (!seen.has(p.id)) seen.set(p.id, p);
  }
  return [...seen.values()].sort((a, b) => a.label.localeCompare(b.label));
}

/** The same rule core enforces: a preset has to be one this type knows, a custom endpoint has to speak its protocol. */
function fits(type: HarnessTypeInfo, provider: ProviderRecord, view: ExecutorSettings): boolean {
  if (provider.preset === CUSTOM_PRESET) return provider.api !== null && type.sources.apis.includes(provider.api);
  return (view.presets[type.type] ?? []).some((p) => p.id === provider.preset);
}

function keyLine(t: Translate, p: ProviderRecord): string {
  if (p.key.source === "env") return p.key.set ? t("provider.keyFromEnv", { name: p.key_env ?? "" }) : t("provider.envUnset", { name: p.key_env ?? "" });
  return p.key.set ? t("provider.keyHint", { hint: p.key.hint ?? "" }) : t("common.noKey");
}

function SectionHead({ label, onAdd, addLabel }: { label: string; onAdd: () => void; addLabel: string }) {
  return (
    <div className="flex items-center justify-between pt-3 pr-1 pb-1 pl-2.5">
      <span className="text-muted-foreground text-[11px] font-medium">{label}</span>
      <Button variant="ghost" size="icon-xs" className="text-muted-foreground" title={addLabel} onClick={onAdd}>
        <Plus />
      </Button>
    </div>
  );
}

/**
 * One badge says where a harness stands: its version once it runs, since where
 * the program came from is nobody's concern, or what keeps it from running.
 */
function harnessStatus(t: Translate, h: HarnessView): { tone: "ok" | "warn" | "bad"; text: string } | null {
  if (h.adapter === "error") return { tone: "bad", text: t("harness.status.adapterError") };
  if (h.adapter === "missing") return { tone: "warn", text: t("harness.status.noAdapter") };
  if (!h.state.usable) return { tone: "warn", text: t("harness.status.noProgram") };
  return h.state.version ? { tone: "ok", text: h.state.version } : null;
}

export function SettingsList({
  view,
  ext,
  theme,
  typography,
  about,
  selected,
  onSelect,
}: {
  view: ExecutorSettings | null;
  ext: ExtensionsView | null;
  theme: Theme;
  typography: Typography;
  about: AboutState;
  selected: SettingsSelection;
  onSelect: (s: SettingsSelection) => void;
}) {
  const { t, locale, preference } = useI18n();
  const outdated = coreOutdated(about);
  const localeName = LOCALES.find((l) => l.id === locale)?.name ?? locale;
  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className={LIST_BODY}>
        {/* Roster's own preferences come first and never wait on core */}
        <SectionLabel>{t("settings.general")}</SectionLabel>
        <button
          type="button"
          onClick={() => onSelect({ kind: "appearance" })}
          className={cn(ROW, rowState(selected?.kind === "appearance"))}
        >
          <SettingTile>
            <SunMoon />
          </SettingTile>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium">{t("settings.appearance")}</div>
            {/* the theme always; font and size only once they differ from the default */}
            <div className="text-muted-foreground truncate text-xs">
              {[t(`theme.${theme}`), fontLabel(t, typography), sizeLabel(t, typography)].filter(Boolean).join(" · ")}
            </div>
          </div>
        </button>
        <button
          type="button"
          onClick={() => onSelect({ kind: "language" })}
          className={cn(ROW, rowState(selected?.kind === "language"))}
        >
          <SettingTile>
            <Languages />
          </SettingTile>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium">{t("settings.language")}</div>
            <div className="text-muted-foreground truncate text-xs">
              {preference === "system" ? t("language.systemRow", { language: localeName }) : localeName}
            </div>
          </div>
        </button>
        <button
          type="button"
          onClick={() => onSelect({ kind: "about" })}
          className={cn(ROW, rowState(selected?.kind === "about"))}
        >
          <SettingTile>
            <Info />
          </SettingTile>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium">{t("settings.aboutRoster")}</div>
            {/* a stale core is easy to miss, so the row says so without the page being opened */}
            <div className={cn("truncate text-xs", outdated ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground")}>
              {outdated
                ? t("settings.aboutStale")
                : about && "version" in about
                  ? t("about.version", { version: about.version })
                  : t("settings.aboutHint")}
            </div>
          </div>
        </button>

        {view ? (
          <CoreSettings view={view} ext={ext} selected={selected} onSelect={onSelect} />
        ) : (
          <div className="space-y-3 px-2.5 pt-4">
            {[0, 1, 2].map((i) => (
              <div key={i} className="flex items-center gap-3">
                <Skeleton className="size-9 rounded-[23%]" />
                <div className="flex-1 space-y-1.5">
                  <Skeleton className="h-3.5 w-2/5" />
                  <Skeleton className="h-3 w-3/5" />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </ScrollArea>
  );
}

function CoreSettings({
  view,
  ext,
  selected,
  onSelect,
}: {
  view: ExecutorSettings;
  ext: ExtensionsView | null;
  selected: SettingsSelection;
  onSelect: (s: SettingsSelection) => void;
}) {
  const { t } = useI18n();
  const presets = presetsOf(view);
  const is = (kind: "harness" | "agent" | "provider", id: string) =>
    selected !== null && selected.kind === kind && "id" in selected && selected.id === id;
  const harnesses = ext?.harnesses ?? [];
  const ready = harnesses.filter((h) => h.state.usable);
  const harnessOf = (type: string) => harnesses.find((h) => h.id === type);
  return (
    <>
      <SectionHead
        label={t("settings.harnessesCount", { count: ready.length })}
        addLabel={t("settings.moreHarnesses")}
        onAdd={() => onSelect({ kind: "harnesses" })}
      />
      {ext && ready.length === 0 && (
        <button
          type="button"
          onClick={() => onSelect({ kind: "harnesses" })}
          className={cn(ROW, "text-muted-foreground text-xs leading-relaxed", rowState(selected?.kind === "harnesses"))}
        >
          {t("settings.noHarnesses")}
        </button>
      )}
      {ready.map((h) => {
        // a program picked by hand is the person's own doing, and the version found elsewhere may not be its
        const picked = view.programs[h.id];
        return (
          <button
            key={h.id}
            type="button"
            onClick={() => onSelect({ kind: "harness", id: h.id })}
            className={cn(ROW, rowState(is("harness", h.id)))}
          >
            <HarnessTile type={h.id} brand={h.brand} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">{h.label}</div>
              <div className={cn("text-muted-foreground truncate", picked ? "font-mono text-[11px]" : "text-xs")}>
                {picked ?? (h.state.version ? t("about.version", { version: h.state.version }) : t("settings.versionUnknown"))}
              </div>
            </div>
          </button>
        );
      })}

      <SectionHead
        label={t("settings.agentsCount", { count: view.executors.length })}
        addLabel={t("agent.new")}
        onAdd={() => onSelect({ kind: "agent", id: null })}
      />
      {view.executors.length === 0 && (
        <p className="text-muted-foreground px-2.5 py-2 text-xs leading-relaxed">{t("settings.noAgents")}</p>
      )}
      {view.executors.map((e) => {
        const pairing = `${harnessOf(e.type)?.label ?? e.type} · ${sourceName(t, view, e)}`;
        // a name that already says the pairing leaves the second line to the model
        const line = e.name.startsWith(pairing)
          ? e.model
            ? t("settings.defaultModelIs", { model: e.model })
            : t("settings.defaultModelHarness")
          : `${pairing}${e.model ? ` · ${e.model}` : ""}`;
        return (
          <button
            key={e.id}
            type="button"
            onClick={() => onSelect({ kind: "agent", id: e.id })}
            className={cn(ROW, rowState(is("agent", e.id)))}
          >
            <ExecutorTile type={e.type} brand={harnessOf(e.type)?.brand} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">{e.name}</div>
              <div className={cn("truncate text-xs", e.problem ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground")}>
                {e.problem ?? line}
              </div>
            </div>
          </button>
        );
      })}

      <SectionHead
        label={t("settings.providersCount", { count: view.providers.length })}
        addLabel={t("provider.add")}
        onAdd={() => onSelect({ kind: "provider", id: null })}
      />
      {view.providers.length === 0 && (
        <p className="text-muted-foreground px-2.5 py-2 text-xs leading-relaxed">{t("settings.noProviders")}</p>
      )}
      {view.providers.map((p) => (
        <button
          key={p.id}
          type="button"
          onClick={() => onSelect({ kind: "provider", id: p.id })}
          className={cn(ROW, rowState(is("provider", p.id)))}
        >
          <ProviderTile provider={p} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium">{p.name}</div>
            <div className="text-muted-foreground truncate text-xs">
              {providerKind(t, p, presets)} · {keyLine(t, p)}
            </div>
          </div>
        </button>
      ))}

      <div className="text-muted-foreground flex items-start gap-1.5 px-2.5 pt-4 pb-1 text-[11px] leading-relaxed">
        {view.vault.encrypted ? <Lock className="mt-0.5 size-3 shrink-0" /> : <LockOpen className="mt-0.5 size-3 shrink-0 text-amber-600" />}
        {view.vault.encrypted
          ? t("vault.encrypted", { keystore: keystoreName(t, view.vault.keystore) })
          : t("vault.plain")}
      </div>
    </>
  );
}

function CheckResult({ result }: { result: { ok: boolean; items: CheckItem[] } | "running" | null }) {
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

function EditorFrame({
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
      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto max-w-2xl space-y-6 px-8 py-8">
          {title && (
            <div className="space-y-1">
              <h2 className="text-lg font-semibold">{title}</h2>
              {description && <p className="text-muted-foreground text-sm">{description}</p>}
            </div>
          )}
          {children}
        </div>
      </ScrollArea>
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
          {saveLabel}
        </Button>
      </div>
    </div>
  );
}

function ConfirmDelete({
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

/** A re-scan in one line: what changed since the last one, or what is there when nothing did. */
function detectionSummary(
  { t, list }: Pick<I18n, "t" | "list">,
  before: DetectedProgram[] | undefined,
  after: DetectedProgram[],
  label: (id: string) => string,
): string {
  const named = (p: DetectedProgram) => (p.version ? `${label(p.id)} ${p.version}` : label(p.id));
  const unknown = t("detect.unknownVersion");
  const news = before
    ? [
        ...after.flatMap((p) => {
          const old = before.find((q) => q.id === p.id);
          if (!old) return [t("detect.new", { program: named(p) })];
          return old.version === p.version
            ? []
            : [t("detect.changed", { program: label(p.id), from: old.version ?? unknown, to: p.version ?? unknown })];
        }),
        ...before.filter((p) => !after.some((q) => q.id === p.id)).map((p) => t("detect.gone", { program: label(p.id) })),
      ]
    : [];
  if (news.length > 0) return news.join(t("detect.separator"));
  if (after.length === 0) return t("detect.none");
  const found = list(after.map(named));
  return before ? t("detect.unchanged", { programs: found }) : t("detect.found", { programs: found });
}

function EnvironmentCard({
  env,
  refreshing,
  onRefresh,
  harnesses,
}: {
  env: Environment | null;
  refreshing: boolean;
  onRefresh: () => void;
  harnesses: HarnessView[];
}) {
  const { t, list } = useI18n();
  const label = (id: string) => harnesses.find((c) => c.id === id)?.label ?? id;
  return (
    <div className="rounded-xl border">
      <div className="flex items-center justify-between gap-3 px-4 py-3">
        <div className="flex items-center gap-2">
          <ScanSearch className="text-muted-foreground size-4" />
          <span className="text-sm font-medium">{t("detect.title")}</span>
        </div>
        <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={onRefresh} disabled={refreshing}>
          <RefreshCw className={cn("size-3.5", refreshing && "animate-spin")} />
          {t("detect.again")}
        </Button>
      </div>
      <Separator />
      <div className="space-y-3 px-4 py-3 text-sm">
        {!env ? (
          <div className="space-y-1.5">
            <Skeleton className="h-3.5 w-1/2" />
            <Skeleton className="h-3.5 w-1/3" />
          </div>
        ) : (
          <>
            {env.programs.length === 0 ? (
              <p className="text-muted-foreground">{t("detect.noneHint")}</p>
            ) : (
              <ul className="space-y-1.5">
                {env.programs.map((p) => (
                  <li key={p.id} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                    <span className="font-medium">{label(p.id)}</span>
                    {p.version && <span className="text-muted-foreground tabular-nums">{p.version}</span>}
                    <span className="text-muted-foreground min-w-0 truncate font-mono text-xs" title={p.path}>
                      {p.path}
                    </span>
                    <span className="text-muted-foreground/70 text-xs">{t(`detect.where.${p.found}`)}</span>
                  </li>
                ))}
              </ul>
            )}
            {env.hints.length > 0 && (
              <p className="text-muted-foreground text-xs leading-relaxed">
                {t("detect.hints", {
                  hints: list(env.hints.map((h) => (h.kind === "env" ? t("detect.hintEnv", { name: h.name }) : t("detect.hintPi", { name: h.name })))),
                })}
              </p>
            )}
            {!env.shell.ok && <p className="text-muted-foreground text-xs">{t("detect.shellSilent")}</p>}
          </>
        )}
      </div>
    </div>
  );
}

function JobLine({ job }: { job: InstallJob }) {
  const { t } = useI18n();
  const last = job.log.at(-1);
  if (job.state === "running") {
    return (
      <div className="space-y-1.5">
        <Progress value={null as unknown as number} className="h-1" />
        <p className="text-muted-foreground truncate text-xs">{last ?? t("install.downloading")}</p>
      </div>
    );
  }
  if (job.state === "failed") {
    return (
      <Alert variant="destructive">
        <AlertTitle>{t("install.failed")}</AlertTitle>
        <AlertDescription>
          <pre className="max-h-32 overflow-auto font-mono text-[11px] leading-relaxed whitespace-pre-wrap">{job.log.join("\n") || t("install.noOutput")}</pre>
        </AlertDescription>
      </Alert>
    );
  }
  return null;
}

/**
 * Every harness Roster can drive, and where each stands on this machine: the
 * adapter ships with Roster, the program is found or fetched. The first thing a
 * fresh install sees, and the place to come back to for more. Each harness's own
 * setup is on its own page.
 */
export function HarnessesPanel({
  bump,
  view,
  intro,
  focus,
  onChanged,
  onSelect,
}: {
  /** incremented when core says extensions changed */
  bump: number;
  view: ExecutorSettings;
  /** first run: say what the steps are */
  intro: boolean;
  /** the harness picked in the list, scrolled to and outlined */
  focus?: string;
  onChanged: () => void;
  onSelect: (s: SettingsSelection) => void;
}) {
  const [ext, setExt] = useState<ExtensionsView | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const i18n = useI18n();
  const { t } = i18n;

  const load = () => api.extensions().then(setExt);
  useEffect(() => {
    void load();
  }, [bump]);

  const loaded = ext !== null;
  useEffect(() => {
    if (focus && loaded) document.getElementById(`harness-${focus}`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [focus, loaded]);

  const run = async (id: string, call: () => Promise<ExtensionsView & { error?: string }>) => {
    setBusy(id);
    setError(null);
    const r = await call().catch((e: unknown) => ({ error: String(e) }) as ExtensionsView & { error?: string });
    setBusy(null);
    if (r.error) return setError(r.error);
    setExt(r);
    onChanged();
  };

  const refresh = async () => {
    setRefreshing(true);
    const before = ext?.environment?.programs;
    const label = (id: string) => ext?.harnesses.find((h) => h.id === id)?.label ?? id;
    try {
      const r = await api.environment(true);
      if (r.error) {
        toast.error(t("detect.failed"), { description: r.error });
        return;
      }
      await load();
      onChanged();
      const description = detectionSummary(i18n, before, r.programs, label);
      if (r.shell.ok) toast.success(t("detect.done"), { description });
      else toast.warning(t("detect.doneShellSilent"), { description: t("detect.summaryShellSilent", { summary: description }) });
    } catch (e) {
      toast.error(t("detect.failed"), { description: String(e) });
    } finally {
      setRefreshing(false);
    }
  };

  const harnesses = ext?.harnesses ?? [];
  const env = ext?.environment ?? null;
  const jobOf = (id: string) => ext?.jobs.find((j) => j.id === id);
  // agents whose harness Roster no longer has have no card to sit in
  const orphans = ext ? view.executors.filter((e) => !harnesses.some((h) => h.id === e.type)) : [];

  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="mx-auto max-w-2xl space-y-6 px-8 py-8">
        <div>
          <h2 className="text-lg font-semibold">{intro ? t("harnesses.introTitle") : t("settings.harness")}</h2>
          <p className="text-muted-foreground mt-1 text-sm leading-relaxed">{intro ? t("harnesses.intro") : t("harnesses.hint")}</p>
        </div>

        <EnvironmentCard env={env} refreshing={refreshing} onRefresh={() => void refresh()} harnesses={harnesses} />

        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <div className="space-y-2">
          {!ext &&
            [0, 1, 2].map((i) => (
              <div key={i} className="flex items-center gap-3 rounded-xl border px-4 py-3">
                <Skeleton className="size-11 rounded-[23%]" />
                <div className="flex-1 space-y-1.5">
                  <Skeleton className="h-3.5 w-1/3" />
                  <Skeleton className="h-3 w-3/4" />
                </div>
              </div>
            ))}
          {harnesses.map((h) => {
            const status = harnessStatus(t, h);
            const job = jobOf(h.id);
            const running = job?.state === "running" || busy === h.id;
            const needsProgram = h.state.needed && !h.state.usable && h.adapter !== "missing" && h.adapter !== "error";
            const needsAdapter = h.adapter === "missing" || h.adapter === "error";
            return (
              <Item
                key={h.id}
                id={`harness-${h.id}`}
                variant="outline"
                className={cn("scroll-my-4 items-start rounded-xl", h.id === focus && "border-foreground/40")}
              >
                <ItemMedia>
                  <HarnessTile type={h.id} brand={h.brand} size="lg" />
                </ItemMedia>
                <ItemContent className="gap-1.5">
                  <ItemTitle className="flex flex-wrap items-center gap-1.5">
                    {h.label}
                    {status && <StatusBadge tone={status.tone}>{status.text}</StatusBadge>}
                  </ItemTitle>
                  <ItemDescription className="leading-relaxed">{h.description}</ItemDescription>
                  {h.adapterError && <p className="text-destructive text-xs">{h.adapterError}</p>}
                  {needsProgram && h.program && (
                    <p className="text-muted-foreground text-xs">
                      {t.rich("harnesses.programMissing", { bin: <span className="font-mono">{h.program.bin}</span> })}
                    </p>
                  )}
                  {job && <JobLine job={job} />}
                </ItemContent>
                <ItemActions className="flex-col items-stretch gap-1.5">
                  {needsAdapter ? (
                    <Button size="sm" disabled={running || !h.extension} onClick={() => void run(h.id, () => api.installExtension(h.id))}>
                      {running ? <Loader className="animate-spin" /> : <Download />}
                      {t("harness.installAdapter")}
                    </Button>
                  ) : needsProgram ? (
                    <Button size="sm" disabled={running} onClick={() => void run(h.id, () => api.installExtension(h.id))}>
                      {running ? <Loader className="animate-spin" /> : <Download />}
                      {t("harness.download")}
                    </Button>
                  ) : (
                    <Button size="sm" variant="outline" onClick={() => onSelect({ kind: "harness", id: h.id })}>
                      {t("harnesses.setUp")}
                      <ChevronRight />
                    </Button>
                  )}
                </ItemActions>
              </Item>
            );
          })}
        </div>

        {orphans.length > 0 && (
          <div className="space-y-2">
            <div>
              <h3 className="text-sm font-medium">{t("harnesses.orphansTitle")}</h3>
              <p className="text-muted-foreground mt-0.5 text-xs leading-relaxed">{t("harnesses.orphansHint")}</p>
            </div>
            <div className="rounded-xl border p-1">
              {orphans.map((e) => (
                <button
                  key={e.id}
                  type="button"
                  onClick={() => onSelect({ kind: "agent", id: e.id })}
                  className={cn(ROW, "hover:bg-accent")}
                >
                  <ExecutorTile type={e.type} size="sm" />
                  <span className="min-w-0 flex-1 truncate text-sm">{e.name}</span>
                  <span className="text-muted-foreground shrink-0 font-mono text-[11px]">{e.type}</span>
                  <ChevronRight className="text-muted-foreground size-3.5 shrink-0" />
                </button>
              ))}
            </div>
          </div>
        )}

      </div>
    </ScrollArea>
  );
}

/** The harness's own sign-in on this machine: it belongs to the program, so every agent on the subscription shares it. */
function LoginCard({ type }: { type: string }) {
  const [login, setLogin] = useState<LoginState | "loading" | null>("loading");
  const [busy, setBusy] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const { t } = useI18n();

  const read = (fresh: boolean) => {
    setLogin("loading");
    void api.harnessLogin(type, fresh).then((r) => setLogin(r.error ? { state: "unknown", detail: r.error, methods: [] } : r));
  };
  useEffect(() => read(false), [type]);

  const state = login === "loading" || !login ? null : login;
  const tone = state?.state === "ok" ? "ok" : state?.state === "none" ? "warn" : "quiet";
  return (
    <div className="rounded-xl border">
      <div className="flex items-center justify-between gap-3 px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">{t("login.title")}</span>
          {state && (
            <StatusBadge tone={tone}>
              {state.state === "ok"
                ? state.account
                  ? t("login.signedInAs", { account: state.account })
                  : t("login.signedIn")
                : state.state === "none"
                  ? t("common.notSignedIn")
                  : t("login.unknown")}
            </StatusBadge>
          )}
        </div>
        <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={() => read(true)} disabled={login === "loading"}>
          <RefreshCw className={cn("size-3.5", login === "loading" && "animate-spin")} />
          {t("common.refresh")}
        </Button>
      </div>
      <Separator />
      <div className="space-y-3 px-4 py-3 text-sm">
        {login === "loading" ? (
          <div className="space-y-1.5">
            <Skeleton className="h-3.5 w-1/2" />
            <Skeleton className="h-3.5 w-1/3" />
          </div>
        ) : (
          <>
            {state?.detail && <p className="text-muted-foreground text-xs">{state.detail}</p>}
            {state?.state === "ok" && <p className="text-muted-foreground text-xs">{t("login.credentials")}</p>}
            {state?.methods.map((m) => (
              <div key={m.id} className="space-y-1">
                <div className="text-xs font-medium">{m.label}</div>
                {m.description && <p className="text-muted-foreground text-xs">{m.description}</p>}
                {m.terminal ? (
                  <div className="flex items-center gap-1.5">
                    <code className="bg-muted min-w-0 flex-1 truncate rounded-md px-2 py-1 font-mono text-xs">
                      {[m.terminal.command, ...m.terminal.args].join(" ")}
                    </code>
                    <Button
                      variant="outline"
                      size="icon-sm"
                      title={t("login.copyCommand")}
                      onClick={() => {
                        void navigator.clipboard.writeText([m.terminal!.command, ...m.terminal!.args].join(" ")).then(() => {
                          setCopied(true);
                          setTimeout(() => setCopied(false), 1500);
                        });
                      }}
                    >
                      {copied ? <Check className="text-emerald-600" /> : <Copy />}
                    </Button>
                  </div>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy === m.id}
                    onClick={() => {
                      setBusy(m.id);
                      void api.authenticate(type, m.id).then((r) => {
                        setBusy(null);
                        setLogin(r.error ? { state: "unknown", detail: r.error, methods: state?.methods ?? [] } : r);
                      });
                    }}
                  >
                    {busy === m.id ? <Loader className="animate-spin" /> : <KeyRound />}
                    {t("login.signIn")}
                  </Button>
                )}
              </div>
            ))}
            {state?.methods.some((m) => m.terminal) && <p className="text-muted-foreground text-xs">{t("login.terminalHint")}</p>}
          </>
        )}
      </div>
    </div>
  );
}

function CapabilitiesOf({ type }: { type: HarnessTypeInfo }) {
  const { t } = useI18n();
  const own = type.capabilities.own;
  const endpoint = type.capabilities.endpoint;
  // two tabs saying the same thing would suggest a difference that is not there
  if (own && endpoint && JSON.stringify(own) !== JSON.stringify(endpoint)) {
    return (
      <Tabs defaultValue="own">
        <TabsList>
          <TabsTrigger value="own">{t("harness.onSubscription")}</TabsTrigger>
          <TabsTrigger value="endpoint">{t("harness.onModelApi")}</TabsTrigger>
        </TabsList>
        <TabsContent value="own" className="rounded-lg border px-3 py-2.5">
          <CapabilityNotes caps={own} />
        </TabsContent>
        <TabsContent value="endpoint" className="rounded-lg border px-3 py-2.5">
          <CapabilityNotes caps={endpoint} />
        </TabsContent>
      </Tabs>
    );
  }
  const caps = own ?? endpoint;
  if (!caps) return null;
  return (
    <div className="rounded-lg border px-3 py-2.5">
      <CapabilityNotes caps={caps} />
    </div>
  );
}

/** What a person calls an agent's source. */
function sourceName(t: Translate, view: ExecutorSettings, e: Pick<ExecutorRecord, "source_kind" | "provider_id">): string {
  return e.source_kind === "own" ? t("source.own") : (view.providers.find((p) => p.id === e.provider_id)?.name ?? t("source.deleted"));
}

/**
 * One harness: its type and its program on this machine. It holds no agent of
 * its own. What is set here -- the program, the sign-in -- is the harness's, so
 * every agent on it shares it.
 */
export function HarnessPanel({
  id,
  view,
  ext,
  onSaved,
  onChanged,
  onCancel,
  onSelect,
}: {
  id: string;
  view: ExecutorSettings;
  ext: ExtensionsView | null;
  onSaved: () => void;
  /** the harness's program was fetched or removed */
  onChanged: () => void;
  onCancel: () => void;
  onSelect: (s: SettingsSelection) => void;
}) {
  const { t, list } = useI18n();
  const harness = ext?.harnesses.find((h) => h.id === id);
  const info = view.types.find((type) => type.type === id);
  const label = harness?.label ?? info?.label ?? id;
  const saved = view.programs[id] ?? "";
  const [program, setProgram] = useState(saved);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState(false);

  useEffect(() => setProgram(saved), [saved]);

  const job = ext?.jobs.find((j) => j.id === id);
  const acting = busy || job?.state === "running";
  const needsAdapter = harness?.adapter === "missing" || harness?.adapter === "error";
  // a program picked by hand is taken at its word
  const needsProgram = Boolean(harness?.state.needed && !harness.state.usable && !needsAdapter && !saved);
  // only a program Roster fetched is Roster's to fetch again or remove
  const fetched = Boolean(harness?.state.installed && !harness.state.detected);
  const found = ext?.environment?.programs.find((p) => p.id === id);
  const agents = view.executors.filter((e) => e.type === id);
  const status = harness ? harnessStatus(t, harness) : null;
  const versionSuffix = (version: string | null | undefined) => (version ? t("harness.versionSuffix", { version }) : "");

  const save = async () => {
    setBusy(true);
    setError(null);
    const r = await api.setProgram(id, program.trim());
    setBusy(false);
    if (r.error) return setError(r.error);
    onSaved();
  };

  const run = async (call: () => Promise<ExtensionsView & { error?: string }>) => {
    setBusy(true);
    setError(null);
    const r = await call().catch((e: unknown) => ({ error: String(e) }) as ExtensionsView & { error?: string });
    setBusy(false);
    if (r.error) return setError(r.error);
    onChanged();
  };

  return (
    <EditorFrame error={error} busy={busy} canSave={program.trim() !== saved} saveLabel={t("common.save")} onSave={() => void save()} onCancel={onCancel}>
      <div className="space-y-4">
        <div className="flex items-start gap-4">
          <HarnessTile type={id} brand={harness?.brand} size="lg" />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <h2 className="truncate text-lg leading-snug font-semibold">{label}</h2>
              {status && <StatusBadge tone={status.tone}>{status.text}</StatusBadge>}
            </div>
            {harness?.description && <p className="text-muted-foreground mt-1 text-sm leading-relaxed">{harness.description}</p>}
            {harness?.adapterError && <p className="text-destructive mt-1 text-xs">{harness.adapterError}</p>}
          </div>
        </div>
        {(needsAdapter || needsProgram) && (
          <Alert>
            <Download />
            <AlertTitle>
              {needsAdapter
                ? t("harness.adapterMissingTitle")
                : harness?.program?.bin
                  ? t("harness.programMissingTitle", { bin: harness.program.bin })
                  : t("harness.programMissingTitleUnnamed")}
            </AlertTitle>
            <AlertDescription>
              <p>{needsAdapter ? t("harness.adapterMissingBody") : t("harness.programMissingBody")}</p>
              <Button
                size="sm"
                className="mt-2"
                disabled={acting || (needsAdapter && !harness?.extension)}
                onClick={() => void run(() => api.installExtension(id))}
              >
                {acting ? <Loader className="animate-spin" /> : <Download />}
                {needsAdapter ? t("harness.installAdapter") : t("harness.download")}
              </Button>
            </AlertDescription>
          </Alert>
        )}
        {job && <JobLine job={job} />}
      </div>

      {harness?.state.needed && (
        <Field>
          <FieldLabel htmlFor="harness-program">{t("harness.program")}</FieldLabel>
          <Input
            id="harness-program"
            value={program}
            onChange={(e) => setProgram(e.target.value)}
            placeholder={
              harness.state.path
                ? t("harness.programEmptyUses", { path: harness.state.path })
                : t("harness.programFullPath", { bin: harness.program?.bin ?? t("harness.program") })
            }
            spellCheck={false}
            className="font-mono text-xs"
          />
          <FieldDescription>
            {harness.state.path
              ? found
                ? t("harness.programHintFound", { version: versionSuffix(found.version) })
                : t("harness.programHintInstalled")
              : t("harness.programHintMissing")}
          </FieldDescription>
        </Field>
      )}

      {fetched && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-muted-foreground mr-auto text-xs">
            {t("harness.fetched", { version: versionSuffix(harness?.state.installed?.version) })}
          </span>
          <Button size="sm" variant="outline" disabled={acting} onClick={() => void run(() => api.updateExtension(id))}>
            {acting ? <Loader className="animate-spin" /> : <RefreshCw />}
            {t("harness.downloadAgain")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="text-muted-foreground hover:text-destructive"
            disabled={acting}
            onClick={() => setRemoving(true)}
          >
            <Trash2 />
            {t("harness.uninstall")}
          </Button>
        </div>
      )}

      {info?.sources.own && <LoginCard type={id} />}

      {info && (
        <Field>
          <FieldLabel>{t("harness.capabilities")}</FieldLabel>
          <CapabilitiesOf type={info} />
          {info.sources.apis.length > 0 && (
            <FieldDescription>{t("harness.protocols", { protocols: list(info.sources.apis.map((a) => apiLabel(t, a))) })}</FieldDescription>
          )}
        </Field>
      )}

      <Field>
        <div className="flex items-center justify-between gap-3">
          <FieldLabel>{t("harness.agents")}</FieldLabel>
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground -mr-2"
            disabled={!info}
            onClick={() => onSelect({ kind: "agent", id: null, type: id })}
          >
            <Plus />
            {t("agent.new")}
          </Button>
        </div>
        {agents.length > 0 ? (
          <div className="rounded-xl border p-1">
            {agents.map((e) => (
              <button key={e.id} type="button" onClick={() => onSelect({ kind: "agent", id: e.id })} className={cn(ROW, "hover:bg-accent")}>
                <span className="min-w-0 flex-1 truncate text-sm">{e.name}</span>
                <span className="text-muted-foreground shrink-0 text-xs">{sourceName(t, view, e)}</span>
                <ChevronRight className="text-muted-foreground size-3.5 shrink-0" />
              </button>
            ))}
          </div>
        ) : (
          <p className="text-muted-foreground text-sm">{info?.sources.own ? t("harness.noAgentsOwn") : t("harness.noAgents")}</p>
        )}
      </Field>

      <AlertDialog open={removing} onOpenChange={setRemoving}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("harness.uninstallTitle", { name: label })}</AlertDialogTitle>
            <AlertDialogDescription>{t("harness.uninstallBody")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                setRemoving(false);
                void run(() => api.removeExtension(id));
              }}
            >
              {t("harness.uninstall")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </EditorFrame>
  );
}

/** A select value for "no model named": the agent runs whatever its harness defaults to. */
const HARNESS_DEFAULT = "@default";

/**
 * One agent: a harness and where its models come from, fixed together. The
 * harness is picked once; the source can change later, and members already
 * running on the agent are told to sync.
 */
export function AgentEditor({
  view,
  executor,
  type: preset,
  ext,
  bots,
  onSaved,
  onCancel,
  onDeleted,
  onSelect,
}: {
  view: ExecutorSettings;
  executor: ExecutorRecord | null;
  /** the harness a new one starts on, when it was opened from that harness's page */
  type?: string | undefined;
  ext: ExtensionsView | null;
  bots: readonly Bot[];
  onSaved: (e: ExecutorRecord) => void;
  onCancel: () => void;
  onDeleted: () => void;
  onSelect: (s: SettingsSelection) => void;
}) {
  const { t } = useI18n();
  const creating = executor === null;
  /** where a new agent on this harness starts: its own sign-in while nobody has it, else the first model API that fits */
  const startFor = (harnessType: string): { kind: SourceKind; providerId: string | null } => {
    const ti = view.types.find((x) => x.type === harnessType);
    const ownFree = Boolean(ti?.sources.own) && !view.executors.some((e) => e.type === harnessType && e.source_kind === "own");
    const first = ti ? view.providers.find((p) => fits(ti, p, view)) : undefined;
    return ownFree ? { kind: "own", providerId: null } : { kind: "endpoint", providerId: first?.id ?? null };
  };
  const [type, setType] = useState(executor?.type ?? preset ?? view.types[0]?.type ?? "");
  // an old agent on a sign-in its harness does not have opens on a model API, so saving is the fix
  const stray = executor?.source_kind === "own" && view.types.find((x) => x.type === executor.type)?.sources.own === false;
  const [source, setSource] = useState<{ kind: SourceKind; providerId: string | null }>(() =>
    executor && !stray ? { kind: executor.source_kind, providerId: executor.provider_id } : startFor(executor?.type ?? preset ?? view.types[0]?.type ?? ""),
  );
  const [model, setModel] = useState(executor?.model ?? "");
  const [name, setName] = useState(executor?.name ?? "");
  const [models, setModels] = useState<ModelOption[] | "loading" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [check, setCheck] = useState<{ ok: boolean; items: CheckItem[] } | "running" | null>(null);
  const [confirming, setConfirming] = useState(false);

  const info = view.types.find((x) => x.type === type);
  const harness = ext?.harnesses.find((h) => h.id === type);
  const label = info?.label ?? harness?.label ?? type;
  const fitting = info ? view.providers.filter((p) => fits(info, p, view)) : [];
  const ownTaken = view.executors.find((e) => e.type === type && e.source_kind === "own" && e.id !== executor?.id);
  const providerId = source.kind === "endpoint" ? source.providerId : null;
  const sourceLabel = source.kind === "own" ? t("source.own") : (view.providers.find((p) => p.id === providerId)?.name ?? t("source.endpoint"));
  const caps = info?.capabilities[source.kind];
  const users = executor ? bots.filter((b) => !b.archived_at && b.executor_id === executor.id) : [];
  const canSave = Boolean(info) && (source.kind === "own" ? Boolean(info?.sources.own) && !ownTaken : Boolean(providerId));

  // what the source offers, to pick a default from; an own sign-in asks the agent itself, so it takes a moment
  const sourceKey = `${type}|${source.kind}|${providerId ?? ""}`;
  useEffect(() => {
    if (!info || (source.kind === "endpoint" && !providerId)) {
      setModels(null);
      return;
    }
    let live = true;
    setModels("loading");
    void api
      .harnessModels(type, providerId)
      .then((r) => live && setModels(r.models ?? []))
      .catch(() => live && setModels([]));
    return () => {
      live = false;
    };
  }, [sourceKey]);

  const chooseHarness = (harnessType: string) => {
    setType(harnessType);
    setSource(startFor(harnessType));
    setModel("");
  };

  const chooseKind = (kind: SourceKind) => {
    setModel("");
    setSource(kind === "own" ? { kind, providerId: null } : { kind, providerId: fitting.some((p) => p.id === providerId) ? providerId : (fitting[0]?.id ?? null) });
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    const body = {
      name: name.trim() || null,
      source_kind: source.kind,
      provider_id: providerId,
      model: model.trim() || null,
      ...(creating ? { type } : {}),
    };
    const r = creating ? await api.createExecutor(body) : await api.updateExecutor(executor.id, body);
    setBusy(false);
    if (r.error || !r.executor) return setError(r.error ?? t("common.saveFailed"));
    setCheck(null);
    // core may have named it after its new source
    setName(r.executor.name);
    onSaved(r.executor);
  };

  const test = async () => {
    if (!executor) return;
    setCheck("running");
    const r = await api.checkExecutor(executor.id).catch((e: unknown) => ({ ok: false, items: [], error: String(e) }));
    setCheck(r.error ? { ok: false, items: [{ label: t("check.label"), ok: false, detail: r.error }] } : r);
  };

  return (
    <EditorFrame
      title={creating ? t("agent.new") : undefined}
      description={creating ? t("agent.newDescription") : undefined}
      error={error}
      busy={busy}
      canSave={canSave}
      saveLabel={creating ? t("common.create") : t("common.save")}
      onSave={() => void save()}
      onCancel={onCancel}
      {...(creating ? {} : { onDelete: () => setConfirming(true) })}
    >
      {executor && (
        <div className="flex items-start gap-4">
          <ExecutorTile type={executor.type} brand={harness?.brand} size="lg" />
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-lg leading-snug font-semibold">{executor.name}</h2>
            <p className="text-muted-foreground truncate text-sm">
              {label} · {sourceName(t, view, executor)}
            </p>
          </div>
        </div>
      )}

      {executor?.problem && (
        <Alert>
          <AlertTitle>{t("agent.unusable")}</AlertTitle>
          <AlertDescription>
            {executor.problem}
            {!info && (
              <Button variant="link" size="xs" className="h-auto p-0" onClick={() => onSelect({ kind: "harnesses", id: executor.type })}>
                {t("agent.installHarness")}
              </Button>
            )}
          </AlertDescription>
        </Alert>
      )}

      {creating && (
        <Field>
          <FieldLabel>{t("settings.harness")}</FieldLabel>
          {view.types.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              {t("agent.noHarnesses")}
              <Button variant="link" size="xs" className="h-auto p-0" onClick={() => onSelect({ kind: "harnesses" })}>
                {t("agent.installOne")}
              </Button>
            </p>
          ) : (
            <RadioGroup value={type} onValueChange={chooseHarness} className="grid gap-2 sm:grid-cols-2">
              {view.types.map((option) => {
                const h = ext?.harnesses.find((x) => x.id === option.type);
                const st = h ? harnessStatus(t, h) : null;
                return (
                  <Choice key={option.type} value={option.type} selected={type === option.type}>
                    <HarnessTile type={option.type} brand={h?.brand} size="sm" />
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">{option.label}</span>
                    {st && <StatusBadge tone={st.tone}>{st.text}</StatusBadge>}
                  </Choice>
                );
              })}
            </RadioGroup>
          )}
        </Field>
      )}

      {info && (
        <Field>
          <FieldLabel>{t("agent.source")}</FieldLabel>
          {info.sources.own && info.sources.apis.length > 0 ? (
            <RadioGroup value={source.kind} onValueChange={(v) => chooseKind(v as SourceKind)} className="grid gap-2 sm:grid-cols-2">
              <Choice value="own" selected={source.kind === "own"} disabled={Boolean(ownTaken)}>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium">{t("source.own")}</span>
                  <span className="text-muted-foreground block text-xs">
                    {ownTaken ? t("agent.ownTaken", { name: ownTaken.name }) : t("agent.ownAccount", { harness: label })}
                  </span>
                </span>
              </Choice>
              <Choice value="endpoint" selected={source.kind === "endpoint"}>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium">{t("source.endpoint")}</span>
                  <span className="text-muted-foreground block text-xs">{t("agent.endpointHint")}</span>
                </span>
              </Choice>
            </RadioGroup>
          ) : (
            <p className="text-muted-foreground text-sm">
              {info.sources.own
                ? ownTaken
                  ? t("agent.ownOnlyTaken", { harness: label, name: ownTaken.name })
                  : t("agent.ownOnly", { harness: label })
                : t("agent.endpointOnly", { harness: label })}
            </p>
          )}
          {source.kind === "endpoint" &&
            (fitting.length === 0 ? (
              <p className="text-muted-foreground text-xs">
                {t("agent.noFitting", { harness: label })}
                <Button variant="link" size="xs" className="h-auto p-0" onClick={() => onSelect({ kind: "provider", id: null })}>
                  {t("provider.add")}
                </Button>
              </p>
            ) : (
              <Select value={providerId ?? undefined} onValueChange={(id) => setSource({ kind: "endpoint", providerId: id })}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder={t("agent.pickProvider")} />
                </SelectTrigger>
                <SelectContent>
                  {fitting.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ))}
          {!creating && <FieldDescription>{t("agent.sourceChangeHint")}</FieldDescription>}
        </Field>
      )}

      {info && (
        <Field>
          <FieldLabel htmlFor="agent-model">{t("common.defaultModel")}</FieldLabel>
          {models === "loading" ? (
            <Skeleton className="h-9 w-full" />
          ) : models && models.length > 0 ? (
            <Select value={model || HARNESS_DEFAULT} onValueChange={(v) => setModel(v === HARNESS_DEFAULT ? "" : v)}>
              <SelectTrigger id="agent-model" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={HARNESS_DEFAULT}>{t("agent.harnessDefault", { harness: label })}</SelectItem>
                {model && !models.some((m) => m.id === model) && <SelectItem value={model}>{model}</SelectItem>}
                {models.map((m) => (
                  <SelectItem key={m.id} value={m.id} disabled={!m.available}>
                    {m.label ?? m.id}
                    {!m.available && (
                      <span className="text-muted-foreground">
                        {" · "}
                        {source.kind === "own" ? t("common.notSignedIn") : t("common.noKey")}
                      </span>
                    )}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <Input
              id="agent-model"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder={t("agent.modelPlaceholder")}
              spellCheck={false}
              className="font-mono text-xs"
            />
          )}
          <FieldDescription>{t("agent.modelHint")}</FieldDescription>
        </Field>
      )}

      <Field>
        <FieldLabel htmlFor="agent-name">{t("editor.name")}</FieldLabel>
        <Input id="agent-name" value={name} onChange={(e) => setName(e.target.value)} placeholder={`${label} · ${sourceLabel}`} />
        <FieldDescription>{t("agent.nameHint")}</FieldDescription>
      </Field>

      {executor && (
        <div className="space-y-2">
          <Button variant="outline" size="sm" onClick={() => void test()} disabled={check === "running"}>
            {t("check.test")}
          </Button>
          <p className="text-muted-foreground text-xs">{executor.source_kind === "own" ? t("agent.testHintOwn") : t("agent.testHintEndpoint")}</p>
          <CheckResult result={check} />
        </div>
      )}

      {caps && (
        <Field>
          <FieldLabel>{t("harness.capabilities")}</FieldLabel>
          <div className="rounded-lg border px-3 py-2.5">
            <CapabilityNotes caps={caps} />
          </div>
        </Field>
      )}

      {executor && (
        <Field>
          <FieldLabel>{t("agent.bots")}</FieldLabel>
          {users.length > 0 ? (
            <div className="flex flex-wrap gap-x-4 gap-y-2 rounded-xl border px-4 py-2.5 text-sm">
              {users.map((b) => (
                <span key={b.id} className="inline-flex items-center gap-1.5">
                  <BotAvatar bot={b} size="xs" />
                  {b.name}
                </span>
              ))}
            </div>
          ) : (
            <p className="text-muted-foreground text-sm">{t("agent.noBots")}</p>
          )}
        </Field>
      )}

      {executor && (
        <ConfirmDelete
          open={confirming}
          onOpenChange={setConfirming}
          title={t("common.deleteTitle", { name: executor.name })}
          description={t("agent.deleteBody")}
          onConfirm={() => {
            void api.deleteExecutor(executor.id).then((r) => (r.error ? setError(r.error) : onDeleted()));
          }}
        />
      )}
    </EditorFrame>
  );
}

/** models: the ids the endpoint listed during the check */
type CheckResultValue = { ok: boolean; detail: string; models?: string[] };

type Connection = CheckResultValue | "running" | null;

const CHECK_REUSE_MS = 5 * 60_000;

/** Recent checks by provider id, so flipping between pages does not ask the endpoint every time. */
const recentChecks = new Map<string, { rev: number; at: number; result: CheckResultValue }>();

const hostOf = (url: string | null | undefined): string => {
  try {
    return url ? new URL(url).host : "";
  } catch {
    return "";
  }
};

/**
 * The first step of adding one: where the models come from. A key this machine
 * already has goes on top, since it is the shortest way to something that works.
 */
function PresetPicker({
  presets,
  added,
  suggestions,
  onPick,
}: {
  presets: readonly ProviderPreset[];
  /** presets that already have a saved API; picking one again is allowed, just not by accident */
  added: ReadonlySet<string>;
  suggestions: readonly CredentialHint[];
  onPick: (preset: string, keyEnv?: string) => void;
}) {
  const [query, setQuery] = useState("");
  const { t } = useI18n();
  const q = query.trim().toLowerCase();
  const shown = q ? presets.filter((p) => `${p.id} ${p.label}`.toLowerCase().includes(q)) : presets;
  return (
    <>
      {suggestions.length > 0 && (
        <Field>
          <FieldLabel>{t("preset.foundKeys")}</FieldLabel>
          <div className="divide-y rounded-xl border">
            {suggestions.map((h) => {
              const p = presets.find((x) => x.id === h.preset);
              if (!p) return null;
              return (
                <div key={h.name} className="flex items-center gap-3 px-3 py-2.5">
                  <PresetTile preset={p} size="sm" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{p.label}</div>
                    <div className="text-muted-foreground truncate text-xs">
                      {t.rich("preset.readsEnv", { name: <span className="font-mono">{h.name}</span> })}
                    </div>
                  </div>
                  <Button size="sm" onClick={() => onPick(p.id, h.name)}>
                    {t("preset.addWithIt")}
                  </Button>
                </div>
              );
            })}
          </div>
        </Field>
      )}

      <Field>
        <FieldLabel htmlFor="preset-search">{t("preset.where")}</FieldLabel>
        <div className="flex gap-2">
          <div className="relative min-w-0 flex-1">
            <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2" />
            <Input
              id="preset-search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("preset.search", { count: presets.length })}
              autoComplete="off"
              spellCheck={false}
              className="pl-8"
            />
          </div>
          <Button variant="outline" onClick={() => onPick(CUSTOM_PRESET)}>
            <KeyRound />
            {t("provider.custom")}
          </Button>
        </div>
        {shown.length === 0 ? (
          <p className="text-muted-foreground py-6 text-center text-sm">{t("preset.noMatches", { query: query.trim() })}</p>
        ) : (
          <div className="grid grid-cols-2 gap-2 @2xl:grid-cols-3">
            {shown.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => onPick(p.id)}
                className="hover:bg-accent/60 focus-visible:ring-ring/50 flex min-w-0 items-center gap-2.5 rounded-xl border px-3 py-2.5 text-left transition-colors outline-none focus-visible:ring-2"
              >
                <PresetTile preset={p} size="sm" />
                <span className="min-w-0">
                  {/* wraps instead of truncating: regional variants differ only in their last word */}
                  <span className="block text-sm leading-snug font-medium break-words">{p.label}</span>
                  <span className="text-muted-foreground block truncate text-xs">
                    {apiShort(t, p.api)}
                    {added.has(p.id) && t("preset.added")}
                  </span>
                </span>
              </button>
            ))}
          </div>
        )}
      </Field>
    </>
  );
}

/** Whether the saved setup answers: the one question this page exists to settle. */
function ConnectionLine({
  state,
  host,
  dirty,
  onTest,
}: {
  state: Connection;
  host: string;
  dirty: boolean;
  onTest: () => void;
}) {
  const { t } = useI18n();
  const running = state === "running";
  const result = dirty || running ? null : state;
  return (
    // top-aligned with the text padded to the button's height, so a long error keeps its dot on the first line
    <div className="flex items-start gap-3 rounded-xl border px-4 py-2.5">
      <span className="mt-[9px] flex size-3.5 shrink-0 items-center justify-center">
        {running ? (
          <Loader className="text-muted-foreground size-3.5 animate-spin" />
        ) : (
          <span
            className={cn("size-2 rounded-full", result ? (result.ok ? "bg-emerald-500" : "bg-destructive") : "bg-muted-foreground/30")}
          />
        )}
      </span>
      <span className={cn("min-w-0 flex-1 py-1.5 text-sm", !result ? "text-muted-foreground" : !result.ok && "text-destructive")}>
        {running
          ? host
            ? t("connection.connectingTo", { host })
            : t("connection.connecting")
          : dirty
            ? t("connection.unsaved")
            : result
              ? result.detail
              : t("connection.untested")}
      </span>
      <Button variant="outline" size="sm" onClick={onTest} disabled={running || dirty}>
        <RefreshCw />
        {t("check.test")}
      </Button>
    </div>
  );
}

/** Which harnesses can take their models from here, and which agents already do. */
function UsedBy({ types, executors }: { types: readonly HarnessTypeInfo[]; executors: readonly ExecutorRecord[] | null }) {
  const { t } = useI18n();
  return (
    <Field>
      <FieldLabel>{t("provider.usedBy")}</FieldLabel>
      <dl className="divide-y rounded-xl border text-sm">
        <div className="flex items-center gap-3 px-4 py-2.5">
          <dt className="text-muted-foreground w-24 shrink-0 text-xs">{t("provider.harnesses")}</dt>
          <dd className="flex min-w-0 flex-1 flex-wrap gap-x-4 gap-y-1.5">
            {types.length > 0 ? (
              types.map((type) => (
                <span key={type.type} className="inline-flex items-center gap-1.5">
                  <ExecutorTile type={type.type} size="xs" />
                  {type.label}
                </span>
              ))
            ) : (
              <span className="text-muted-foreground">{t("provider.noHarnesses")}</span>
            )}
          </dd>
        </div>
        {executors && (
          <div className="flex items-center gap-3 px-4 py-2.5">
            <dt className="text-muted-foreground w-24 shrink-0 text-xs">{t("provider.agents")}</dt>
            <dd className="flex min-w-0 flex-1 flex-wrap gap-x-4 gap-y-1.5">
              {executors.length > 0 ? (
                executors.map((e) => (
                  <span key={e.id} className="inline-flex items-center gap-1.5">
                    <ExecutorTile type={e.type} size="xs" />
                    {e.name}
                  </span>
                ))
              ) : (
                <span className="text-muted-foreground">{t("provider.noAgents")}</span>
              )}
            </dd>
          </div>
        )}
      </dl>
    </Field>
  );
}

/**
 * What a preset endpoint serves: the ids its API listed, and nothing said about
 * them that the API did not say. Null until there is a saved key to ask with.
 */
function ListedModels({ models, connection }: { models: readonly string[] | null; connection: Connection }) {
  const [query, setQuery] = useState("");
  const { t } = useI18n();
  const q = query.trim().toLowerCase();
  const shown = (models ?? []).filter((m) => !q || m.toLowerCase().includes(q));
  const settled = connection !== null && connection !== "running" ? connection : null;
  return (
    <Field>
      <div className="flex items-center justify-between gap-3">
        <FieldLabel>{t("editor.model")}</FieldLabel>
        {models && models.length > 8 && (
          <div className="relative w-48">
            <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("models.search", { count: models.length })}
              aria-label={t("models.searchLabel")}
              autoComplete="off"
              spellCheck={false}
              className="h-8 pl-8 text-xs"
            />
          </div>
        )}
      </div>
      {models === null ? (
        <p className="text-muted-foreground text-sm">{t("models.beforeAdd")}</p>
      ) : models.length > 0 ? (
        <div className="max-h-96 overflow-y-auto rounded-xl border">
          {shown.length === 0 ? (
            <p className="text-muted-foreground px-4 py-6 text-center text-sm">{t("models.noMatches", { query: query.trim() })}</p>
          ) : (
            <ul className="divide-y">
              {shown.map((m) => (
                <li key={m} title={m} className="truncate px-4 py-2 font-mono text-xs">
                  {m}
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : !settled ? (
        <div className="space-y-2 rounded-xl border px-4 py-3">
          <Skeleton className="h-3.5 w-1/3" />
          <Skeleton className="h-3.5 w-1/2" />
        </div>
      ) : (
        <p className="text-muted-foreground text-sm">
          {!settled.ok ? t("models.afterConnect") : settled.models ? t("models.emptyList") : t("models.noList")}
        </p>
      )}
      {models && models.length > 0 && <FieldDescription>{t("models.hint")}</FieldDescription>}
    </Field>
  );
}

export function ProviderEditor({
  view,
  provider,
  env,
  onSaved,
  onCancel,
  onDeleted,
}: {
  view: ExecutorSettings;
  provider: ProviderRecord | null;
  env: Environment | null;
  onSaved: (p: ProviderRecord) => void;
  onCancel: () => void;
  onDeleted: () => void;
}) {
  const { t } = useI18n();
  const creating = provider === null;
  const presets = useMemo(() => presetsOf(view), [view]);
  // what was last saved; the settings list it comes from reloads a moment after a save
  const [record, setRecord] = useState(provider);
  const [preset, setPreset] = useState(provider?.preset ?? "");
  const [name, setName] = useState(provider?.name ?? "");
  const [apiId, setApiId] = useState(provider?.api ?? "openai-completions");
  const [baseUrl, setBaseUrl] = useState(provider?.base_url ?? "");
  const [models, setModels] = useState((provider?.models ?? []).join("\n"));
  const [keySource, setKeySource] = useState<"stored" | "env">(provider?.key.source ?? "stored");
  const [key, setKey] = useState("");
  const [keyEnv, setKeyEnv] = useState(provider?.key_env ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [connection, setConnection] = useState<Connection>(null);
  const [probe, setProbe] = useState<ModelProbe | "running" | null>(null);
  const [confirming, setConfirming] = useState(false);
  // the ids the endpoint listed in the last check that got a list; kept through a re-test
  const [listed, setListed] = useState<string[] | null>(null);
  const testedOnOpen = useRef(false);

  const custom = preset === CUSTOM_PRESET;
  const chosen = presets.find((p) => p.id === preset);
  const modelList = models
    .split(/[\n,]/)
    .map((m) => m.trim())
    .filter(Boolean);
  // which agents could use it, as the form stands
  const usable = view.types.filter((type) =>
    custom ? type.sources.apis.includes(apiId) : (view.presets[type.type] ?? []).some((p) => p.id === preset),
  );
  const envHints = (env?.hints ?? []).filter((h) => h.kind === "env");
  // a vendor already added is no suggestion, whatever its key
  const suggestions = envHints.filter(
    (h) => presets.some((p) => p.id === h.preset) && !view.providers.some((p) => p.preset === h.preset),
  );
  const presetHint = custom ? undefined : envHints.find((h) => h.preset === preset);
  const storedKey = record?.key.source === "stored" && record.key.set;
  const hasKey = keySource === "env" ? keyEnv.trim() !== "" : key.trim() !== "" || storedKey;
  const dirty =
    record !== null &&
    (name.trim() !== record.name ||
      keySource !== record.key.source ||
      (keySource === "stored" ? key.trim() !== "" : keyEnv.trim() !== (record.key_env ?? "")) ||
      (custom &&
        (apiId !== record.api || baseUrl.trim() !== (record.base_url ?? "") || modelList.join("\n") !== record.models.join("\n"))));

  const settle = (result: CheckResultValue) => {
    setConnection(result);
    setListed(result.ok && result.models ? result.models : null);
  };

  const test = async (p: Pick<ProviderRecord, "id" | "rev">) => {
    setConnection("running");
    const r = await api
      .checkProvider(p.id)
      .catch((e: unknown) => ({ ok: false, detail: String(e), models: undefined, error: String(e) }));
    const result: CheckResultValue = { ok: !r.error && r.ok, detail: r.error ?? r.detail, ...(r.models ? { models: r.models } : {}) };
    recentChecks.set(p.id, { rev: p.rev, at: Date.now(), result });
    settle(result);
  };

  // opening the page answers whether it works and what the key lists, reusing a recent answer for the same setup
  useEffect(() => {
    if (!provider || testedOnOpen.current) return;
    testedOnOpen.current = true;
    const recent = recentChecks.get(provider.id);
    if (recent && recent.rev === provider.rev && Date.now() - recent.at < CHECK_REUSE_MS) settle(recent.result);
    else void test(provider);
  }, [provider]);

  const save = async () => {
    setBusy(true);
    setError(null);
    const body = {
      name: name.trim() || chosen?.label || t("provider.custom"),
      preset,
      ...(custom ? { api: apiId, base_url: baseUrl.trim(), models: modelList } : {}),
      key_env: keySource === "env" ? keyEnv.trim() : null,
      // an empty box leaves a saved key alone; switching to env clears it on the server
      ...(keySource === "stored" && key.trim() ? { key: key.trim() } : {}),
    };
    const r = creating ? await api.createProvider(body) : await api.updateProvider(provider.id, body);
    setBusy(false);
    if (r.error || !r.provider) return setError(r.error ?? t("common.saveFailed"));
    setKey("");
    setName(r.provider.name);
    setRecord(r.provider);
    onSaved(r.provider);
    // a new one is tested when its own page opens
    if (!creating) void test(r.provider);
  };

  // an empty key box means "use what's saved" when editing; probing then falls back to it server-side
  const fetchModelList = async () => {
    setProbe("running");
    const r = await api
      .probeModels({ api: apiId, base_url: baseUrl.trim(), key: key.trim() || undefined, provider_id: record?.id })
      .catch((e: unknown) => ({ ok: false, models: undefined, detail: String(e), error: String(e) }) as ModelProbe & { error?: string });
    setProbe({ ok: r.ok, detail: r.error ?? r.detail });
    if (r.ok && r.models?.length) {
      setModels([...modelList, ...r.models.filter((m) => !modelList.includes(m))].join("\n"));
    }
  };

  if (creating && !preset) {
    return (
      <EditorFrame
        title={t("provider.add")}
        description={t("provider.addDescription")}
        error={error}
        busy={busy}
        canSave={false}
        saveLabel={t("common.add")}
        onSave={() => {}}
        onCancel={onCancel}
      >
        <PresetPicker
          presets={presets}
          added={new Set(view.providers.map((p) => p.preset))}
          suggestions={suggestions}
          onPick={(id, envName) => {
            setPreset(id);
            if (envName) {
              setKeySource("env");
              setKeyEnv(envName);
            } else if (envHints.some((h) => h.name === keyEnv.trim() && h.preset !== id)) {
              // a variable picked for the vendor before this one would not work here
              setKeySource("stored");
              setKeyEnv("");
            }
          }}
        />
      </EditorFrame>
    );
  }

  const host = hostOf(custom ? baseUrl.trim() : chosen?.baseUrl);
  const customName = t("provider.custom");
  const title = record?.name ?? (custom ? name.trim() || customName : (chosen?.label ?? preset));
  const subtitle = custom
    ? title === customName
      ? null
      : customName
    : !chosen
      ? t("provider.presetGone")
      : chosen.label === title
        ? null
        : chosen.label;
  const facts = [
    apiShort(t, custom ? apiId : chosen?.api),
    custom && modelList.length > 0 ? t("provider.modelCount", { count: modelList.length }) : "",
    host,
  ].filter(Boolean);
  const Heading = creating ? "h3" : "h2";
  const users = record ? view.executors.filter((e) => e.provider_id === record.id) : null;
  // what the last check listed, else what was saved from an earlier one, which the settings reload after a check carries
  const presetModels = record ? (listed ?? provider?.models ?? record.models) : null;

  return (
    <EditorFrame
      title={creating ? t("provider.add") : undefined}
      error={error}
      busy={busy}
      canSave={custom ? baseUrl.trim() !== "" && modelList.length > 0 : Boolean(chosen) && Boolean(hasKey)}
      saveLabel={creating ? t("common.add") : t("common.save")}
      onSave={() => void save()}
      onCancel={onCancel}
      {...(record ? { onDelete: () => setConfirming(true) } : {})}
    >
      <div className="space-y-4">
        <div className="flex items-start gap-4">
          {record ? (
            <ProviderTile provider={record} size="lg" />
          ) : chosen ? (
            <PresetTile preset={chosen} size="lg" />
          ) : (
            <Mark brand={brandFromText(`${name} ${baseUrl}`)} fallback={<KeyRound />} size="lg" />
          )}
          <div className="min-w-0 flex-1">
            <Heading className="truncate text-lg leading-snug font-semibold">{title}</Heading>
            {subtitle && <p className="text-muted-foreground truncate text-sm">{subtitle}</p>}
            {facts.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {facts.map((f, i) => (
                  <Badge key={i} variant="outline" className="max-w-full font-normal">
                    <span className="truncate">{f}</span>
                  </Badge>
                ))}
              </div>
            )}
          </div>
          {creating && (
            <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={() => setPreset("")}>
              {t("provider.change")}
            </Button>
          )}
        </div>
        {record && <ConnectionLine state={connection} host={host} dirty={dirty} onTest={() => void test(record)} />}
      </div>

      {!custom && <ListedModels models={presetModels} connection={connection} />}

      {custom && (
        <>
          <Field>
            <FieldLabel>{t("provider.protocol")}</FieldLabel>
            <ToggleGroup type="single" value={apiId} onValueChange={(v) => v && setApiId(v)} className="flex-wrap justify-start gap-1.5">
              {CUSTOM_APIS.map((id) => (
                <ToggleGroupItem
                  key={id}
                  value={id}
                  variant="outline"
                  size="sm"
                  className="data-[state=on]:border-foreground/40 gap-1.5 rounded-lg px-2.5 first:rounded-lg last:rounded-lg"
                >
                  <ProviderIcon provider={API_BRAND[id] ?? "unknown"} className="size-3.5" />
                  {apiLabel(t, id)}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </Field>
          <Field>
            <FieldLabel htmlFor="provider-url">{t("provider.address")}</FieldLabel>
            <Input
              id="provider-url"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://"
              spellCheck={false}
              className="font-mono text-xs"
            />
            <FieldDescription>
              {apiId === "anthropic-messages" ? t("provider.addressAnthropic") : t("provider.addressOpenAI")}
            </FieldDescription>
          </Field>
        </>
      )}

      <Field>
        <div className="flex items-center justify-between gap-3">
          <FieldLabel htmlFor="provider-key">{t("provider.key")}</FieldLabel>
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            value={keySource}
            onValueChange={(v) => v && setKeySource(v as "stored" | "env")}
          >
            <ToggleGroupItem value="stored" className="px-2.5 text-xs">
              {t("provider.keyStored")}
            </ToggleGroupItem>
            <ToggleGroupItem value="env" className="px-2.5 text-xs">
              {t("provider.keyEnv")}
            </ToggleGroupItem>
          </ToggleGroup>
        </div>
        {keySource === "stored" ? (
          <Input
            id="provider-key"
            type="password"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            placeholder={storedKey ? t("provider.keySaved", { hint: record?.key.hint ?? "" }) : (chosen?.keyLabel ?? "API key")}
            className="font-mono text-xs"
          />
        ) : (
          <Input
            id="provider-key"
            value={keyEnv}
            onChange={(e) => setKeyEnv(e.target.value)}
            placeholder={
              presetHint?.name ??
              t("common.example", { example: custom ? "MY_GATEWAY_KEY" : `${preset.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_API_KEY` })
            }
            spellCheck={false}
            className="font-mono text-xs"
          />
        )}
        {presetHint && !(keySource === "env" && keyEnv.trim() === presetHint.name) && (
          <div className="text-muted-foreground flex items-center gap-1.5 text-xs">
            <ScanSearch className="size-3.5" />
            {t.rich("provider.envFound", { name: <span className="text-foreground font-mono">{presetHint.name}</span> })}
            <Button
              type="button"
              variant="link"
              size="xs"
              className="h-auto p-0"
              onClick={() => {
                setKeySource("env");
                setKeyEnv(presetHint.name);
              }}
            >
              {t("provider.useEnv")}
            </Button>
          </div>
        )}
        <FieldDescription>
          {keySource === "stored"
            ? view.vault.encrypted
              ? t("provider.keyStoredEncrypted")
              : t("provider.keyStoredPlain")
            : t("provider.keyEnvHint")}
        </FieldDescription>
      </Field>

      {custom && (
        <Field>
          <div className="flex items-center justify-between">
            <FieldLabel htmlFor="provider-models">{t("editor.model")}</FieldLabel>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-muted-foreground -mr-2"
              onClick={() => void fetchModelList()}
              disabled={probe === "running" || baseUrl.trim() === ""}
            >
              {probe === "running" ? <Loader className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
              {t("provider.fetchModels")}
            </Button>
          </div>
          {probe && probe !== "running" && (
            <span className={cn("text-xs", probe.ok ? "text-muted-foreground" : "text-destructive")}>{probe.detail}</span>
          )}
          <Textarea
            id="provider-models"
            value={models}
            onChange={(e) => setModels(e.target.value)}
            placeholder={"gpt-4o\ngpt-4o-mini"}
            spellCheck={false}
            className="min-h-24 font-mono text-xs"
          />
          <FieldDescription>{t("provider.modelsHint")}</FieldDescription>
        </Field>
      )}

      <Field>
        <FieldLabel htmlFor="provider-name">{t("editor.name")}</FieldLabel>
        <Input id="provider-name" value={name} onChange={(e) => setName(e.target.value)} placeholder={chosen?.label ?? t("provider.namePlaceholder")} />
      </Field>

      <UsedBy types={usable} executors={users} />

      {record && (
        <ConfirmDelete
          open={confirming}
          onOpenChange={setConfirming}
          title={t("common.deleteTitle", { name: record.name })}
          description={t("provider.deleteBody")}
          onConfirm={() => {
            void api.deleteProvider(record.id).then((r) => (r.error ? setError(r.error) : onDeleted()));
          }}
        />
      )}
    </EditorFrame>
  );
}
