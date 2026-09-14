import { useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  ChevronRight,
  Copy,
  Download,
  Info,
  KeyRound,
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
import { OWN_SOURCE_LABEL } from "./executors";
import { LIST_BODY, ROW, rowState, SectionLabel } from "./list";
import { ProviderIcon } from "./provider-icon";
import { THEME_LABELS, type Theme } from "./theme";
import { fontLabel, sizeLabel, type Typography } from "./typography";
import {
  API_BRAND,
  API_LABEL,
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
  | { kind: "about" }
  /** every harness Roster knows, to fetch more; an id scrolls to that harness's card */
  | { kind: "harnesses"; id?: string }
  | { kind: "harness"; id: string }
  /** null creates one, on the given harness when it was opened from that harness's page */
  | { kind: "agent"; id: string | null; type?: string }
  | { kind: "provider"; id: string | null }
  | null;

/** Protocols a hand-entered endpoint can speak; the rest need cloud setup a key alone does not cover. */
const CUSTOM_APIS = Object.keys(API_LABEL);

const KEYSTORE: Record<string, string> = {
  keychain: "系统钥匙串",
  dpapi: "Windows 凭据保护",
  gnome_libsecret: "GNOME 密钥环",
  kwallet: "KWallet",
  kwallet5: "KWallet",
  kwallet6: "KWallet",
};

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

function keyLine(p: ProviderRecord): string {
  if (p.key.source === "env") return p.key.set ? `读环境变量 ${p.key_env}` : `环境变量 ${p.key_env} 没设置`;
  return p.key.set ? `密钥 ${p.key.hint}` : "没有密钥";
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
function harnessStatus(h: HarnessView): { tone: "ok" | "warn" | "bad"; text: string } | null {
  if (h.adapter === "error") return { tone: "bad", text: "适配器出错" };
  if (h.adapter === "missing") return { tone: "warn", text: "没装适配器" };
  if (!h.state.usable) return { tone: "warn", text: "没找到程序" };
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
  const outdated = coreOutdated(about);
  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className={LIST_BODY}>
        {/* Roster's own preferences come first and never wait on core */}
        <SectionLabel>通用</SectionLabel>
        <button
          type="button"
          onClick={() => onSelect({ kind: "appearance" })}
          className={cn(ROW, rowState(selected?.kind === "appearance"))}
        >
          <SettingTile>
            <SunMoon />
          </SettingTile>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium">外观</div>
            {/* the theme always; font and size only once they differ from the default */}
            <div className="text-muted-foreground truncate text-xs">
              {[THEME_LABELS[theme], fontLabel(typography), sizeLabel(typography)].filter(Boolean).join(" · ")}
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
            <div className="truncate text-sm font-medium">关于 Roster</div>
            {/* a stale core is easy to miss, so the row says so without the page being opened */}
            <div className={cn("truncate text-xs", outdated ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground")}>
              {outdated ? "core 在跑旧代码，要重启" : about && "version" in about ? `版本 ${about.version}` : "版本和数据目录"}
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
  const presets = presetsOf(view);
  const is = (kind: "harness" | "agent" | "provider", id: string) =>
    selected !== null && selected.kind === kind && "id" in selected && selected.id === id;
  const harnesses = ext?.harnesses ?? [];
  const ready = harnesses.filter((h) => h.state.usable);
  const harnessOf = (type: string) => harnesses.find((h) => h.id === type);
  return (
    <>
      <SectionHead label={`Harness · ${ready.length}`} addLabel="更多 harness" onAdd={() => onSelect({ kind: "harnesses" })} />
      {ext && ready.length === 0 && (
        <button
          type="button"
          onClick={() => onSelect({ kind: "harnesses" })}
          className={cn(ROW, "text-muted-foreground text-xs leading-relaxed", rowState(selected?.kind === "harnesses"))}
        >
          本机还没有能用的 harness。点 + 看看能装什么。
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
                {picked ?? (h.state.version ? `版本 ${h.state.version}` : "版本未知")}
              </div>
            </div>
          </button>
        );
      })}

      <SectionHead label={`Agent · ${view.executors.length}`} addLabel="新建 agent" onAdd={() => onSelect({ kind: "agent", id: null })} />
      {view.executors.length === 0 && (
        <p className="text-muted-foreground px-2.5 py-2 text-xs leading-relaxed">
          还没有 agent。agent 是一个 harness，加上模型从哪来：订阅，或者一个模型 API。点 + 建一个；到通讯录里建 bot 时也能顺手建。
        </p>
      )}
      {view.executors.map((e) => {
        const pairing = `${harnessOf(e.type)?.label ?? e.type} · ${sourceName(view, e)}`;
        // a name that already says the pairing leaves the second line to the model
        const line = e.name.startsWith(pairing)
          ? e.model
            ? `默认模型 ${e.model}`
            : "默认模型跟着 harness"
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

      <SectionHead label={`模型 API · ${view.providers.length}`} addLabel="添加模型 API" onAdd={() => onSelect({ kind: "provider", id: null })} />
      {view.providers.length === 0 && (
        <p className="text-muted-foreground px-2.5 py-2 text-xs leading-relaxed">
          还没有模型 API。用订阅的 agent 不需要它；想按量调用 DeepSeek、Kimi、自建网关……，点 + 加一个。
        </p>
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
              {providerKind(p, presets)} · {keyLine(p)}
            </div>
          </div>
        </button>
      ))}

      <div className="text-muted-foreground flex items-start gap-1.5 px-2.5 pt-4 pb-1 text-[11px] leading-relaxed">
        {view.vault.encrypted ? <Lock className="mt-0.5 size-3 shrink-0" /> : <LockOpen className="mt-0.5 size-3 shrink-0 text-amber-600" />}
        {view.vault.encrypted
          ? `密钥加密保存，解密用的钥匙交给${KEYSTORE[view.vault.keystore] ?? "系统"}保管`
          : "这台机器上没有可用的系统密钥保管，密钥是明文存在本地数据库里的"}
      </div>
    </>
  );
}

function CheckResult({ result }: { result: { ok: boolean; items: CheckItem[] } | "running" | null }) {
  if (!result) return null;
  if (result === "running") {
    return (
      <p className="text-muted-foreground flex items-center gap-1.5 text-sm">
        <Loader className="size-3.5 animate-spin" />
        测试中…
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
            <span className="font-medium">{item.label}</span>
            <span className="text-muted-foreground">：{item.detail}</span>
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
            删除
          </Button>
        )}
        {error && <span className="text-destructive mr-auto ml-2 text-xs">{error}</span>}
        <span className={cn(!error && "mr-auto")} />
        <Button variant="outline" onClick={onCancel}>
          取消
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
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>取消</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={onConfirm}>
            删除
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

const FOUND: Record<string, string> = { path: "PATH 上", "npm-global": "npm 全局包", "known-path": "常见安装位置" };

/** A re-scan in one line: what changed since the last one, or what is there when nothing did. */
function detectionSummary(before: DetectedProgram[] | undefined, after: DetectedProgram[], label: (id: string) => string): string {
  const named = (p: DetectedProgram) => (p.version ? `${label(p.id)} ${p.version}` : label(p.id));
  const news = before
    ? [
        ...after.flatMap((p) => {
          const old = before.find((q) => q.id === p.id);
          if (!old) return [`新发现 ${named(p)}`];
          return old.version === p.version ? [] : [`${label(p.id)} ${old.version ?? "未知版本"} → ${p.version ?? "未知版本"}`];
        }),
        ...before.filter((p) => !after.some((q) => q.id === p.id)).map((p) => `${label(p.id)} 不见了`),
      ]
    : [];
  if (news.length > 0) return news.join("；");
  if (after.length === 0) return "没在这台机器上找到已装的 harness";
  return `${before ? "没有变化，" : ""}找到 ${after.map(named).join("、")}`;
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
  const label = (id: string) => harnesses.find((c) => c.id === id)?.label ?? id;
  return (
    <div className="rounded-xl border">
      <div className="flex items-center justify-between gap-3 px-4 py-3">
        <div className="flex items-center gap-2">
          <ScanSearch className="text-muted-foreground size-4" />
          <span className="text-sm font-medium">本机已经有的</span>
        </div>
        <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={onRefresh} disabled={refreshing}>
          <RefreshCw className={cn("size-3.5", refreshing && "animate-spin")} />
          重新检测
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
              <p className="text-muted-foreground">没在这台机器上找到已装的 harness。下面挑一个下载就行。</p>
            ) : (
              <ul className="space-y-1.5">
                {env.programs.map((p) => (
                  <li key={p.id} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                    <span className="font-medium">{label(p.id)}</span>
                    {p.version && <span className="text-muted-foreground tabular-nums">{p.version}</span>}
                    <span className="text-muted-foreground min-w-0 truncate font-mono text-xs" title={p.path}>
                      {p.path}
                    </span>
                    <span className="text-muted-foreground/70 text-xs">{FOUND[p.found]}</span>
                  </li>
                ))}
              </ul>
            )}
            {env.hints.length > 0 && (
              <p className="text-muted-foreground text-xs leading-relaxed">
                还发现了密钥线索：
                {env.hints.map((h) => (h.kind === "env" ? `环境变量 ${h.name}` : `pi 登录过的 ${h.name}`)).join("、")}
                。添加模型 API 时可以直接用。
              </p>
            )}
            {!env.shell.ok && (
              <p className="text-muted-foreground text-xs">登录 shell 没有回答，PATH 和环境变量只看到了这个进程自己的。</p>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function JobLine({ job }: { job: InstallJob }) {
  const last = job.log.at(-1);
  if (job.state === "running") {
    return (
      <div className="space-y-1.5">
        <Progress value={null as unknown as number} className="h-1" />
        <p className="text-muted-foreground truncate text-xs">{last ?? "正在下载…"}</p>
      </div>
    );
  }
  if (job.state === "failed") {
    return (
      <Alert variant="destructive">
        <AlertTitle>安装失败</AlertTitle>
        <AlertDescription>
          <pre className="max-h-32 overflow-auto font-mono text-[11px] leading-relaxed whitespace-pre-wrap">{job.log.join("\n") || "npm 没有留下输出"}</pre>
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
        toast.error("检测失败", { description: r.error });
        return;
      }
      await load();
      onChanged();
      const description = detectionSummary(before, r.programs, label);
      if (r.shell.ok) toast.success("检测完成", { description });
      else toast.warning("检测完成，但登录 shell 没有回答", { description: `${description}。PATH 和环境变量只看到了这个进程自己的。` });
    } catch (e) {
      toast.error("检测失败", { description: String(e) });
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
          <h2 className="text-lg font-semibold">{intro ? "先有一个能用的 harness" : "Harness"}</h2>
          <p className="text-muted-foreground mt-1 text-sm leading-relaxed">
            {intro
              ? "harness 是 Claude Code、Codex 这样跑 agent 循环的程序。本机装了的直接能用，没有的在这里下载。之后建 agent（harness 加上订阅或模型 API），再到通讯录里建 bot 选它。"
              : "有版本号的直接能用；显示「没找到程序」的点「下载安装」，装完就能用。"}
          </p>
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
            const status = harnessStatus(h);
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
                      本机没找到 <span className="font-mono">{h.program.bin}</span>，下载会装到 Roster 自己的目录，不动系统。
                    </p>
                  )}
                  {job && <JobLine job={job} />}
                </ItemContent>
                <ItemActions className="flex-col items-stretch gap-1.5">
                  {needsAdapter ? (
                    <Button size="sm" disabled={running || !h.extension} onClick={() => void run(h.id, () => api.installExtension(h.id))}>
                      {running ? <Loader className="animate-spin" /> : <Download />}
                      装适配器
                    </Button>
                  ) : needsProgram ? (
                    <Button size="sm" disabled={running} onClick={() => void run(h.id, () => api.installExtension(h.id))}>
                      {running ? <Loader className="animate-spin" /> : <Download />}
                      下载安装
                    </Button>
                  ) : (
                    <Button size="sm" variant="outline" onClick={() => onSelect({ kind: "harness", id: h.id })}>
                      设置
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
              <h3 className="text-sm font-medium">harness 不在了的 agent</h3>
              <p className="text-muted-foreground mt-0.5 text-xs leading-relaxed">
                这些 agent 的 harness 现在不在 Roster 里，用它们的 bot 启动不了。harness 装回来就能接着用；不要了就点进去删掉。
              </p>
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

/** The harness's own sign-in on this machine: it belongs to the program, so every agent on 订阅 shares it. */
function LoginCard({ type }: { type: string }) {
  const [login, setLogin] = useState<LoginState | "loading" | null>("loading");
  const [busy, setBusy] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

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
          <span className="text-sm font-medium">订阅登录</span>
          {state && (
            <StatusBadge tone={tone}>
              {state.state === "ok" ? `已登录${state.account ? ` · ${state.account}` : ""}` : state.state === "none" ? "没有登录" : "没问到"}
            </StatusBadge>
          )}
        </div>
        <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={() => read(true)} disabled={login === "loading"}>
          <RefreshCw className={cn("size-3.5", login === "loading" && "animate-spin")} />
          刷新
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
            {state?.state === "ok" && <p className="text-muted-foreground text-xs">凭据由程序自己保管，Roster 不碰它。这个 harness 上用订阅的 agent 都用这个账号。</p>}
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
                      title="复制命令"
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
                    登录
                  </Button>
                )}
              </div>
            ))}
            {state?.methods.some((m) => m.terminal) && <p className="text-muted-foreground text-xs">在终端里跑完，回来点刷新。</p>}
          </>
        )}
      </div>
    </div>
  );
}

function CapabilitiesOf({ type }: { type: HarnessTypeInfo }) {
  const own = type.capabilities.own;
  const endpoint = type.capabilities.endpoint;
  if (own && endpoint) {
    return (
      <Tabs defaultValue="own">
        <TabsList>
          <TabsTrigger value="own">用订阅时</TabsTrigger>
          <TabsTrigger value="endpoint">接模型 API 时</TabsTrigger>
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
function sourceName(view: ExecutorSettings, e: Pick<ExecutorRecord, "source_kind" | "provider_id">): string {
  return e.source_kind === "own" ? OWN_SOURCE_LABEL : (view.providers.find((p) => p.id === e.provider_id)?.name ?? "已删除的模型 API");
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
  const harness = ext?.harnesses.find((h) => h.id === id);
  const info = view.types.find((t) => t.type === id);
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
  const status = harness ? harnessStatus(harness) : null;

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
    <EditorFrame error={error} busy={busy} canSave={program.trim() !== saved} saveLabel="保存" onSave={() => void save()} onCancel={onCancel}>
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
            <AlertTitle>{needsAdapter ? "适配器没有装上，现在用不了" : `本机没找到 ${harness?.program?.bin ?? "它的程序"}`}</AlertTitle>
            <AlertDescription>
              <p>{needsAdapter ? "装上适配器之后才能用。" : "下载会装到 Roster 自己的目录，不动系统；下载完，这个 harness 上的 agent 就能启动。"}</p>
              <Button
                size="sm"
                className="mt-2"
                disabled={acting || (needsAdapter && !harness?.extension)}
                onClick={() => void run(() => api.installExtension(id))}
              >
                {acting ? <Loader className="animate-spin" /> : <Download />}
                {needsAdapter ? "装适配器" : "下载安装"}
              </Button>
            </AlertDescription>
          </Alert>
        )}
        {job && <JobLine job={job} />}
      </div>

      {harness?.state.needed && (
        <Field>
          <FieldLabel htmlFor="harness-program">程序</FieldLabel>
          <Input
            id="harness-program"
            value={program}
            onChange={(e) => setProgram(e.target.value)}
            placeholder={harness.state.path ? `留空就用 ${harness.state.path}` : `${harness.program?.bin ?? "程序"} 的完整路径`}
            spellCheck={false}
            className="font-mono text-xs"
          />
          <FieldDescription>
            {harness.state.path
              ? `留空用${found ? "本机检测到" : "Roster 装"}的${found?.version ? `（${found.version}）` : ""}；想换一份程序时再填。这个 harness 上的 agent 都跑这一份，订阅登录也是。`
              : "本机没找到它：下载一份，或者直接填程序的完整路径。"}
          </FieldDescription>
        </Field>
      )}

      {fetched && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-muted-foreground mr-auto text-xs">
            程序是 Roster 下载的{harness?.state.installed?.version ? `（${harness.state.installed.version}）` : ""}
          </span>
          <Button size="sm" variant="outline" disabled={acting} onClick={() => void run(() => api.updateExtension(id))}>
            {acting ? <Loader className="animate-spin" /> : <RefreshCw />}
            重新下载
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="text-muted-foreground hover:text-destructive"
            disabled={acting}
            onClick={() => setRemoving(true)}
          >
            <Trash2 />
            卸载
          </Button>
        </div>
      )}

      {info?.sources.own && <LoginCard type={id} />}

      {info && (
        <Field>
          <FieldLabel>能做什么</FieldLabel>
          <CapabilitiesOf type={info} />
          {info.sources.apis.length > 0 && (
            <FieldDescription>能接的协议：{info.sources.apis.map((a) => API_LABEL[a] ?? a).join("、")}</FieldDescription>
          )}
        </Field>
      )}

      <Field>
        <div className="flex items-center justify-between gap-3">
          <FieldLabel>这个 harness 上的 agent</FieldLabel>
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground -mr-2"
            disabled={!info}
            onClick={() => onSelect({ kind: "agent", id: null, type: id })}
          >
            <Plus />
            新建 agent
          </Button>
        </div>
        {agents.length > 0 ? (
          <div className="rounded-xl border p-1">
            {agents.map((e) => (
              <button key={e.id} type="button" onClick={() => onSelect({ kind: "agent", id: e.id })} className={cn(ROW, "hover:bg-accent")}>
                <span className="min-w-0 flex-1 truncate text-sm">{e.name}</span>
                <span className="text-muted-foreground shrink-0 text-xs">{sourceName(view, e)}</span>
                <ChevronRight className="text-muted-foreground size-3.5 shrink-0" />
              </button>
            ))}
          </div>
        ) : (
          <p className="text-muted-foreground text-sm">
            还没有。{info?.sources.own ? "建一个用订阅的，或者接一个模型 API 的；" : "接一个模型 API 建一个；"}到通讯录里建 bot 时也能顺手建。
          </p>
        )}
      </Field>

      <AlertDialog open={removing} onOpenChange={setRemoving}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>卸载「{label}」？</AlertDialogTitle>
            <AlertDialogDescription>
              Roster 下载的这份程序会被删掉；这个 harness 上的 agent 还留着，只是启动不了，再下载就能继续用。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                setRemoving(false);
                void run(() => api.removeExtension(id));
              }}
            >
              卸载
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
  const creating = executor === null;
  /** where a new agent on this harness starts: its own sign-in while nobody has it, else the first model API that fits */
  const startFor = (t: string): { kind: SourceKind; providerId: string | null } => {
    const ti = view.types.find((x) => x.type === t);
    const ownFree = Boolean(ti?.sources.own) && !view.executors.some((e) => e.type === t && e.source_kind === "own");
    const first = ti ? view.providers.find((p) => fits(ti, p, view)) : undefined;
    return ownFree ? { kind: "own", providerId: null } : { kind: "endpoint", providerId: first?.id ?? null };
  };
  const [type, setType] = useState(executor?.type ?? preset ?? view.types[0]?.type ?? "");
  // an old agent on a sign-in its harness does not have opens on a model API, so saving is the fix
  const stray = executor?.source_kind === "own" && view.types.find((t) => t.type === executor.type)?.sources.own === false;
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

  const info = view.types.find((t) => t.type === type);
  const harness = ext?.harnesses.find((h) => h.id === type);
  const label = info?.label ?? harness?.label ?? type;
  const fitting = info ? view.providers.filter((p) => fits(info, p, view)) : [];
  const ownTaken = view.executors.find((e) => e.type === type && e.source_kind === "own" && e.id !== executor?.id);
  const providerId = source.kind === "endpoint" ? source.providerId : null;
  const sourceLabel = source.kind === "own" ? OWN_SOURCE_LABEL : (view.providers.find((p) => p.id === providerId)?.name ?? "模型 API");
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

  const chooseHarness = (t: string) => {
    setType(t);
    setSource(startFor(t));
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
    if (r.error || !r.executor) return setError(r.error ?? "保存失败");
    setCheck(null);
    // core may have named it after its new source
    setName(r.executor.name);
    onSaved(r.executor);
  };

  const test = async () => {
    if (!executor) return;
    setCheck("running");
    const r = await api.checkExecutor(executor.id).catch((e: unknown) => ({ ok: false, items: [], error: String(e) }));
    setCheck(r.error ? { ok: false, items: [{ label: "测试", ok: false, detail: r.error }] } : r);
  };

  return (
    <EditorFrame
      title={creating ? "新建 agent" : undefined}
      description={creating ? "agent 是一个 harness，加上模型从哪来：harness 自带的订阅登录，或者一个模型 API。" : undefined}
      error={error}
      busy={busy}
      canSave={canSave}
      saveLabel={creating ? "创建" : "保存"}
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
              {label} · {sourceName(view, executor)}
            </p>
          </div>
        </div>
      )}

      {executor?.problem && (
        <Alert>
          <AlertTitle>现在用不了</AlertTitle>
          <AlertDescription>
            {executor.problem}
            {!info && (
              <Button variant="link" size="xs" className="h-auto p-0" onClick={() => onSelect({ kind: "harnesses", id: executor.type })}>
                去装 harness
              </Button>
            )}
          </AlertDescription>
        </Alert>
      )}

      {creating && (
        <Field>
          <FieldLabel>Harness</FieldLabel>
          {view.types.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              还没有能用的 harness。
              <Button variant="link" size="xs" className="h-auto p-0" onClick={() => onSelect({ kind: "harnesses" })}>
                去装一个
              </Button>
            </p>
          ) : (
            <RadioGroup value={type} onValueChange={chooseHarness} className="grid gap-2 sm:grid-cols-2">
              {view.types.map((t) => {
                const h = ext?.harnesses.find((x) => x.id === t.type);
                const st = h ? harnessStatus(h) : null;
                return (
                  <Choice key={t.type} value={t.type} selected={type === t.type}>
                    <HarnessTile type={t.type} brand={h?.brand} size="sm" />
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">{t.label}</span>
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
          <FieldLabel>模型从哪来</FieldLabel>
          {info.sources.own && info.sources.apis.length > 0 ? (
            <RadioGroup value={source.kind} onValueChange={(v) => chooseKind(v as SourceKind)} className="grid gap-2 sm:grid-cols-2">
              <Choice value="own" selected={source.kind === "own"} disabled={Boolean(ownTaken)}>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium">订阅</span>
                  <span className="text-muted-foreground block text-xs">
                    {ownTaken ? `已经有了：${ownTaken.name}` : `用 ${label} 自己登录的账号`}
                  </span>
                </span>
              </Choice>
              <Choice value="endpoint" selected={source.kind === "endpoint"}>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium">模型 API</span>
                  <span className="text-muted-foreground block text-xs">按量调用，用你添加的密钥</span>
                </span>
              </Choice>
            </RadioGroup>
          ) : (
            <p className="text-muted-foreground text-sm">
              {info.sources.own
                ? `用 ${label} 自己登录的账号${ownTaken ? `，已经有 agent 了：${ownTaken.name}` : ""}；它不接模型 API。`
                : `${label} 没有自带登录，接一个模型 API。`}
            </p>
          )}
          {source.kind === "endpoint" &&
            (fitting.length === 0 ? (
              <p className="text-muted-foreground text-xs">
                还没有接得上 {label} 的模型 API。
                <Button variant="link" size="xs" className="h-auto p-0" onClick={() => onSelect({ kind: "provider", id: null })}>
                  添加模型 API
                </Button>
              </p>
            ) : (
              <Select value={providerId ?? undefined} onValueChange={(id) => setSource({ kind: "endpoint", providerId: id })}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="选一个模型 API" />
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
          {!creating && <FieldDescription>换了之后，已经在会话里的成员会提示「设定有更新」，同步后才用新的。</FieldDescription>}
        </Field>
      )}

      {info && (
        <Field>
          <FieldLabel htmlFor="agent-model">默认模型</FieldLabel>
          {models === "loading" ? (
            <Skeleton className="h-9 w-full" />
          ) : models && models.length > 0 ? (
            <Select value={model || HARNESS_DEFAULT} onValueChange={(v) => setModel(v === HARNESS_DEFAULT ? "" : v)}>
              <SelectTrigger id="agent-model" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={HARNESS_DEFAULT}>不指定，用 {label} 自己的默认</SelectItem>
                {model && !models.some((m) => m.id === model) && <SelectItem value={model}>{model}</SelectItem>}
                {models.map((m) => (
                  <SelectItem key={m.id} value={m.id} disabled={!m.available}>
                    {m.label ?? m.id}
                    {!m.available && <span className="text-muted-foreground"> · {source.kind === "own" ? "没有登录" : "没有密钥"}</span>}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <Input
              id="agent-model"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="留空用它自己的默认"
              spellCheck={false}
              className="font-mono text-xs"
            />
          )}
          <FieldDescription>bot 没有自己选模型时用这个。</FieldDescription>
        </Field>
      )}

      <Field>
        <FieldLabel htmlFor="agent-name">名字</FieldLabel>
        <Input id="agent-name" value={name} onChange={(e) => setName(e.target.value)} placeholder={`${label} · ${sourceLabel}`} />
        <FieldDescription>建 bot 选 agent 时看到的就是它；留空自动起名。</FieldDescription>
      </Field>

      {executor && (
        <div className="space-y-2">
          <Button variant="outline" size="sm" onClick={() => void test()} disabled={check === "running"}>
            测试连接
          </Button>
          <p className="text-muted-foreground text-xs">
            测的是保存过的设置：{executor.source_kind === "own" ? "订阅登录在不在" : "模型 API 的密钥能不能用"}、程序能不能启动。不会发起对话，不花钱。
          </p>
          <CheckResult result={check} />
        </div>
      )}

      {caps && (
        <Field>
          <FieldLabel>能做什么</FieldLabel>
          <div className="rounded-lg border px-3 py-2.5">
            <CapabilityNotes caps={caps} />
          </div>
        </Field>
      )}

      {executor && (
        <Field>
          <FieldLabel>在用的 bot</FieldLabel>
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
            <p className="text-muted-foreground text-sm">还没有。到通讯录里建 bot 时选它。</p>
          )}
        </Field>
      )}

      {executor && (
        <ConfirmDelete
          open={confirming}
          onOpenChange={setConfirming}
          title={`删除「${executor.name}」？`}
          description="还有 bot 在用它，或者会话里还有成员跑在它上面的话，会删不掉。"
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
  const q = query.trim().toLowerCase();
  const shown = q ? presets.filter((p) => `${p.id} ${p.label}`.toLowerCase().includes(q)) : presets;
  return (
    <>
      {suggestions.length > 0 && (
        <Field>
          <FieldLabel>本机找到的密钥</FieldLabel>
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
                      读环境变量 <span className="font-mono">{h.name}</span>，Roster 不保存密钥
                    </div>
                  </div>
                  <Button size="sm" onClick={() => onPick(p.id, h.name)}>
                    用它添加
                  </Button>
                </div>
              );
            })}
          </div>
        </Field>
      )}

      <Field>
        <FieldLabel htmlFor="preset-search">从哪调</FieldLabel>
        <div className="flex gap-2">
          <div className="relative min-w-0 flex-1">
            <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2" />
            <Input
              id="preset-search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={`搜索 ${presets.length} 个预设`}
              autoComplete="off"
              spellCheck={false}
              className="pl-8"
            />
          </div>
          <Button variant="outline" onClick={() => onPick(CUSTOM_PRESET)}>
            <KeyRound />
            自定义 API
          </Button>
        </div>
        {shown.length === 0 ? (
          <p className="text-muted-foreground py-6 text-center text-sm">
            没有叫「{query.trim()}」的预设。不在列表里的，用自定义 API 自己填地址。
          </p>
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
                    {apiShort(p.api)}
                    {added.has(p.id) && " · 已添加"}
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
          ? `正在连${host ? ` ${host}` : ""}…`
          : dirty
            ? "有改动还没保存，保存后会自动再测一次。"
            : result
              ? result.detail
              : "还没测过。测试只拉一次模型列表，不花钱。"}
      </span>
      <Button variant="outline" size="sm" onClick={onTest} disabled={running || dirty}>
        <RefreshCw />
        测试连接
      </Button>
    </div>
  );
}

/** Which harnesses can take their models from here, and which agents already do. */
function UsedBy({ types, executors }: { types: readonly HarnessTypeInfo[]; executors: readonly ExecutorRecord[] | null }) {
  return (
    <Field>
      <FieldLabel>谁能用</FieldLabel>
      <dl className="divide-y rounded-xl border text-sm">
        <div className="flex items-center gap-3 px-4 py-2.5">
          <dt className="text-muted-foreground w-24 shrink-0 text-xs">能接的 harness</dt>
          <dd className="flex min-w-0 flex-1 flex-wrap gap-x-4 gap-y-1.5">
            {types.length > 0 ? (
              types.map((t) => (
                <span key={t.type} className="inline-flex items-center gap-1.5">
                  <ExecutorTile type={t.type} size="xs" />
                  {t.label}
                </span>
              ))
            ) : (
              <span className="text-muted-foreground">没有，协议跟现有的 harness 都对不上</span>
            )}
          </dd>
        </div>
        {executors && (
          <div className="flex items-center gap-3 px-4 py-2.5">
            <dt className="text-muted-foreground w-24 shrink-0 text-xs">在用的 agent</dt>
            <dd className="flex min-w-0 flex-1 flex-wrap gap-x-4 gap-y-1.5">
              {executors.length > 0 ? (
                executors.map((e) => (
                  <span key={e.id} className="inline-flex items-center gap-1.5">
                    <ExecutorTile type={e.type} size="xs" />
                    {e.name}
                  </span>
                ))
              ) : (
                <span className="text-muted-foreground">还没有。建 agent 时选它当模型 API。</span>
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
  const q = query.trim().toLowerCase();
  const shown = (models ?? []).filter((m) => !q || m.toLowerCase().includes(q));
  const settled = connection !== null && connection !== "running" ? connection : null;
  return (
    <Field>
      <div className="flex items-center justify-between gap-3">
        <FieldLabel>模型</FieldLabel>
        {models && models.length > 8 && (
          <div className="relative w-48">
            <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={`搜索 ${models.length} 个模型`}
              aria-label="搜索模型"
              autoComplete="off"
              spellCheck={false}
              className="h-8 pl-8 text-xs"
            />
          </div>
        )}
      </div>
      {models === null ? (
        <p className="text-muted-foreground text-sm">添加后会向 API 要一次模型列表，列出什么就是什么。</p>
      ) : models.length > 0 ? (
        <div className="max-h-96 overflow-y-auto rounded-xl border">
          {shown.length === 0 ? (
            <p className="text-muted-foreground px-4 py-6 text-center text-sm">没有匹配「{query.trim()}」的模型</p>
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
          {!settled.ok
            ? "连接通过后，这里列出 API 返回的模型。"
            : settled.models
              ? "API 没有列出任何模型。"
              : "这个 API 不提供模型列表。给 agent 或 bot 选模型时手填 id。"}
        </p>
      )}
      {models && models.length > 0 && <FieldDescription>以 API 返回的为准，测试连接时会重新拉取。</FieldDescription>}
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
  const usable = view.types.filter((t) =>
    custom ? t.sources.apis.includes(apiId) : (view.presets[t.type] ?? []).some((p) => p.id === preset),
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
      name: name.trim() || chosen?.label || "自定义 API",
      preset,
      ...(custom ? { api: apiId, base_url: baseUrl.trim(), models: modelList } : {}),
      key_env: keySource === "env" ? keyEnv.trim() : null,
      // an empty box leaves a saved key alone; switching to env clears it on the server
      ...(keySource === "stored" && key.trim() ? { key: key.trim() } : {}),
    };
    const r = creating ? await api.createProvider(body) : await api.updateProvider(provider.id, body);
    setBusy(false);
    if (r.error || !r.provider) return setError(r.error ?? "保存失败");
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
        title="添加模型 API"
        description="先选从哪调，再填密钥。"
        error={error}
        busy={busy}
        canSave={false}
        saveLabel="添加"
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
  const title = record?.name ?? (custom ? name.trim() || "自定义 API" : (chosen?.label ?? preset));
  const subtitle = custom
    ? title === "自定义 API"
      ? null
      : "自定义 API"
    : !chosen
      ? "这个预设现在没有 harness 提供"
      : chosen.label === title
        ? null
        : chosen.label;
  const facts = [apiShort(custom ? apiId : chosen?.api), custom && modelList.length > 0 ? `${modelList.length} 个模型` : "", host].filter(Boolean);
  const Heading = creating ? "h3" : "h2";
  const users = record ? view.executors.filter((e) => e.provider_id === record.id) : null;
  // what the last check listed, else what was saved from an earlier one, which the settings reload after a check carries
  const presetModels = record ? (listed ?? provider?.models ?? record.models) : null;

  return (
    <EditorFrame
      title={creating ? "添加模型 API" : undefined}
      error={error}
      busy={busy}
      canSave={custom ? baseUrl.trim() !== "" && modelList.length > 0 : Boolean(chosen) && Boolean(hasKey)}
      saveLabel={creating ? "添加" : "保存"}
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
              换一个
            </Button>
          )}
        </div>
        {record && <ConnectionLine state={connection} host={host} dirty={dirty} onTest={() => void test(record)} />}
      </div>

      {!custom && <ListedModels models={presetModels} connection={connection} />}

      {custom && (
        <>
          <Field>
            <FieldLabel>协议</FieldLabel>
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
                  {API_LABEL[id]}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </Field>
          <Field>
            <FieldLabel htmlFor="provider-url">地址</FieldLabel>
            <Input
              id="provider-url"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://"
              spellCheck={false}
              className="font-mono text-xs"
            />
            <FieldDescription>
              {apiId === "anthropic-messages" ? "不带 /v1，比如 https://api.example.com/anthropic" : "一般带 /v1，比如 https://api.example.com/v1"}
            </FieldDescription>
          </Field>
        </>
      )}

      <Field>
        <div className="flex items-center justify-between gap-3">
          <FieldLabel htmlFor="provider-key">密钥</FieldLabel>
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            value={keySource}
            onValueChange={(v) => v && setKeySource(v as "stored" | "env")}
          >
            <ToggleGroupItem value="stored" className="px-2.5 text-xs">
              保存在 Roster
            </ToggleGroupItem>
            <ToggleGroupItem value="env" className="px-2.5 text-xs">
              从环境变量读
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
            placeholder={storedKey ? `已保存 ${record?.key.hint}，留空不改` : (chosen?.keyLabel ?? "API key")}
            className="font-mono text-xs"
          />
        ) : (
          <Input
            id="provider-key"
            value={keyEnv}
            onChange={(e) => setKeyEnv(e.target.value)}
            placeholder={
              presetHint?.name ?? `比如 ${custom ? "MY_GATEWAY_KEY" : `${preset.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_API_KEY`}`
            }
            spellCheck={false}
            className="font-mono text-xs"
          />
        )}
        {presetHint && !(keySource === "env" && keyEnv.trim() === presetHint.name) && (
          <div className="text-muted-foreground flex items-center gap-1.5 text-xs">
            <ScanSearch className="size-3.5" />
            本机有 <span className="text-foreground font-mono">{presetHint.name}</span>
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
              改成读它
            </Button>
          </div>
        )}
        <FieldDescription>
          {keySource === "stored"
            ? view.vault.encrypted
              ? "加密后存在本地，界面上只显示首尾几位。"
              : "这台机器上没有系统密钥保管，会以明文存在本地数据库里。"
            : "Roster 不保存密钥，用的时候读这个变量。登录 shell（.zshrc、.bashrc）里设的也读得到。"}
        </FieldDescription>
      </Field>

      {custom && (
        <Field>
          <div className="flex items-center justify-between">
            <FieldLabel htmlFor="provider-models">模型</FieldLabel>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-muted-foreground -mr-2"
              onClick={() => void fetchModelList()}
              disabled={probe === "running" || baseUrl.trim() === ""}
            >
              {probe === "running" ? <Loader className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
              从接口拉取
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
          <FieldDescription>一行一个模型 id，第一个会作为默认。</FieldDescription>
        </Field>
      )}

      <Field>
        <FieldLabel htmlFor="provider-name">名字</FieldLabel>
        <Input id="provider-name" value={name} onChange={(e) => setName(e.target.value)} placeholder={chosen?.label ?? "比如：公司网关"} />
      </Field>

      <UsedBy types={usable} executors={users} />

      {record && (
        <ConfirmDelete
          open={confirming}
          onOpenChange={setConfirming}
          title={`删除「${record.name}」？`}
          description="保存的密钥会一起删掉。还有 agent 接着它的话会删不掉，先给它们换一个模型 API。"
          onConfirm={() => {
            void api.deleteProvider(record.id).then((r) => (r.error ? setError(r.error) : onDeleted()));
          }}
        />
      )}
    </EditorFrame>
  );
}
