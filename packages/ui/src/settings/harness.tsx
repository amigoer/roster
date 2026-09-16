import { useEffect, useState } from "react";
import { Check, ChevronRight, Copy, Download, KeyRound, Loader, Plus, RefreshCw, ScanSearch, Trash2 } from "lucide-react";
import { toast } from "sonner";
import {
  api,
  type DetectedProgram,
  type Environment,
  type ExecutorSettings,
  type ExtensionsView,
  type HarnessTypeInfo,
  type HarnessView,
  type InstallJob,
  type LoginState,
} from "../api";
import { CapabilityNotes } from "../capabilities";
import { useI18n, type I18n } from "../i18n";
import { apiLabel, ExecutorTile, HarnessTile, StatusBadge } from "../tiles";
import { EditorFrame, harnessStatus, ListCard, ListRow, Page, PageHeader, sourceName, type SettingsRoute } from "./shared";
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
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

type ExtResult = ExtensionsView & { error?: string };

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
 * fresh install sees. A card opens the harness's own page; the one missing its
 * program can be fetched right here.
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
  const i18n = useI18n();
  const { t } = i18n;

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
    const before = ext?.environment?.programs;
    const label = (id: string) => ext?.harnesses.find((h) => h.id === id)?.label ?? id;
    try {
      const r = await api.environment(true);
      if (r.error) {
        toast.error(t("detect.failed"), { description: r.error });
        return;
      }
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
    <Page>
      <PageHeader
        title={intro ? t("harnesses.introTitle") : t("settings.harnesses")}
        description={intro ? t("harnesses.intro") : t("harnesses.hint")}
      />

      <EnvironmentCard env={env} refreshing={refreshing} onRefresh={() => void refresh()} harnesses={harnesses} />

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <div className="space-y-2">
        {!ext &&
          [0, 1, 2].map((i) => (
            <div key={i} className="flex items-center gap-4 rounded-xl border p-4">
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
          const open = () => onRoute({ page: "harness", id: h.id });
          return (
            // a div, not a button: the card holds the download button, and nesting buttons is invalid markup
            <div
              key={h.id}
              role="button"
              tabIndex={0}
              onClick={open}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  open();
                }
              }}
              className="hover:bg-accent/50 focus-visible:ring-ring/50 flex items-start gap-4 rounded-xl border p-4 text-left transition-colors outline-none focus-visible:ring-2"
            >
              <HarnessTile type={h.id} brand={h.brand} size="lg" />
              <div className="min-w-0 flex-1 space-y-1.5">
                <div className="flex flex-wrap items-center gap-1.5 text-sm leading-snug font-medium">
                  {h.label}
                  {status && <StatusBadge tone={status.tone}>{status.text}</StatusBadge>}
                </div>
                <p className="text-muted-foreground text-sm leading-relaxed">{h.description}</p>
                {h.adapterError && <p className="text-destructive text-xs">{h.adapterError}</p>}
                {needsProgram && h.program && (
                  <p className="text-muted-foreground text-xs">
                    {t.rich("harnesses.programMissing", { bin: <span className="font-mono">{h.program.bin}</span> })}
                  </p>
                )}
                {job && <JobLine job={job} />}
              </div>
              <div className="flex shrink-0 items-center gap-2 self-center">
                {(needsAdapter || needsProgram) && (
                  <Button
                    size="sm"
                    disabled={running || (needsAdapter && !h.extension)}
                    onClick={(e) => {
                      e.stopPropagation();
                      void run(h.id, () => api.installExtension(h.id));
                    }}
                  >
                    {running ? <Loader className="animate-spin" /> : <Download />}
                    {needsAdapter ? t("harness.installAdapter") : t("harness.download")}
                  </Button>
                )}
                <ChevronRight className="text-muted-foreground size-4" />
              </div>
            </div>
          );
        })}
      </div>

      {orphans.length > 0 && (
        <div className="space-y-2">
          <div>
            <h3 className="text-sm font-medium">{t("harnesses.orphansTitle")}</h3>
            <p className="text-muted-foreground mt-0.5 text-xs leading-relaxed">{t("harnesses.orphansHint")}</p>
          </div>
          <ListCard>
            {orphans.map((e) => (
              <ListRow
                key={e.id}
                onClick={() => onRoute({ page: "agent", id: e.id })}
                media={<ExecutorTile type={e.type} size="sm" />}
                title={e.name}
                end={e.type}
              />
            ))}
          </ListCard>
        </div>
      )}
    </Page>
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
  onRoute,
}: {
  id: string;
  view: ExecutorSettings;
  ext: ExtensionsView | null;
  onSaved: () => void;
  /** the harness's program was fetched or removed */
  onChanged: () => void;
  onCancel: () => void;
  onRoute: (r: SettingsRoute) => void;
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

  const run = async (call: () => Promise<ExtResult>) => {
    setBusy(true);
    setError(null);
    const r = await call().catch((e: unknown) => ({ error: String(e) }) as ExtResult);
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
                media={<ExecutorTile type={e.type} brand={harness?.brand} size="sm" />}
                title={e.name}
                end={sourceName(t, view, e)}
              />
            ))}
          </ListCard>
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
