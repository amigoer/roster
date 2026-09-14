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
  type AgentView,
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
  type CatalogGroup,
  type LoginState,
  type ModelOption,
  type ModelProbe,
  type ProviderPreset,
  type ProviderRecord,
} from "./api";
import { coreOutdated, type AboutState } from "./about";
import { BotAvatar } from "./bot-avatar";
import { CapabilityNotes } from "./capabilities";
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
  ExtensionTile,
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
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Item, ItemActions, ItemContent, ItemDescription, ItemMedia, ItemTitle } from "@/components/ui/item";
import { Progress } from "@/components/ui/progress";
import { RadioGroupItem } from "@/components/ui/radio-group";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";

/**
 * Settings speak of agents only. An agent's own page edits the executor bots
 * on it run on; a further executor of the same agent is an extra setup.
 */
export type SettingsSelection =
  | { kind: "appearance" }
  | { kind: "about" }
  /** every agent Roster knows, to fetch more; an id scrolls to that agent's card */
  | { kind: "extensions"; id?: string }
  | { kind: "agent"; id: string }
  /** an extra setup, or one whose agent is gone; the agent it belongs to travels with it */
  | { kind: "executor"; id: string | null; type: string }
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

/** Every preset any type offers, once each; where two types know one, the fuller catalog describes it. */
function presetsOf(view: ExecutorSettings): ProviderPreset[] {
  const seen = new Map<string, ProviderPreset>();
  for (const list of Object.values(view.presets)) {
    for (const p of list) if ((seen.get(p.id)?.models ?? -1) < p.models) seen.set(p.id, p);
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

/** One badge says where an agent stands: ready to use, and from where; or what is missing. */
function agentStatus(a: AgentView): { tone: "ok" | "warn" | "bad" | "quiet"; text: string } {
  if (a.adapter === "error") return { tone: "bad", text: "适配器出错" };
  if (a.adapter === "missing") return { tone: "warn", text: "没装适配器" };
  const { state } = a;
  if (!state.needed) return { tone: "ok", text: "内置" };
  if (state.detected) return { tone: "ok", text: `本机已有${state.detected.version ? ` ${state.detected.version}` : ""}` };
  if (state.installed) return { tone: "ok", text: `Roster 已装${state.installed.version ? ` ${state.installed.version}` : ""}` };
  return { tone: "warn", text: "没找到程序" };
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
          <AgentSettings view={view} ext={ext} selected={selected} onSelect={onSelect} />
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

function AgentSettings({
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
  const is = (kind: "agent" | "provider", id: string) =>
    selected !== null && selected.kind === kind && "id" in selected && selected.id === id;
  const agents = ext?.agents ?? [];
  const ready = agents.filter((a) => a.state.usable);
  return (
    <>
      <SectionHead label={`Agent · ${ready.length}`} addLabel="更多 agent" onAdd={() => onSelect({ kind: "extensions" })} />
      {ext && ready.length === 0 && (
        <button
          type="button"
          onClick={() => onSelect({ kind: "extensions" })}
          className={cn(ROW, "text-muted-foreground text-xs leading-relaxed", rowState(selected?.kind === "extensions"))}
        >
          本机还没有能用的 agent。点 + 看看能装什么。
        </button>
      )}
      {ready.map((a) => {
        const status = agentStatus(a);
        return (
          <button
            key={a.id}
            type="button"
            onClick={() => onSelect({ kind: "agent", id: a.id })}
            className={cn(ROW, rowState(is("agent", a.id) || (selected?.kind === "executor" && selected.type === a.id)))}
          >
            <ExtensionTile type={a.id} brand={a.brand} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <span className="truncate text-sm font-medium">{a.label}</span>
                <StatusBadge tone={status.tone}>{status.text}</StatusBadge>
              </div>
              <div className="text-muted-foreground truncate font-mono text-[11px]">{a.state.path ?? "随 Roster 内置"}</div>
            </div>
          </button>
        );
      })}

      <SectionHead label={`模型 API · ${view.providers.length}`} addLabel="添加模型 API" onAdd={() => onSelect({ kind: "provider", id: null })} />
      {view.providers.length === 0 && (
        <p className="text-muted-foreground px-2.5 py-2 text-xs leading-relaxed">
          还没有模型 API。有订阅的 agent 用它自己的登录就行；想按量调用 DeepSeek、Kimi、自建网关……，点 + 加一个。
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
  if (after.length === 0) return "没在这台机器上找到已装的 agent";
  return `${before ? "没有变化，" : ""}找到 ${after.map(named).join("、")}`;
}

function EnvironmentCard({
  env,
  refreshing,
  onRefresh,
  agents,
}: {
  env: Environment | null;
  refreshing: boolean;
  onRefresh: () => void;
  agents: AgentView[];
}) {
  const label = (id: string) => agents.find((c) => c.id === id)?.label ?? id;
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
              <p className="text-muted-foreground">没在这台机器上找到已装的 agent。下面挑一个下载就行。</p>
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
 * Every agent Roster can drive, and where each stands on this machine: the
 * adapter ships with Roster, the program is found or fetched. The first thing a
 * fresh install sees, and the place to come back to for more. Each agent's own
 * setup is on its own page.
 */
export function ExtensionsPanel({
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
  /** the agent picked in the list, scrolled to, outlined and unfolded */
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
    if (focus && loaded) document.getElementById(`agent-${focus}`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
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
    const label = (id: string) => ext?.agents.find((a) => a.id === id)?.label ?? id;
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

  const agents = ext?.agents ?? [];
  const env = ext?.environment ?? null;
  const jobOf = (id: string) => ext?.jobs.find((j) => j.id === id);
  // executors whose type no agent provides any more have no card to sit in
  const orphans = ext ? view.executors.filter((e) => !agents.some((a) => a.id === e.type)) : [];

  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="mx-auto max-w-2xl space-y-6 px-8 py-8">
        <div>
          <h2 className="text-lg font-semibold">{intro ? "先有一个能用的 agent" : "Agent"}</h2>
          <p className="text-muted-foreground mt-1 text-sm leading-relaxed">
            {intro
              ? "本机已经装了的 agent 直接就能用；没有的在这里下载，下载完就能用。之后到通讯录里建 bot，给它选一个 agent。"
              : "适配器随 Roster 内置。agent 程序本机有就直接用，没有才下载到 Roster 自己的目录里，下载完就能用。"}
          </p>
        </div>

        <EnvironmentCard env={env} refreshing={refreshing} onRefresh={() => void refresh()} agents={agents} />

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
          {agents.map((a) => {
            const status = agentStatus(a);
            const job = jobOf(a.id);
            const running = job?.state === "running" || busy === a.id;
            const needsProgram = a.state.needed && !a.state.usable && a.adapter !== "missing" && a.adapter !== "error";
            const needsAdapter = a.adapter === "missing" || a.adapter === "error";
            return (
              <Item
                key={a.id}
                id={`agent-${a.id}`}
                variant="outline"
                className={cn("scroll-my-4 items-start rounded-xl", a.id === focus && "border-foreground/40")}
              >
                <ItemMedia>
                  <ExtensionTile type={a.id} brand={a.brand} size="lg" />
                </ItemMedia>
                <ItemContent className="gap-1.5">
                  <ItemTitle className="flex flex-wrap items-center gap-1.5">
                    {a.label}
                    <StatusBadge tone={status.tone}>{status.text}</StatusBadge>
                  </ItemTitle>
                  <ItemDescription className="leading-relaxed">{a.description}</ItemDescription>
                  {a.adapterError && <p className="text-destructive text-xs">{a.adapterError}</p>}
                  {a.state.path && (
                    <p className="text-muted-foreground truncate font-mono text-[11px]" title={a.state.path}>
                      {a.state.path}
                    </p>
                  )}
                  {needsProgram && a.program && (
                    <p className="text-muted-foreground text-xs">
                      本机没找到 <span className="font-mono">{a.program.bin}</span>，下载会装到 Roster 自己的目录，不动系统。
                    </p>
                  )}
                  {job && <JobLine job={job} />}
                </ItemContent>
                <ItemActions className="flex-col items-stretch gap-1.5">
                  {needsAdapter ? (
                    <Button size="sm" disabled={running || !a.extension} onClick={() => void run(a.id, () => api.installExtension(a.id))}>
                      {running ? <Loader className="animate-spin" /> : <Download />}
                      装适配器
                    </Button>
                  ) : needsProgram ? (
                    <Button size="sm" disabled={running} onClick={() => void run(a.id, () => api.installExtension(a.id))}>
                      {running ? <Loader className="animate-spin" /> : <Download />}
                      下载安装
                    </Button>
                  ) : (
                    <Button size="sm" variant="outline" onClick={() => onSelect({ kind: "agent", id: a.id })}>
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
              <h3 className="text-sm font-medium">认不出来的 agent</h3>
              <p className="text-muted-foreground mt-0.5 text-xs leading-relaxed">
                这些 agent 的适配器现在不在 Roster 里，用它们的 bot 启动不了。适配器装回来就能接着用；不要了就点进去删掉。
              </p>
            </div>
            <div className="rounded-xl border p-1">
              {orphans.map((e) => (
                <button
                  key={e.id}
                  type="button"
                  onClick={() => onSelect({ kind: "executor", id: e.id, type: e.type })}
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

        {ext && (
          <p className="text-muted-foreground font-mono text-[11px]" title={ext.programsRoot}>
            下载的程序装在 {ext.programsRoot}
          </p>
        )}
      </div>
    </ScrollArea>
  );
}

function LoginCard({ executorId }: { executorId: string }) {
  const [login, setLogin] = useState<LoginState | "loading" | null>("loading");
  const [busy, setBusy] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const read = (fresh: boolean) => {
    setLogin("loading");
    void api.executorLogin(executorId, fresh).then((r) => setLogin(r.error ? { state: "unknown", detail: r.error, methods: [] } : r));
  };
  useEffect(() => read(false), [executorId]);

  const state = login === "loading" || !login ? null : login;
  const tone = state?.state === "ok" ? "ok" : state?.state === "none" ? "warn" : "quiet";
  return (
    <div className="rounded-xl border">
      <div className="flex items-center justify-between gap-3 px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">自带登录</span>
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
            {state?.state === "ok" && <p className="text-muted-foreground text-xs">凭据由 agent 自己保管，Roster 不碰它。</p>}
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
                      void api.authenticate(executorId, m.id).then((r) => {
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
          <TabsTrigger value="own">用自带登录时</TabsTrigger>
          <TabsTrigger value="endpoint">接 API 时</TabsTrigger>
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

/** What an agent's type asks for. The program falls back to what this machine has, so the agent's own setup leaves it empty. */
function SettingFields({
  info,
  agent,
  env,
  settings,
  onChange,
  extra = false,
}: {
  info: HarnessTypeInfo;
  agent: AgentView | undefined;
  env: Environment | null;
  settings: Record<string, string>;
  onChange: (key: string, value: string) => void;
  /** an extra setup exists to run another program, so the program is asked for rather than defaulted */
  extra?: boolean;
}) {
  const found = env?.programs.find((p) => p.id === info.type);
  return (
    <>
      {info.fields.map((f) => {
        const isProgram = f.key === "executable";
        const program = isProgram ? (agent?.state.path ?? null) : null;
        return (
          <Field key={f.key}>
            <FieldLabel htmlFor={`executor-${f.key}`}>{f.label}</FieldLabel>
            <Input
              id={`executor-${f.key}`}
              value={settings[f.key] ?? ""}
              onChange={(e) => onChange(f.key, e.target.value)}
              placeholder={
                isProgram && extra ? `另一份 ${agent?.program?.bin ?? "程序"} 的完整路径` : program ? `留空就用 ${program}` : f.placeholder
              }
              spellCheck={false}
              className={cn(f.kind === "path" && "font-mono text-xs")}
            />
            <FieldDescription>
              {isProgram && extra
                ? program
                  ? `${info.label} 自己用的是 ${program}，这里填另一份。`
                  : "填另一份程序的完整路径。"
                : program
                  ? `留空用${found ? "本机检测到" : "Roster 装"}的${found?.version ? `（${found.version}）` : ""}；只在想换一份程序时填。`
                  : f.help}
            </FieldDescription>
          </Field>
        );
      })}
    </>
  );
}

/**
 * One agent's page. The executor it edits and tests is the agent's own, the
 * oldest of its type, and bots on the agent run on it. A later executor of the
 * same type is an extra setup, listed at the bottom and edited on its own page.
 */
export function AgentPanel({
  id,
  view,
  ext,
  bots,
  onSaved,
  onChanged,
  onCancel,
  onSelect,
}: {
  id: string;
  view: ExecutorSettings;
  ext: ExtensionsView | null;
  bots: readonly Bot[];
  onSaved: () => void;
  /** the agent's program was fetched or removed */
  onChanged: () => void;
  onCancel: () => void;
  onSelect: (s: SettingsSelection) => void;
}) {
  const agent = ext?.agents.find((a) => a.id === id);
  const info = view.types.find((t) => t.type === id);
  const mine = view.executors.filter((e) => e.type === id);
  const own = mine[0];
  const extras = mine.slice(1);
  const label = agent?.label ?? info?.label ?? id;
  const [settings, setSettings] = useState<Record<string, string>>(own?.settings ?? {});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [check, setCheck] = useState<{ ok: boolean; items: CheckItem[] } | "running" | null>(null);
  const [removing, setRemoving] = useState(false);

  // core makes the agent's own executor a moment after the agent becomes ready
  const ownId = own?.id;
  useEffect(() => {
    setSettings(own?.settings ?? {});
    setCheck(null);
  }, [ownId]);

  const job = ext?.jobs.find((j) => j.id === id);
  const acting = busy || job?.state === "running";
  const needsAdapter = agent?.adapter === "missing" || agent?.adapter === "error";
  const needsProgram = Boolean(agent?.state.needed && !agent.state.usable && !needsAdapter);
  // only a program Roster fetched is Roster's to fetch again or remove
  const fetched = Boolean(agent?.state.installed && !agent.state.detected);
  const dirty = own !== undefined && (info?.fields ?? []).some((f) => (settings[f.key] ?? "").trim() !== (own.settings[f.key] ?? ""));
  const users = bots.filter((b) => !b.archived_at && mine.some((e) => e.id === b.executor_id));
  const status = agent ? agentStatus(agent) : null;

  const save = async () => {
    if (!own) return;
    setBusy(true);
    setError(null);
    const r = await api.updateExecutor(own.id, { settings });
    setBusy(false);
    if (r.error || !r.executor) return setError(r.error ?? "保存失败");
    setCheck(null);
    onSaved();
  };

  const test = async () => {
    if (!own) return;
    setCheck("running");
    const r = await api.checkExecutor(own.id).catch((e: unknown) => ({ ok: false, items: [], error: String(e) }));
    setCheck(r.error ? { ok: false, items: [{ label: "测试", ok: false, detail: r.error }] } : r);
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
    <EditorFrame error={error} busy={busy} canSave={dirty} saveLabel="保存" onSave={() => void save()} onCancel={onCancel}>
      <div className="space-y-4">
        <div className="flex items-start gap-4">
          <ExtensionTile type={id} brand={agent?.brand} size="lg" />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <h2 className="truncate text-lg leading-snug font-semibold">{label}</h2>
              {status && <StatusBadge tone={status.tone}>{status.text}</StatusBadge>}
            </div>
            {agent?.description && <p className="text-muted-foreground mt-1 text-sm leading-relaxed">{agent.description}</p>}
            {agent?.adapterError && <p className="text-destructive mt-1 text-xs">{agent.adapterError}</p>}
          </div>
        </div>
        {(needsAdapter || needsProgram) && (
          <Alert>
            <Download />
            <AlertTitle>{needsAdapter ? "适配器没有装上，现在用不了" : `本机没找到 ${agent?.program?.bin ?? "它的程序"}`}</AlertTitle>
            <AlertDescription>
              <p>{needsAdapter ? "装上适配器之后才能用。" : "下载会装到 Roster 自己的目录，不动系统；下载完，用它的 bot 就能启动。"}</p>
              <Button
                size="sm"
                className="mt-2"
                disabled={acting || (needsAdapter && !agent?.extension)}
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

      {info && own && info.fields.length > 0 && (
        <SettingFields
          info={info}
          agent={agent}
          env={ext?.environment ?? null}
          settings={settings}
          onChange={(key, value) => setSettings((s) => ({ ...s, [key]: value }))}
        />
      )}

      {fetched && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-muted-foreground mr-auto text-xs">
            程序是 Roster 下载的{agent?.state.installed?.version ? `（${agent.state.installed.version}）` : ""}
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

      {own && info?.sources.own && <LoginCard executorId={own.id} />}

      {own && (
        <div className="space-y-2">
          <Button variant="outline" size="sm" onClick={() => void test()} disabled={check === "running"}>
            测试连接
          </Button>
          <p className="text-muted-foreground text-xs">测的是保存过的配置：程序能不能启动、自带登录在不在。不会发起对话，不花钱。</p>
          <CheckResult result={check} />
        </div>
      )}

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
        <FieldLabel>在用的 bot</FieldLabel>
        {users.length > 0 ? (
          <div className="flex flex-wrap gap-x-4 gap-y-2 rounded-xl border px-4 py-2.5 text-sm">
            {users.map((b) => {
              const setup = extras.find((e) => e.id === b.executor_id);
              return (
                <span key={b.id} className="inline-flex items-center gap-1.5">
                  <BotAvatar bot={b} size="xs" />
                  {b.name}
                  {setup && <span className="text-muted-foreground text-xs">· {setup.name}</span>}
                </span>
              );
            })}
          </div>
        ) : (
          <p className="text-muted-foreground text-sm">还没有。到通讯录里建 bot 时，选它当 agent。</p>
        )}
      </Field>

      {info && info.fields.length > 0 && (
        <Field>
          <div className="flex items-center justify-between gap-3">
            <FieldLabel>其他配置</FieldLabel>
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground -mr-2"
              onClick={() => onSelect({ kind: "executor", id: null, type: id })}
            >
              <Plus />
              加一份
            </Button>
          </div>
          {extras.length > 0 && (
            <div className="rounded-xl border p-1">
              {extras.map((e) => (
                <button
                  key={e.id}
                  type="button"
                  onClick={() => onSelect({ kind: "executor", id: e.id, type: id })}
                  className={cn(ROW, "hover:bg-accent")}
                >
                  <span className="min-w-0 flex-1 truncate text-sm">{e.name}</span>
                  <span className="text-muted-foreground min-w-0 truncate font-mono text-[11px]" title={e.settings.executable}>
                    {e.settings.executable}
                  </span>
                  <ChevronRight className="text-muted-foreground size-3.5 shrink-0" />
                </button>
              ))}
            </div>
          )}
          <FieldDescription>
            一般用不到。想让一部分 bot 跑另一份程序（比如测试版）时再加；建 bot 时，它和 {label} 一起列在 agent 里。
          </FieldDescription>
        </Field>
      )}

      <AlertDialog open={removing} onOpenChange={setRemoving}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>卸载「{label}」？</AlertDialogTitle>
            <AlertDialogDescription>
              Roster 下载的这份程序会被删掉；用它的 bot 还留着，只是启动不了，再下载就能继续用。
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

/**
 * An extra setup of an agent, so some bots run another program than the rest;
 * or a setup whose agent is gone, kept so it can be seen and deleted. The
 * agent's own setup is edited on the agent's page.
 */
export function ExecutorEditor({
  view,
  executor,
  type,
  env,
  ext,
  onSaved,
  onCancel,
  onDeleted,
  onExtensions,
}: {
  view: ExecutorSettings;
  executor: ExecutorRecord | null;
  /** the agent it belongs to; fixed, since the page it was opened from decides it */
  type: string;
  env: Environment | null;
  ext: ExtensionsView | null;
  onSaved: (e: ExecutorRecord) => void;
  onCancel: () => void;
  onDeleted: () => void;
  onExtensions: () => void;
}) {
  const creating = executor === null;
  const [name, setName] = useState(executor?.name ?? "");
  const [settings, setSettings] = useState<Record<string, string>>(executor?.settings ?? {});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [check, setCheck] = useState<{ ok: boolean; items: CheckItem[] } | "running" | null>(null);
  const [confirming, setConfirming] = useState(false);
  const info = view.types.find((t) => t.type === type);
  const agent = ext?.agents.find((a) => a.id === type);
  const label = info?.label ?? agent?.label ?? type;
  // one that sets nothing would run exactly what the agent's own setup runs
  const setsSomething = !info || info.fields.length === 0 || info.fields.some((f) => Boolean(settings[f.key]?.trim()));

  const save = async () => {
    setBusy(true);
    setError(null);
    const body = { name: name.trim(), settings, ...(creating ? { type } : {}) };
    const r = creating ? await api.createExecutor(body) : await api.updateExecutor(executor.id, body);
    setBusy(false);
    if (r.error || !r.executor) return setError(r.error ?? "保存失败");
    setCheck(null);
    onSaved(r.executor);
  };

  const test = async () => {
    if (!executor) return;
    setCheck("running");
    const r = await api.checkExecutor(executor.id).catch((e: unknown) => ({ ok: false, items: [], error: String(e) }));
    setCheck(r.error ? { ok: false, items: [{ label: "测试", ok: false, detail: r.error }] } : r);
  };

  if (creating && !info) {
    return (
      <Empty className="flex-1">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Download />
          </EmptyMedia>
          <EmptyTitle>{label} 现在加不了配置</EmptyTitle>
          <EmptyDescription>它的适配器没有加载上，先回 Agent 页看看。</EmptyDescription>
        </EmptyHeader>
        <Button onClick={onExtensions}>去 Agent 页</Button>
      </Empty>
    );
  }

  return (
    <EditorFrame
      title={creating ? `给 ${label} 加一份配置` : `编辑「${executor.name}」`}
      {...(creating || executor.known
        ? { description: `让一部分 bot 跑另一份 ${label} 程序，比如测试版。建 bot 时，它和 ${label} 一起列在 agent 里。` }
        : {})}
      error={error}
      busy={busy}
      canSave={Boolean(info) && name.trim() !== "" && setsSomething}
      saveLabel={creating ? "添加" : "保存"}
      onSave={() => void save()}
      onCancel={onCancel}
      {...(creating ? {} : { onDelete: () => setConfirming(true) })}
    >
      {!creating && !executor.known && (
        <Alert>
          <AlertTitle>没有它的适配器</AlertTitle>
          <AlertDescription>
            「{executor.type}」这个 agent 现在没有适配器提供。装回来之前，用它的 bot 启动不了。
            <Button variant="link" size="xs" className="h-auto p-0" onClick={onExtensions}>
              去 Agent 页
            </Button>
          </AlertDescription>
        </Alert>
      )}

      <Field>
        <FieldLabel htmlFor="executor-name">名字</FieldLabel>
        <Input id="executor-name" value={name} onChange={(e) => setName(e.target.value)} placeholder={`比如：${label} 测试版`} />
        <FieldDescription>建 bot 选 agent 时，看到的就是这个名字。</FieldDescription>
      </Field>

      {info && (
        <SettingFields
          info={info}
          agent={agent}
          env={env}
          settings={settings}
          onChange={(key, value) => setSettings((s) => ({ ...s, [key]: value }))}
          extra
        />
      )}

      {!creating && info?.sources.own && <LoginCard executorId={executor.id} />}

      {!creating && (
        <div className="space-y-2">
          <Button variant="outline" size="sm" onClick={() => void test()} disabled={check === "running"}>
            测试连接
          </Button>
          <p className="text-muted-foreground text-xs">测的是保存过的配置：程序能不能启动、自带登录在不在。不会发起对话，不花钱。</p>
          <CheckResult result={check} />
        </div>
      )}

      {executor && (
        <ConfirmDelete
          open={confirming}
          onOpenChange={setConfirming}
          title={`删除「${executor.name}」？`}
          description="还有 bot 在用它的话会删不掉，先给那些 bot 换一个 agent。"
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

/** Which agents can take their models from here, and which bots already do. */
function UsedBy({ types, bots }: { types: readonly HarnessTypeInfo[]; bots: readonly Bot[] | null }) {
  return (
    <Field>
      <FieldLabel>谁能用</FieldLabel>
      <dl className="divide-y rounded-xl border text-sm">
        <div className="flex items-center gap-3 px-4 py-2.5">
          <dt className="text-muted-foreground w-20 shrink-0 text-xs">能接的 agent</dt>
          <dd className="flex min-w-0 flex-1 flex-wrap gap-x-4 gap-y-1.5">
            {types.length > 0 ? (
              types.map((t) => (
                <span key={t.type} className="inline-flex items-center gap-1.5">
                  <ExecutorTile type={t.type} size="xs" />
                  {t.label}
                </span>
              ))
            ) : (
              <span className="text-muted-foreground">没有，协议跟现有的 agent 都对不上</span>
            )}
          </dd>
        </div>
        {bots && (
          <div className="flex items-center gap-3 px-4 py-2.5">
            <dt className="text-muted-foreground w-20 shrink-0 text-xs">在用的 bot</dt>
            <dd className="flex min-w-0 flex-1 flex-wrap gap-x-4 gap-y-1.5">
              {bots.length > 0 ? (
                bots.map((b) => (
                  <span key={b.id} className="inline-flex items-center gap-1.5">
                    <BotAvatar bot={b} size="xs" />
                    {b.name}
                  </span>
                ))
              ) : (
                <span className="text-muted-foreground">还没有。到通讯录里给 bot 选它当模型来源。</span>
              )}
            </dd>
          </div>
        )}
      </dl>
    </Field>
  );
}

const tokenCount = (n: number): string => (n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(1)}M` : `${Math.round(n / 1000)}K`);

const usd = (n: number): string => `$${+n.toFixed(3)}`;

function ModelRow({ model }: { model: ModelOption }) {
  const name = model.label ?? model.id;
  // an id the endpoint listed that no catalog describes has nothing more to show than itself
  const described = model.label !== undefined || model.contextWindow !== undefined || model.cost !== undefined;
  const facts = [
    model.contextWindow ? `${tokenCount(model.contextWindow)} 上下文` : null,
    model.reasoning ? "推理" : null,
    model.images ? "看图" : null,
  ].filter((f): f is string => f !== null);
  return (
    <li className="flex items-center gap-3 px-4 py-2">
      <div className="min-w-0 flex-1">
        <div className={cn("truncate text-sm", name === model.id && "font-mono text-xs")}>{name}</div>
        {(name !== model.id || model.cost) && (
          <div className="text-muted-foreground truncate text-xs">
            {name !== model.id && <span className="font-mono">{model.id}</span>}
            {name !== model.id && model.cost && " · "}
            {model.cost && `${usd(model.cost.input)} / ${usd(model.cost.output)}`}
          </div>
        )}
      </div>
      {facts.length > 0 ? (
        <div className="flex shrink-0 gap-1">
          {facts.map((f) => (
            <StatusBadge key={f} tone="quiet">
              {f}
            </StatusBadge>
          ))}
        </div>
      ) : (
        !described && <span className="text-muted-foreground shrink-0 text-xs">目录里没有详情</span>
      )}
    </li>
  );
}

type CatalogState = { groups: CatalogGroup[] } | { error: string } | null;

const SUBHEAD = "bg-muted text-muted-foreground sticky top-0 z-10 flex items-center gap-1.5 border-b px-4 py-1.5 text-xs";

/**
 * What the endpoint offers. Once a test has listed what the key reaches, that
 * list leads, each model described from the catalog where it can be, and the
 * rest of the catalog folds away below. Until then the catalog stands in, per
 * agent, since each agent picks a bot's model from its own list.
 */
function ModelCatalog({ catalog, listed, pending }: { catalog: CatalogState; listed: readonly string[] | null; pending: boolean }) {
  const [query, setQuery] = useState("");
  const [othersOpen, setOthersOpen] = useState(false);
  const groups = catalog && "groups" in catalog ? catalog.groups : [];
  // one description per id: the catalog that knows the most about it wins
  const described = new Map<string, ModelOption>();
  for (const g of groups) {
    for (const m of g.models) {
      const seen = described.get(m.id);
      if (!seen || (seen.contextWindow === undefined && m.contextWindow !== undefined)) described.set(m.id, m);
    }
  }
  const q = query.trim().toLowerCase();
  const matches = (m: ModelOption) => !q || `${m.id} ${m.label ?? ""}`.toLowerCase().includes(q);
  const onKey = listed ? listed.map((id) => described.get(id) ?? { id, available: true }) : null;
  const inKey = new Set(listed ?? []);
  const others = groups.map((g) => ({ ...g, models: g.models.filter((m) => !inKey.has(m.id)) })).filter((g) => g.models.length > 0);
  const othersCount = others.reduce((n, g) => n + g.models.length, 0);
  const total = (onKey?.length ?? 0) + othersCount;
  const shownOnKey = onKey?.filter(matches) ?? [];
  // a search looks through everything, folded or not
  const shownOthers = !onKey || othersOpen || q ? others.map((g) => ({ ...g, models: g.models.filter(matches) })).filter((g) => g.models.length > 0) : [];
  const priced = [...described.values()].some((m) => m.cost);
  return (
    <Field>
      <div className="flex items-center justify-between gap-3">
        <FieldLabel>模型</FieldLabel>
        {total > 8 && (
          <div className="relative w-48">
            <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={`搜索 ${total} 个模型`}
              aria-label="搜索模型"
              autoComplete="off"
              spellCheck={false}
              className="h-8 pl-8 text-xs"
            />
          </div>
        )}
      </div>
      {pending || (catalog === null && !onKey) ? (
        <div className="space-y-2 rounded-xl border px-4 py-3">
          <Skeleton className="h-3.5 w-1/3" />
          <Skeleton className="h-3.5 w-1/2" />
        </div>
      ) : total === 0 ? (
        catalog && "error" in catalog ? (
          <p className="text-destructive text-sm">读不到模型目录：{catalog.error}</p>
        ) : (
          <p className="text-muted-foreground text-sm">没有可列的模型；给 bot 选模型时可以手填 id。</p>
        )
      ) : (
        <div className="max-h-96 overflow-y-auto rounded-xl border [&>*+*]:border-t">
          {q && shownOnKey.length === 0 && shownOthers.length === 0 && (
            <p className="text-muted-foreground px-4 py-6 text-center text-sm">没有匹配「{query.trim()}」的模型</p>
          )}
          {onKey && shownOnKey.length > 0 && (
            <div>
              <div className={SUBHEAD}>API 列出的 · {onKey.length}</div>
              <ul className="divide-y">
                {shownOnKey.map((m) => (
                  <ModelRow key={m.id} model={m} />
                ))}
              </ul>
            </div>
          )}
          {onKey && othersCount > 0 && !q && (
            <button
              type="button"
              aria-expanded={othersOpen}
              onClick={() => setOthersOpen((o) => !o)}
              className="text-muted-foreground hover:text-foreground flex w-full items-center gap-1.5 px-4 py-2 text-left text-xs transition-colors"
            >
              <ChevronRight className={cn("size-3.5 transition-transform", othersOpen && "rotate-90")} />
              目录里还有 {othersCount} 个，这次 API 没列出
            </button>
          )}
          {shownOthers.map((g) => (
            <div key={g.type}>
              {/* agents list the same endpoint differently, so each list says whose it is */}
              {groups.length > 1 && (
                <div className={SUBHEAD}>
                  <ExecutorTile type={g.type} size="xs" />
                  {g.label} 能选的 · {g.models.length}
                </div>
              )}
              <ul className="divide-y">
                {g.models.map((m) => (
                  <ModelRow key={m.id} model={m} />
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
      {!pending && total > 0 && (!onKey || priced) && (
        <FieldDescription>
          {!onKey && "还没从 API 拿到列表，先显示目录里的。"}
          {priced && "价格是每百万 token 的输入 / 输出，美元。"}
        </FieldDescription>
      )}
    </Field>
  );
}

export function ProviderEditor({
  view,
  provider,
  env,
  bots,
  onSaved,
  onCancel,
  onDeleted,
}: {
  view: ExecutorSettings;
  provider: ProviderRecord | null;
  env: Environment | null;
  bots: readonly Bot[];
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
  const [catalog, setCatalog] = useState<CatalogState>(null);
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

  // a custom endpoint's models are the form itself; a preset's come from the catalog, before it is saved too
  const catalogFor = custom || !preset ? null : (record?.id ?? `preset:${preset}`);
  useEffect(() => {
    if (!catalogFor) return;
    let live = true;
    setCatalog(null);
    const read = record ? api.providerModels(record.id) : api.presetModels(preset);
    void read
      .then((r) => live && setCatalog(r.groups ? { groups: r.groups } : { error: r.error ?? "没有返回模型" }))
      .catch((e: unknown) => live && setCatalog({ error: String(e) }));
    return () => {
      live = false;
    };
  }, [catalogFor]);

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
      ? "这个预设现在没有 agent 提供"
      : chosen.label === title
        ? null
        : chosen.label;
  // a preset's models are counted in its list below, per agent; one number up here would disagree with it
  const facts = [apiShort(custom ? apiId : chosen?.api), custom && modelList.length > 0 ? `${modelList.length} 个模型` : "", host].filter(Boolean);
  const Heading = creating ? "h3" : "h2";
  const users = record ? bots.filter((b) => b.model_source === record.id && !b.archived_at) : null;
  // a saved API's list waits for its first check, rather than showing the catalog and then jumping
  const modelsPending = record !== null && listed === null && (connection === null || connection === "running");

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

      {!custom && <ModelCatalog catalog={catalog} listed={listed} pending={modelsPending} />}

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

      <UsedBy types={usable} bots={users} />

      {record && (
        <ConfirmDelete
          open={confirming}
          onOpenChange={setConfirming}
          title={`删除「${record.name}」？`}
          description="保存的密钥会一起删掉。还有 bot 用它做模型来源的话会删不掉，先给它们换一个。"
          onConfirm={() => {
            void api.deleteProvider(record.id).then((r) => (r.error ? setError(r.error) : onDeleted()));
          }}
        />
      )}
    </EditorFrame>
  );
}
