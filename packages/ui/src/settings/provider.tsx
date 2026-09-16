import { useEffect, useMemo, useRef, useState } from "react";
import { KeyRound, Loader, Lock, LockOpen, Plus, RefreshCw, ScanSearch, Search } from "lucide-react";
import {
  api,
  CUSTOM_PRESET,
  type CredentialHint,
  type Environment,
  type ExecutorRecord,
  type ExecutorSettings,
  type HarnessTypeInfo,
  type ModelProbe,
  type ProviderPreset,
  type ProviderRecord,
} from "../api";
import { useI18n } from "../i18n";
import { ProviderIcon } from "../provider-icon";
import { API_BRAND, API_IDS, apiLabel, apiShort, brandFromText, ExecutorTile, Mark, PresetTile, providerKind, ProviderTile } from "../tiles";
import {
  ConfirmDelete,
  EditorFrame,
  EmptyNote,
  keyLine,
  keystoreName,
  ListCard,
  ListRow,
  Page,
  PageHeader,
  presetsOf,
  type SettingsRoute,
} from "./shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";

/** Protocols a hand-entered endpoint can speak; the rest need cloud setup a key alone does not cover. */
const CUSTOM_APIS = API_IDS;

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

/** Keys this machine already has for vendors not added yet: the shortest way to something that works. */
function suggestionsOf(view: ExecutorSettings, env: Environment | null, presets: readonly ProviderPreset[]): CredentialHint[] {
  return (env?.hints ?? []).filter(
    (h) => h.kind === "env" && presets.some((p) => p.id === h.preset) && !view.providers.some((p) => p.preset === h.preset),
  );
}

function FoundKeys({
  presets,
  suggestions,
  onPick,
}: {
  presets: readonly ProviderPreset[];
  suggestions: readonly CredentialHint[];
  onPick: (preset: string, keyEnv: string) => void;
}) {
  const { t } = useI18n();
  return (
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
              <Button size="sm" variant="outline" onClick={() => onPick(p.id, h.name)}>
                {t("preset.addWithIt")}
              </Button>
            </div>
          );
        })}
      </div>
    </Field>
  );
}

/** Where keys end up on this machine, said once at the foot of the page that collects them. */
function VaultNote({ vault }: { vault: ExecutorSettings["vault"] }) {
  const { t } = useI18n();
  return (
    <p className="text-muted-foreground flex items-start gap-1.5 text-xs leading-relaxed">
      {vault.encrypted ? <Lock className="mt-0.5 size-3 shrink-0" /> : <LockOpen className="mt-0.5 size-3 shrink-0 text-amber-600" />}
      {vault.encrypted ? t("vault.encrypted", { keystore: keystoreName(t, vault.keystore) }) : t("vault.plain")}
    </p>
  );
}

/** Every model API, each with where its key comes from and how many agents draw on it. */
export function ProviderOverview({
  view,
  env,
  onRoute,
}: {
  view: ExecutorSettings;
  env: Environment | null;
  onRoute: (r: SettingsRoute) => void;
}) {
  const { t } = useI18n();
  const presets = useMemo(() => presetsOf(view), [view]);
  const suggestions = suggestionsOf(view, env, presets);
  const agentsOn = (id: string) => view.executors.filter((e) => e.provider_id === id).length;
  return (
    <Page>
      <PageHeader
        title={t("settings.provider")}
        description={t("providers.hint")}
        action={
          <Button size="sm" onClick={() => onRoute({ page: "provider", id: null })}>
            <Plus />
            {t("provider.add")}
          </Button>
        }
      />
      {view.providers.length === 0 ? (
        <EmptyNote>{t("providers.empty")}</EmptyNote>
      ) : (
        <ListCard>
          {view.providers.map((p) => {
            const n = agentsOn(p.id);
            return (
              <ListRow
                key={p.id}
                onClick={() => onRoute({ page: "provider", id: p.id })}
                media={<ProviderTile provider={p} />}
                title={p.name}
                line={`${providerKind(t, p, presets)} · ${keyLine(t, p)}`}
                warn={!p.key.set}
                end={n > 0 ? t("providers.agentsOn", { count: n }) : undefined}
              />
            );
          })}
        </ListCard>
      )}
      {suggestions.length > 0 && (
        <FoundKeys presets={presets} suggestions={suggestions} onPick={(preset, keyEnv) => onRoute({ page: "provider", id: null, preset, keyEnv })} />
      )}
      <VaultNote vault={view.vault} />
    </Page>
  );
}

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
      {suggestions.length > 0 && <FoundKeys presets={presets} suggestions={suggestions} onPick={onPick} />}

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
  start,
  env,
  onSaved,
  onCancel,
  onDeleted,
}: {
  view: ExecutorSettings;
  provider: ProviderRecord | null;
  /** a new one opened on a key found on this machine, past the picker */
  start?: { preset: string; keyEnv?: string };
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
  const [preset, setPreset] = useState(provider?.preset ?? start?.preset ?? "");
  const [name, setName] = useState(provider?.name ?? "");
  const [apiId, setApiId] = useState(provider?.api ?? "openai-completions");
  const [baseUrl, setBaseUrl] = useState(provider?.base_url ?? "");
  const [models, setModels] = useState((provider?.models ?? []).join("\n"));
  const [keySource, setKeySource] = useState<"stored" | "env">(provider?.key.source ?? (start?.keyEnv ? "env" : "stored"));
  const [key, setKey] = useState("");
  const [keyEnv, setKeyEnv] = useState(provider?.key_env ?? start?.keyEnv ?? "");
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
  const suggestions = suggestionsOf(view, env, presets);
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
