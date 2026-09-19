import { useEffect, useId, useState, type ReactNode } from "react";
import { Check, ChevronRight, CircleArrowUp, Copy, Download, FolderDown, KeyRound, Loader, Plus, RefreshCw, Trash2, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import {
  api,
  type ExecutorSettings,
  type ExtensionsView,
  type HarnessTypeInfo,
  type HarnessView,
  type InstallJob,
  type LoginState,
} from "../api";
import { CapabilityNotes } from "../capabilities";
import { useI18n, type Translate } from "../i18n";
import { ROW } from "../list";
import { apiLabel, ExecutorTile, HarnessTile, type Tone } from "../tiles";
import { agentLine, GroupLabel, ListCard, ListRow, Page, PageHeader, tilde, WARN_TEXT, type SettingsRoute } from "./shared";
import { Alert, AlertDescription } from "@/components/ui/alert";
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
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

type ExtResult = ExtensionsView & { error?: string };

/** The line under a harness's name: its version once it runs, else what stands in the way. */
function stateLine(
  t: Translate,
  h: HarnessView,
  job: InstallJob | undefined,
  running: boolean,
  ready: boolean,
  custom: boolean,
): { text: ReactNode; tone?: string } {
  if (running) return { text: job?.log.at(-1) ?? (job?.update ? t("install.updating") : t("install.downloading")) };
  // a program picked by hand is what runs, whatever else was found
  if (ready && custom) return { text: t("harness.from.custom") };
  // a program that turned up since wins over the failure that came before it
  if (ready) {
    const current = h.state.version ? t("harnesses.version", { version: h.state.version }) : t("harnesses.ready");
    return { text: h.update?.available ? t("harnesses.withUpdate", { current, latest: h.update.latest }) : current };
  }
  if (job?.state === "failed") return { text: t("harnesses.installFailed"), tone: "text-destructive" };
  if (h.adapter === "error") return { text: h.adapterError ?? t("harness.status.adapterError"), tone: "text-destructive" };
  if (h.adapter === "missing") return { text: t("harness.status.noAdapter"), tone: WARN_TEXT };
  return {
    text: h.program ? t.rich("harnesses.programMissing", { bin: <span className="font-mono">{h.program.bin}</span> }) : t("harness.status.noProgram"),
    tone: WARN_TEXT,
  };
}

/**
 * One harness on the overview. Its name is the button that opens its page,
 * stretched over the whole row, so a harness that cannot run yet carries its
 * download in the row without a button inside a button.
 */
function HarnessRow({
  harness: h,
  custom,
  job,
  busy,
  agents,
  onOpen,
  onInstall,
}: {
  harness: HarnessView;
  /** a program was picked by hand for it, which is taken at its word */
  custom: boolean;
  job: InstallJob | undefined;
  /** the install call is on its way and has no job yet */
  busy: boolean;
  agents: number;
  onOpen: () => void;
  onInstall: () => void;
}) {
  const { t } = useI18n();
  const lineId = useId();
  const needsAdapter = h.adapter === "missing" || h.adapter === "error";
  const needsProgram = h.state.needed && !h.state.usable && !needsAdapter && !custom;
  const running = busy || job?.state === "running";
  const ready = (h.state.usable || custom) && !needsAdapter;
  const line = stateLine(t, h, job, running, ready, custom);
  return (
    <div className={cn(ROW, "hover:bg-accent")}>
      <HarnessTile type={h.id} brand={h.brand} absent={!ready} />
      <div className="min-w-0 flex-1">
        <button
          type="button"
          onClick={onOpen}
          aria-describedby={lineId}
          className="focus-visible:after:ring-ring/60 flex max-w-full text-left outline-none after:absolute after:inset-0 after:rounded-[10px] focus-visible:after:ring-2"
        >
          <span className="truncate text-sm font-medium">{h.label}</span>
        </button>
        <p id={lineId} className={cn("truncate text-xs", line.tone ?? "text-muted-foreground")}>
          {line.text}
        </p>
      </div>
      {needsAdapter || needsProgram ? (
        // positioned, so it sits above the stretched name and takes its own clicks
        <Button size="sm" variant="outline" className="relative" disabled={running || (needsAdapter && !h.extension)} onClick={onInstall}>
          {running ? <Loader className="animate-spin" /> : <Download />}
          {needsAdapter ? t("harness.installAdapter") : t("harness.download")}
        </Button>
      ) : (
        agents > 0 && <span className="text-muted-foreground shrink-0 text-xs tabular-nums">{t("harnesses.agentsOn", { count: agents })}</span>
      )}
      <ChevronRight className="text-muted-foreground size-3.5 shrink-0" />
      {running && (
        <div className="pointer-events-none absolute inset-x-3 bottom-0">
          <Progress value={null} className="h-0.5" />
        </div>
      )}
    </div>
  );
}

/**
 * Every harness Roster can drive and where each stands on this machine: the
 * first thing a fresh install sees. A row opens the harness's own page; one
 * that cannot run yet is fetched right in its row.
 */
export function HarnessOverview({
  view,
  ext,
  intro,
  onExtensions,
  onChanged,
  onRoute,
}: {
  view: ExecutorSettings;
  ext: ExtensionsView | null;
  /** first run: say what the steps are */
  intro: boolean;
  /** what an install call answered, shown before the next reload */
  onExtensions: (ext: ExtensionsView) => void;
  onChanged: () => void;
  onRoute: (r: SettingsRoute) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { t } = useI18n();

  const run = async (id: string, call: () => Promise<ExtResult>) => {
    setBusy(id);
    setError(null);
    const r = await call().catch((e: unknown) => ({ error: String(e) }) as ExtResult);
    setBusy(null);
    if (r.error) return setError(r.error);
    onExtensions(r);
    onChanged();
  };

  const refresh = async () => {
    setRefreshing(true);
    // one toast that each scan replaces, saying only that it ran: the rows show what was found
    const id = "detect";
    try {
      const r = await api.environment(true);
      if (r.error) {
        toast.error(t("detect.failed"), { id, description: r.error });
        return;
      }
      onChanged();
      if (r.shell.ok) toast.success(t("detect.done"), { id });
      else toast.warning(t("detect.doneShellSilent"), { id });
    } catch (e) {
      toast.error(t("detect.failed"), { id, description: String(e) });
    } finally {
      setRefreshing(false);
    }
  };

  const harnesses = ext?.harnesses ?? [];
  const env = ext?.environment ?? null;
  // agents whose harness Roster no longer has have no row to sit under
  const orphans = ext ? view.executors.filter((e) => !harnesses.some((h) => h.id === e.type)) : [];

  return (
    <Page>
      <PageHeader
        title={intro ? t("harnesses.introTitle") : t("settings.harnesses")}
        description={intro ? t("harnesses.intro") : t("harnesses.hint")}
        action={
          <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={refreshing}>
            <RefreshCw className={cn(refreshing && "animate-spin")} />
            {t("detect.again")}
          </Button>
        }
      />

      {/* a program on the user's PATH can read as missing when the shell kept quiet */}
      {env && !env.shell.ok && (
        <p className={cn("flex items-start gap-1.5 text-xs leading-relaxed", WARN_TEXT)}>
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
          {t("detect.shellSilent")}
        </p>
      )}

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <ListCard>
        {ext
          ? harnesses.map((h) => (
              <HarnessRow
                key={h.id}
                harness={h}
                custom={Boolean(view.programs[h.id])}
                job={ext.jobs.find((j) => j.id === h.id)}
                busy={busy === h.id}
                agents={view.executors.filter((e) => e.type === h.id).length}
                onOpen={() => onRoute({ page: "harness", id: h.id })}
                onInstall={() => void run(h.id, () => api.installExtension(h.id))}
              />
            ))
          : [0, 1, 2, 3].map((i) => (
              <div key={i} className={ROW}>
                <Skeleton className="size-9 rounded-[23%]" />
                <div className="flex-1 space-y-1.5">
                  <Skeleton className="h-3.5 w-1/4" />
                  <Skeleton className="h-3 w-1/6" />
                </div>
              </div>
            ))}
      </ListCard>

      {harnesses.some((h) => h.state.needed && !h.state.usable) && (
        <p className="text-muted-foreground flex items-start gap-1.5 text-xs leading-relaxed">
          <FolderDown className="mt-0.5 size-3 shrink-0" />
          {t("harnesses.installNote")}
        </p>
      )}

      {orphans.length > 0 && (
        <section className="space-y-2">
          <GroupLabel count={orphans.length}>{t("harnesses.orphansTitle")}</GroupLabel>
          <ListCard>
            {orphans.map((e) => (
              <ListRow
                key={e.id}
                onClick={() => onRoute({ page: "agent", id: e.id })}
                media={<ExecutorTile type={e.type} />}
                title={e.name}
                line={e.problem ?? e.type}
                warn
              />
            ))}
          </ListCard>
          <p className="text-muted-foreground px-1 text-xs leading-relaxed">{t("harnesses.orphansHint")}</p>
        </section>
      )}
    </Page>
  );
}

const DOT: Record<Tone, string> = {
  ok: "bg-emerald-500",
  warn: "bg-amber-500",
  bad: "bg-destructive",
  quiet: "bg-muted-foreground/30",
};

/** Rows under a status row start where its text does, past the dot. */
const INSET = "pr-4 pl-10.5";

/**
 * The first row of a section: a dot for how it stands, the state in words and
 * the one thing to do about it. While busy a spinner takes the dot's place and
 * a bar sweeps the foot of the row.
 */
function StatusRow({
  tone,
  busy,
  detail,
  action,
  children,
}: {
  tone: Tone;
  busy?: boolean;
  /** a quieter second line */
  detail?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="relative flex min-h-12 items-center gap-3 px-4 py-2">
      <span className="flex size-3.5 shrink-0 items-center justify-center">
        {busy ? <Loader className="text-muted-foreground size-3.5 animate-spin" /> : <span className={cn("size-2 rounded-full", DOT[tone])} />}
      </span>
      <div className="min-w-0 flex-1">
        <div className={cn("truncate text-sm", tone === "bad" && "text-destructive", busy && "text-muted-foreground")}>{children}</div>
        {detail && <div className="text-muted-foreground text-xs leading-relaxed">{detail}</div>}
      </div>
      {action && <div className="flex shrink-0 items-center gap-1.5">{action}</div>}
      {busy && (
        <div className="pointer-events-none absolute inset-x-4 bottom-0">
          <Progress value={null} className="h-0.5" />
        </div>
      )}
    </div>
  );
}

/**
 * The harness's program on this machine: which one runs and where it came
 * from, or what stands in the way with the fix beside it. A path set by hand
 * is taken at its word.
 */
function ProgramSection({
  harness: h,
  saved,
  job,
  busy,
  home,
  onInstall,
  onUpdate,
  onSelfUpdate,
  onChecked,
  onRemove,
  onSaved,
}: {
  harness: HarnessView;
  /** the program picked by hand, or empty */
  saved: string;
  job: InstallJob | undefined;
  /** a call about the program is on its way */
  busy: boolean;
  home: string;
  onInstall: () => void;
  onUpdate: () => void;
  /** runs the program's own updater */
  onSelfUpdate: () => void;
  /** its own update check came back, which the harness view now carries */
  onChecked: () => void;
  onRemove: () => void;
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(saved);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  useEffect(() => setDraft(saved), [saved]);

  const needsAdapter = h.adapter === "missing" || h.adapter === "error";
  const running = busy || job?.state === "running";
  const custom = saved !== "";
  const ready = !needsAdapter && (h.state.usable || custom);
  // only the copy Roster fetched is Roster's to fetch again or remove, and only while it is the one that runs
  const fetched = !custom && Boolean(h.state.installed && !h.state.detected);
  // a program found on this machine updates itself; one picked by hand is left alone
  const selfUpdates = Boolean(h.updatable) && !custom && !fetched && ready;
  const version = h.state.version ? t("harnesses.version", { version: h.state.version }) : t("harnesses.ready");

  // asked afresh as the page opens: what the app checked at launch may be hours old
  useEffect(() => {
    if (!selfUpdates) return;
    setChecking(true);
    void api.checkHarnessUpdate(h.id, true).finally(() => {
      setChecking(false);
      onChecked();
    });
  }, [h.id, selfUpdates]);

  const update = h.update;
  const updateFailed = job?.update === true && job.state === "failed";
  // with no word from its check, the updater itself says whether there was anything to fetch
  const updateAction = selfUpdates && (update?.available || updateFailed || (!update && !checking)) && (
    <Button size="sm" variant="outline" disabled={running} onClick={onSelfUpdate}>
      <CircleArrowUp />
      {update?.available ? t("harness.updateTo", { version: update.latest }) : t("harness.update")}
    </Button>
  );
  const updateDetail = !selfUpdates
    ? undefined
    : updateFailed
      ? <span className="text-destructive">{t("harness.updateFailed")}</span>
      : update?.available
        ? t("harness.updateAvailable", { version: update.latest })
        : update && t("harness.upToDate");

  const save = async (value: string) => {
    setSaving(true);
    setError(null);
    const r = await api.setProgram(h.id, value.trim()).catch((e: unknown) => ({ error: String(e) }));
    setSaving(false);
    if (r.error) return setError(r.error);
    setEditing(false);
    onSaved();
  };
  const cancel = () => {
    setEditing(false);
    setDraft(saved);
    setError(null);
  };

  const install = (label: string, disabled = false) => (
    <Button size="sm" variant="outline" disabled={running || disabled} onClick={onInstall}>
      <Download />
      {label}
    </Button>
  );

  const status: { tone: Tone; text: ReactNode; detail?: ReactNode; action?: ReactNode } = running
    ? { tone: "quiet", text: job?.log.at(-1) ?? (job?.update ? t("install.updating") : t("install.downloading")) }
    : h.adapter === "error"
      ? { tone: "bad", text: t("harness.status.adapterError"), detail: h.adapterError, action: h.extension && install(t("harness.installAdapter")) }
      : h.adapter === "missing"
        ? { tone: "warn", text: t("harness.status.noAdapter"), detail: t("harness.adapterMissingBody"), action: install(t("harness.installAdapter"), !h.extension) }
        : !h.state.needed
          ? { tone: "ok", text: `${version} · ${t("harness.from.bundled")}` }
          : custom
            ? { tone: "ok", text: t("harness.from.custom") }
            : h.state.usable
              ? {
                  tone: "ok",
                  text: `${version} · ${fetched ? t("harness.from.roster") : t("harness.from.machine")}`,
                  detail: updateDetail,
                  action: fetched ? (
                    <>
                      <Button size="sm" variant="outline" onClick={onUpdate}>
                        <RefreshCw />
                        {t("harness.downloadAgain")}
                      </Button>
                      <Button size="sm" variant="ghost" className="text-muted-foreground hover:text-destructive" onClick={onRemove}>
                        <Trash2 />
                        {t("harness.uninstall")}
                      </Button>
                    </>
                  ) : (
                    updateAction
                  ),
                }
              : job?.state === "failed"
                ? { tone: "bad", text: t("install.failed"), action: install(t("harness.download")) }
                : {
                    tone: "warn",
                    text: h.program
                      ? t.rich("harnesses.programMissing", { bin: <span className="font-mono">{h.program.bin}</span> })
                      : t("harness.status.noProgram"),
                    action: install(t("harness.download")),
                  };
  const path = custom ? saved : h.state.path;

  return (
    <Field>
      <FieldLabel>{t("harness.program")}</FieldLabel>
      <div className="divide-y rounded-xl border">
        <StatusRow tone={status.tone} busy={running} detail={status.detail} action={status.action}>
          {status.text}
        </StatusRow>
        {job?.state === "failed" && (!ready || job.update) && !running && (
          <pre className="text-muted-foreground max-h-40 overflow-auto px-4 py-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap">
            {job.log.join("\n") || t("install.noOutput")}
          </pre>
        )}
        {h.state.needed &&
          !needsAdapter &&
          !running &&
          (editing ? (
            <div className={cn("space-y-2 py-3", INSET)}>
              <Input
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void save(draft);
                  if (e.key === "Escape") cancel();
                }}
                placeholder={
                  h.state.path
                    ? t("harness.programEmptyUses", { path: tilde(h.state.path, home) })
                    : t("harness.programFullPath", { bin: h.program?.bin ?? t("harness.program") })
                }
                aria-label={t("harness.program")}
                spellCheck={false}
                className="font-mono text-xs"
              />
              {error && <p className="text-destructive text-xs">{error}</p>}
              <div className="flex justify-end gap-2">
                <Button size="sm" variant="ghost" onClick={cancel}>
                  {t("common.cancel")}
                </Button>
                <Button size="sm" disabled={saving || draft.trim() === saved} onClick={() => void save(draft)}>
                  {saving && <Loader className="animate-spin" />}
                  {t("common.save")}
                </Button>
              </div>
            </div>
          ) : (
            <div className={cn("flex min-h-11 items-center gap-3 py-1.5", INSET)}>
              {path ? (
                <span className="min-w-0 flex-1 truncate font-mono text-xs" title={path}>
                  {tilde(path, home)}
                </span>
              ) : (
                <span className="text-muted-foreground min-w-0 flex-1 truncate text-xs">{t("harness.elsewhere")}</span>
              )}
              {custom && (
                <Button size="sm" variant="ghost" className="text-muted-foreground" disabled={saving} onClick={() => void save("")}>
                  {t("harness.useDefault")}
                </Button>
              )}
              <Button size="sm" variant="ghost" className="text-muted-foreground" onClick={() => setEditing(true)}>
                {path ? t("harness.change") : t("harness.pickPath")}
              </Button>
            </div>
          ))}
      </div>
      {!editing && error && <p className="text-destructive text-xs">{error}</p>}
      {h.state.needed && !needsAdapter && !ready && <FieldDescription>{t("harnesses.installNote")}</FieldDescription>}
    </Field>
  );
}

function CopyCommand({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const { t } = useI18n();
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      className="text-muted-foreground"
      title={t("login.copyCommand")}
      aria-label={t("login.copyCommand")}
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {copied ? <Check className="text-emerald-600" /> : <Copy />}
    </Button>
  );
}

/** The harness's own sign-in on this machine: it belongs to the program, so every agent on the subscription shares it. */
function LoginSection({ type }: { type: string }) {
  // null while core asks the program
  const [login, setLogin] = useState<LoginState | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const { t } = useI18n();

  const read = (fresh: boolean) => {
    setLogin(null);
    void api.harnessLogin(type, fresh).then((r) => setLogin(r.error ? { state: "unknown", detail: r.error, methods: [] } : r));
  };
  useEffect(() => read(false), [type]);

  return (
    <Field>
      <FieldLabel>{t("login.title")}</FieldLabel>
      <div className="divide-y rounded-xl border">
        <StatusRow
          tone={login?.state === "ok" ? "ok" : login?.state === "none" ? "warn" : "quiet"}
          busy={!login}
          detail={login?.detail}
          action={
            <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={() => read(true)} disabled={!login}>
              <RefreshCw />
              {t("common.refresh")}
            </Button>
          }
        >
          {!login
            ? t("login.checking")
            : login.state === "ok"
              ? login.account
                ? t("login.signedInAs", { account: login.account })
                : t("login.signedIn")
              : login.state === "none"
                ? t("common.notSignedIn")
                : t("login.unknown")}
        </StatusRow>
        {login?.methods.map((m) => {
          const command = m.terminal ? [m.terminal.command, ...m.terminal.args].join(" ") : null;
          return (
            <div key={m.id} className={cn("flex items-center gap-3 py-2.5", INSET)}>
              <div className="min-w-0 flex-1 space-y-1">
                <div className="text-xs font-medium">{m.label}</div>
                {m.description && <p className="text-muted-foreground text-xs leading-relaxed">{m.description}</p>}
                {command && <code className="bg-muted block truncate rounded-md px-2 py-1 font-mono text-xs">{command}</code>}
              </div>
              {command ? (
                <CopyCommand text={command} />
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy === m.id}
                  onClick={() => {
                    setBusy(m.id);
                    void api.authenticate(type, m.id).then((r) => {
                      setBusy(null);
                      setLogin(r.error ? { state: "unknown", detail: r.error, methods: login.methods } : r);
                    });
                  }}
                >
                  {busy === m.id ? <Loader className="animate-spin" /> : <KeyRound />}
                  {t("login.signIn")}
                </Button>
              )}
            </div>
          );
        })}
      </div>
      {login?.state === "ok" ? (
        <FieldDescription>{t("login.credentials")}</FieldDescription>
      ) : (
        login?.methods.some((m) => m.terminal) && <FieldDescription>{t("login.terminalHint")}</FieldDescription>
      )}
    </Field>
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
        <TabsContent value="own" className="rounded-xl border px-4 py-3">
          <CapabilityNotes caps={own} />
        </TabsContent>
        <TabsContent value="endpoint" className="rounded-xl border px-4 py-3">
          <CapabilityNotes caps={endpoint} />
        </TabsContent>
      </Tabs>
    );
  }
  const caps = own ?? endpoint;
  if (!caps) return null;
  return (
    <div className="rounded-xl border px-4 py-3">
      <CapabilityNotes caps={caps} />
    </div>
  );
}

/**
 * One harness: its program on this machine, its own sign-in, the agents on it
 * and what it can do. It holds no agent of its own. What is set here -- the
 * program, the sign-in -- is the harness's, so every agent on it shares it.
 */
export function HarnessPanel({
  id,
  view,
  ext,
  home,
  onSaved,
  onChanged,
  onRoute,
}: {
  id: string;
  view: ExecutorSettings;
  ext: ExtensionsView | null;
  /** the home directory, so a path under it reads with ~ */
  home: string;
  /** the program path was set */
  onSaved: () => void;
  /** the harness's program was fetched or removed */
  onChanged: () => void;
  onRoute: (r: SettingsRoute) => void;
}) {
  const { t, list } = useI18n();
  const harness = ext?.harnesses.find((h) => h.id === id);
  const info = view.types.find((type) => type.type === id);
  const label = harness?.label ?? info?.label ?? id;
  const saved = view.programs[id] ?? "";
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState(false);

  const needsAdapter = harness?.adapter === "missing" || harness?.adapter === "error";
  const ready = Boolean(harness) && !needsAdapter && Boolean(harness?.state.usable || saved);
  const agents = view.executors.filter((e) => e.type === id);

  const run = async (call: () => Promise<ExtResult>) => {
    setBusy(true);
    setError(null);
    const r = await call().catch((e: unknown) => ({ error: String(e) }) as ExtResult);
    setBusy(false);
    if (r.error) return setError(r.error);
    onChanged();
  };

  return (
    <Page>
      <div className="flex items-start gap-4">
        <HarnessTile type={id} brand={harness?.brand} size="lg" absent={Boolean(harness) && !ready} />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-lg leading-snug font-semibold">{label}</h2>
          {harness?.description && <p className="text-muted-foreground mt-1 text-sm leading-relaxed">{harness.description}</p>}
        </div>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {!ext ? (
        <Skeleton className="h-12 w-full rounded-xl" />
      ) : (
        harness && (
          <ProgramSection
            harness={harness}
            saved={saved}
            job={ext.jobs.find((j) => j.id === id)}
            busy={busy}
            home={home}
            onInstall={() => void run(() => api.installExtension(id))}
            onUpdate={() => void run(() => api.updateExtension(id))}
            onSelfUpdate={() =>
              void run(async () => {
                const r = await api.updateHarness(id);
                const version = r.job?.state === "done" ? r.harnesses?.find((h) => h.id === id)?.state.version : undefined;
                if (version) toast.success(t("harness.updated", { version }));
                return r;
              })
            }
            onChecked={onChanged}
            onRemove={() => setRemoving(true)}
            onSaved={onSaved}
          />
        )
      )}

      {/* asking a program that is not there only says it is not there */}
      {info?.sources.own && ready && <LoginSection type={id} />}

      <Field>
        <div className="flex items-center justify-between gap-3">
          <FieldLabel>{t("harness.agents")}</FieldLabel>
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground -mr-2"
            disabled={!info}
            onClick={() => onRoute({ page: "agent", id: null, type: id })}
          >
            <Plus />
            {t("agent.new")}
          </Button>
        </div>
        {agents.length > 0 ? (
          <ListCard>
            {agents.map((e) => (
              <ListRow
                key={e.id}
                onClick={() => onRoute({ page: "agent", id: e.id })}
                media={<ExecutorTile type={e.type} brand={harness?.brand} />}
                title={e.name}
                line={e.problem ?? agentLine(t, view, label, e)}
                warn={e.problem !== null}
              />
            ))}
          </ListCard>
        ) : (
          <p className="text-muted-foreground text-sm">{info?.sources.own ? t("harness.noAgentsOwn") : t("harness.noAgents")}</p>
        )}
      </Field>

      {info && (
        <Field>
          <FieldLabel>{t("harness.capabilities")}</FieldLabel>
          <CapabilitiesOf type={info} />
          {info.sources.apis.length > 0 && (
            <FieldDescription>{t("harness.protocols", { protocols: list(info.sources.apis.map((a) => apiLabel(t, a))) })}</FieldDescription>
          )}
        </Field>
      )}

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
    </Page>
  );
}
