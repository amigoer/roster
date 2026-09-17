import { useEffect, useState } from "react";
import { Plus } from "lucide-react";
import {
  api,
  type Bot,
  type CheckItem,
  type ExecutorRecord,
  type ExecutorSettings,
  type ExtensionsView,
  type ModelOption,
  type SourceKind,
} from "../api";
import { BotAvatar } from "../bot-avatar";
import { CapabilityNotes } from "../capabilities";
import { byHarness } from "../executors";
import { useI18n } from "../i18n";
import { ExecutorTile, HarnessTile, StatusBadge } from "../tiles";
import {
  agentLine,
  CheckResult,
  Choice,
  ConfirmDelete,
  EditorFrame,
  EmptyNote,
  fits,
  GroupLabel,
  harnessStatus,
  ListCard,
  ListRow,
  Page,
  PageHeader,
  sourceName,
  type SettingsRoute,
} from "./shared";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FieldContent, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { RadioGroup } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Every agent, grouped by the harness it runs on. A row says where its models
 * come from and how many bots run on it; one that cannot run says why instead.
 */
export function AgentOverview({
  view,
  ext,
  bots,
  onRoute,
}: {
  view: ExecutorSettings;
  ext: ExtensionsView | null;
  bots: readonly Bot[];
  onRoute: (r: SettingsRoute) => void;
}) {
  const { t } = useI18n();
  const harnessOf = (type: string) => ext?.harnesses.find((h) => h.id === type);
  const labelOf = (type: string) => harnessOf(type)?.label ?? view.types.find((x) => x.type === type)?.label ?? type;
  // a harness neither loaded nor known to this build has no page; its agents still list, and say so
  const known = (type: string) => Boolean(harnessOf(type)) || view.types.some((x) => x.type === type);
  const botsOn = (id: string) => bots.filter((b) => !b.archived_at && b.executor_id === id).length;

  return (
    <Page>
      <PageHeader
        title={t("settings.agent")}
        description={t("agents.hint")}
        action={
          <Button size="sm" onClick={() => onRoute({ page: "agent", id: null })}>
            <Plus />
            {t("agent.new")}
          </Button>
        }
      />
      {view.executors.length === 0 ? (
        <EmptyNote>{t("agents.empty")}</EmptyNote>
      ) : (
        byHarness(view.executors).map(([type, agents]) => (
          <section key={type} className="space-y-2">
            <GroupLabel count={agents.length} badge={!known(type) && <StatusBadge tone="warn">{t("agents.harnessGone")}</StatusBadge>}>
              {labelOf(type)}
            </GroupLabel>
            <ListCard>
              {agents.map((e) => {
                const n = botsOn(e.id);
                return (
                  <ListRow
                    key={e.id}
                    onClick={() => onRoute({ page: "agent", id: e.id })}
                    media={<ExecutorTile type={e.type} brand={harnessOf(e.type)?.brand} />}
                    title={e.name}
                    line={e.problem ?? agentLine(t, view, labelOf(e.type), e)}
                    warn={e.problem !== null}
                    end={n > 0 ? t("agents.botsOn", { count: n }) : undefined}
                  />
                );
              })}
            </ListCard>
          </section>
        ))
      )}
    </Page>
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
  onRoute,
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
  onRoute: (r: SettingsRoute) => void;
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
  const [longCache, setLongCache] = useState(executor?.long_cache === 1);
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
      long_cache: longCache,
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
            {/* a harness Roster knows opens on its own page, where the download is; one it does not is looked for on the overview */}
            {!info && (
              <Button variant="link" size="xs" className="h-auto p-0" onClick={() => onRoute(harness ? { page: "harness", id: harness.id } : { page: "harness" })}>
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
              <Button variant="link" size="xs" className="h-auto p-0" onClick={() => onRoute({ page: "harness" })}>
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
                <Button variant="link" size="xs" className="h-auto p-0" onClick={() => onRoute({ page: "provider", id: null })}>
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

      {/* only harnesses that can pass the choice on: the ACP ones run their own requests */}
      {(type === "claude-code" || type === "pi-agent") && (
        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor="agent-long-cache">{t("agent.longCache")}</FieldLabel>
            <FieldDescription>{t("agent.longCacheHint")}</FieldDescription>
          </FieldContent>
          <Switch id="agent-long-cache" checked={longCache} onCheckedChange={setLongCache} />
        </Field>
      )}

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
