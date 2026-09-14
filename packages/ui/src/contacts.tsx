import { Fragment, useContext, useEffect, useMemo, useState } from "react";
import { Archive, Eye, MessageCircle, Pencil, Plus, Shuffle, Trash2, Users } from "lucide-react";
import {
  activeMembers,
  api,
  type Bot,
  type BotInput,
  type Candidate,
  type Capabilities,
  type Conversation,
  type Logo,
  type ModelOption,
  type Presence,
  type Tier,
} from "./api";
import { BotAvatar, GroupAvatar, LogoImage, logoOf, TIER_LABEL, useLogos, type Busy } from "./bot-avatar";
import { CapabilityNotes } from "./capabilities";
import { DeleteConversation, RenameInput } from "./conversation-menu";
import { byHarness, Executors, HarnessLabels, useExecutor } from "./executors";
import { LIST_BODY, ListSearch, ROW, rowState, SectionLabel } from "./list";
import { Markdown } from "./markdown";
import { MemberSections, MODES } from "./members-panel";
import { leaderOf } from "./mentions";
import { ProviderIcon, providerOf } from "./provider-icon";
import { TEMPLATES, type Template } from "./templates";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

/** What the contacts column has open; a group opens to its profile, and only its message button enters the chat. */
export type Contact = { kind: "bot" | "group"; id: string };

export function ContactList({
  bots,
  convs,
  busyByBot,
  selected,
  onSelect,
}: {
  bots: Bot[];
  convs: Conversation[];
  busyByBot: Record<string, Busy>;
  selected: Contact | null;
  onSelect: (contact: Contact) => void;
}) {
  const [query, setQuery] = useState("");
  const executor = useExecutor();
  const isSelected = (kind: Contact["kind"], id: string) => selected?.kind === kind && selected.id === id;
  const q = query.trim().toLowerCase();
  const shownBots = q
    ? bots.filter((b) => b.name.toLowerCase().includes(q) || (b.title ?? "").toLowerCase().includes(q))
    : bots;
  const groups = convs.filter((c) => c.shape === "group" && !c.archived && (!q || c.title.toLowerCase().includes(q)));

  return (
    <>
      <ListSearch value={query} onChange={setQuery} placeholder="搜索 bot 或群聊" />
      <ScrollArea className="min-h-0 flex-1 [mask-image:linear-gradient(to_bottom,transparent,black_0.5rem)]">
        <div className={LIST_BODY}>
          <SectionLabel>Bot · {shownBots.length}</SectionLabel>
          {bots.length === 0 && (
            <p className="text-muted-foreground px-2.5 py-4 text-sm">还没有 bot。在右边挑一个角色建一个。</p>
          )}
          {shownBots.map((b) => (
            <button
              key={b.id}
              onClick={() => onSelect({ kind: "bot", id: b.id })}
              className={cn(ROW, rowState(isSelected("bot", b.id)))}
            >
              <BotAvatar bot={b} busy={busyByBot[b.id] ?? null} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{b.name}</div>
                <div className="text-muted-foreground truncate text-xs">
                  {b.title ?? `${executor(b.executor_id).label} · ${b.model ?? executor(b.executor_id).model ?? "默认模型"}`}
                </div>
              </div>
            </button>
          ))}
          {groups.length > 0 && (
            <>
              <SectionLabel>群聊 · {groups.length}</SectionLabel>
              {groups.map((c) => {
                const members = activeMembers(c);
                return (
                  <button
                    key={c.id}
                    onClick={() => onSelect({ kind: "group", id: c.id })}
                    className={cn(ROW, rowState(isSelected("group", c.id)))}
                  >
                    <GroupAvatar bots={members.map((m) => m.bot)} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">{c.title}</div>
                      <div className="text-muted-foreground truncate text-xs">
                        {members.map((m) => m.bot.name).join("、") || "没有成员"}
                      </div>
                    </div>
                  </button>
                );
              })}
            </>
          )}
        </div>
      </ScrollArea>
    </>
  );
}

/** The Grok-style roster start: pick a role, then make it yours. */
export function TemplateGallery({ onPick }: { onPick: (t: Template | null) => void }) {
  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="mx-auto max-w-3xl px-8 py-10">
        <h2 className="text-lg font-semibold">建一个 Bot</h2>
        <p className="text-muted-foreground mt-1 text-sm">
          挑一个角色开始，名字、设定和权限都可以再改。建好的 bot 能单聊，也能拉进群里和别的 bot 一起干活。
        </p>
        <div className="mt-6 grid grid-cols-[repeat(auto-fill,minmax(210px,1fr))] gap-2.5">
          <button
            onClick={() => onPick(null)}
            className="hover:bg-accent/50 flex items-center gap-3 rounded-xl border border-dashed p-3 text-left transition-colors"
          >
            <span className="bg-muted inline-flex size-9 items-center justify-center rounded-[30%]">
              <Plus className="size-4" />
            </span>
            <span>
              <span className="block text-sm font-medium">空白 Bot</span>
              <span className="text-muted-foreground block text-xs">从零写设定</span>
            </span>
          </button>
          {TEMPLATES.map((t) => (
            <button
              key={t.id}
              onClick={() => onPick(t)}
              className="hover:bg-accent/50 flex items-center gap-3 rounded-xl border p-3 text-left transition-colors"
            >
              <BotAvatar bot={{ id: t.id, avatar: t.avatar }} />
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium">{t.name}</span>
                <span className="text-muted-foreground block truncate text-xs">{t.title}</span>
              </span>
              <Badge variant="outline" className="ml-auto shrink-0 px-1.5 py-0 text-[10px] font-normal">
                {TIER_LABEL[t.permission_tier]?.label}
              </Badge>
            </button>
          ))}
        </div>
      </div>
    </ScrollArea>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-7">
      <h3 className="text-muted-foreground mb-2 text-xs font-medium">{title}</h3>
      {children}
    </section>
  );
}

export function BotProfile({
  bot,
  caps,
  convs,
  busy,
  onEdit,
  onMessage,
  onGroup,
  onOpenConversation,
  onDeleted,
}: {
  bot: Bot;
  caps: Record<string, Capabilities>;
  convs: Conversation[];
  busy: Busy;
  onEdit: () => void;
  /** may create the chat first; a second click meanwhile would create another */
  onMessage: () => Promise<void>;
  onGroup: () => void;
  onOpenConversation: (id: string) => void;
  onDeleted: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [opening, setOpening] = useState(false);
  const executor = useExecutor()(bot.executor_id);
  const botCaps = caps[bot.executor_id];
  const joined = convs.filter((c) => !c.archived && activeMembers(c).some((m) => m.bot.id === bot.id));
  const tier = TIER_LABEL[bot.permission_tier];

  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="mx-auto max-w-2xl px-8 py-10">
        {/* wraps rather than squeezing the name into a one-character column in a narrow pane */}
        <div className="flex flex-wrap items-start gap-5">
          <BotAvatar bot={bot} size="xl" busy={busy} />
          <div className="min-w-48 flex-1 pt-1">
            <h2 className="truncate text-xl font-semibold">{bot.name}</h2>
            <p className="text-muted-foreground mt-0.5 text-sm">{bot.title ?? "还没写职责"}</p>
            <div className="mt-2.5 flex flex-wrap gap-1.5">
              <Badge variant="outline" className="font-normal">
                <ProviderIcon provider={providerOf(bot, executor.type)} />
                {executor.label} · {bot.model ?? executor.model ?? "默认模型"}
              </Badge>
              <Badge variant="outline" className="font-normal">
                {tier?.label}
              </Badge>
              {busy && (
                <Badge variant="secondary" className="font-normal">
                  {busy === "needs_you" ? "在等你批准" : "正在干活"}
                </Badge>
              )}
            </div>
          </div>
        </div>

        <div className="mt-6 flex flex-wrap gap-2">
          <Button
            size="sm"
            disabled={opening}
            onClick={() => {
              setOpening(true);
              void onMessage().finally(() => setOpening(false));
            }}
          >
            <MessageCircle />
            发消息
          </Button>
          <Button size="sm" variant="outline" onClick={onGroup}>
            <Users />
            拉群
          </Button>
          <Button size="sm" variant="outline" onClick={onEdit}>
            <Pencil />
            编辑
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="text-muted-foreground hover:text-destructive ml-auto"
            onClick={() => setConfirming(true)}
          >
            <Trash2 />
            删除
          </Button>
        </div>

        <Section title="设定">
          {bot.system_prompt ? (
            <div className="bg-muted/50 rounded-lg border px-4 py-3">
              <Markdown>{bot.system_prompt}</Markdown>
            </div>
          ) : (
            <p className="text-muted-foreground text-sm">没有设定，按 agent 默认的方式工作。</p>
          )}
        </Section>

        <Section title="权限">
          <p className="text-sm">
            <span className="font-medium">{tier?.label}</span>
            <span className="text-muted-foreground">
              {" · "}
              {botCaps?.permissionModes ? "新会话从这一档对应的权限模式开始，会话里可以在输入框下方切换" : tier?.hint}
            </span>
          </p>
        </Section>

        {botCaps && (
          <Section title={`${executor.label} 能做什么`}>
            <CapabilityNotes caps={botCaps} />
          </Section>
        )}

        <Section title={`所在会话 · ${joined.length}`}>
          {joined.length === 0 ? (
            <p className="text-muted-foreground text-sm">还没参与任何会话。</p>
          ) : (
            <div className="-mx-2">
              {joined.map((c) => (
                <button
                  key={c.id}
                  onClick={() => onOpenConversation(c.id)}
                  className="hover:bg-accent/50 flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left"
                >
                  {c.shape === "group" ? (
                    <GroupAvatar bots={activeMembers(c).map((m) => m.bot)} />
                  ) : (
                    <BotAvatar bot={bot} />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm">{c.title}</span>
                    <span className="text-muted-foreground block truncate font-mono text-[11px]">{c.repo_path}</span>
                  </span>
                  {c.shape === "group" && (
                    <Badge variant="secondary" className="px-1 py-0 text-[10px]">
                      群
                    </Badge>
                  )}
                </button>
              ))}
            </div>
          )}
        </Section>
      </div>

      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除「{bot.name}」？</AlertDialogTitle>
            <AlertDialogDescription>
              它会从通讯录里消失，不能再被拉进新的会话。已经在群里的它会照常工作，聊天记录也都保留。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                void api.deleteBot(bot.id).then(onDeleted);
              }}
            >
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </ScrollArea>
  );
}

export function GroupProfile({
  conv,
  bots,
  presence,
  busy,
  onMessage,
  onOpenBot,
  onGone,
}: {
  conv: Conversation;
  bots: Bot[];
  presence: Record<string, Presence>;
  busy: Busy;
  onMessage: () => void;
  onOpenBot: (botId: string) => void;
  /** archived or deleted */
  onGone: (id: string) => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const members = activeMembers(conv);
  const mode = MODES.find((m) => m.id === conv.mode);

  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="mx-auto max-w-2xl px-8 py-10">
        <div className="flex flex-wrap items-start gap-5">
          <GroupAvatar bots={members.map((m) => m.bot)} size="xl" busy={busy} />
          <div className="min-w-48 flex-1 pt-1">
            {/* both pad the text by the same amount, so it does not jump when the field swaps in */}
            {renaming ? (
              <RenameInput conv={conv} className="-ml-1.5 text-xl" onDone={() => setRenaming(false)} />
            ) : (
              <h2
                onClick={() => setRenaming(true)}
                title="点击重命名"
                className="hover:bg-accent -ml-1.5 w-fit max-w-full cursor-text truncate rounded px-1.5 py-0.5 text-xl font-semibold"
              >
                {conv.title}
              </h2>
            )}
            <p className="text-muted-foreground mt-0.5 text-sm">{members.map((m) => m.bot.name).join("、") || "没有成员"}</p>
            <div className="mt-2.5 flex flex-wrap gap-1.5">
              {mode && (
                <Badge variant="outline" className="font-normal">
                  <mode.icon />
                  {mode.label}
                  {conv.mode === "leader" && ` · 群主 ${leaderOf(conv)?.bot.name ?? "-"}`}
                </Badge>
              )}
              {busy && (
                <Badge variant="secondary" className="font-normal">
                  {busy === "needs_you" ? "在等你批准" : "正在干活"}
                </Badge>
              )}
            </div>
          </div>
        </div>

        <div className="mt-6 flex flex-wrap gap-2">
          <Button size="sm" onClick={onMessage}>
            <MessageCircle />
            发消息
          </Button>
          <Button size="sm" variant="outline" onClick={() => setRenaming(true)}>
            <Pencil />
            重命名
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="text-muted-foreground ml-auto"
            onClick={() => void api.archive(conv.id, true).then(() => onGone(conv.id))}
          >
            <Archive />
            归档
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="text-muted-foreground hover:text-destructive"
            onClick={() => setConfirming(true)}
          >
            <Trash2 />
            删除
          </Button>
        </div>

        <MemberSections conv={conv} bots={bots} presence={presence} onOpenBot={onOpenBot} className="mt-7 space-y-7" />

        <Section title="工作目录">
          <p className="font-mono text-xs wrap-anywhere">
            {/* a narrow column breaks after a separator, not inside a directory name */}
            {conv.repo_path.split(/(?<=[\\/])/).map((part, i) => (
              <Fragment key={i}>
                {part}
                <wbr />
              </Fragment>
            ))}
          </p>
        </Section>
      </div>

      <DeleteConversation conv={conv} open={confirming} onOpenChange={setConfirming} onDeleted={onGone} />
    </ScrollArea>
  );
}

let modelsOnce: Promise<Record<string, ModelOption[]>> | null = null;

/** Agents or their model APIs changed, so the models they offer did too. */
export function forgetModels(): void {
  modelsOnce = null;
}

/** Fetched once until agents change: an agent on its own sign-in is started to answer. */
function useModels(key: string) {
  const [models, setModels] = useState<Record<string, ModelOption[]>>({});
  useEffect(() => {
    modelsOnce ??= api
      .models()
      .then((r) => r.models)
      .catch(() => ({}));
    void modelsOnce.then(setModels);
  }, [key]);
  return models;
}

const LAST_BACKEND = "roster.lastBackend";

/** Select values that are not a model id: the agent's default, and typing one in. */
const DEFAULT_MODEL = "@default";
const CUSTOM_MODEL = "@custom";
/** An agent that does not exist yet, as a select value: picking it makes it. */
const NEW_AGENT = "@new:";
const candidateValue = (c: Candidate) => `${NEW_AGENT}${c.type}|${c.source_kind}|${c.provider_id ?? ""}`;

/** Two bots in one face are hard to tell apart, so a role's logo yields to one nobody wears. */
function freeLogo(preferred: string | null, logos: readonly Logo[], bots: Bot[], selfId?: string): string | null {
  const worn = new Map<string, number>();
  for (const b of bots) if (b.id !== selfId && b.avatar) worn.set(b.avatar, (worn.get(b.avatar) ?? 0) + 1);
  if (preferred && !worn.has(preferred)) return preferred;
  if (logos.length === 0) return preferred;
  return logos.reduce((best, l) => ((worn.get(l.id) ?? 0) < (worn.get(best.id) ?? 0) ? l : best), logos[0]!).id;
}

/** The whole set at once: picking a face is easier by eye than by name. */
function LogoPicker({
  value,
  onChange,
  bots,
  selfId,
}: {
  value: string | null;
  onChange: (id: string) => void;
  bots: Bot[];
  selfId?: string;
}) {
  const logos = useLogos();
  const wornBy = new Map<string, string[]>();
  for (const b of bots) {
    if (b.id !== selfId && b.avatar) wornBy.set(b.avatar, [...(wornBy.get(b.avatar) ?? []), b.name]);
  }
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(2.5rem,1fr))] gap-2">
      {logos.map((l) => {
        const worn = wornBy.get(l.id);
        const on = value === l.id;
        return (
          <button
            key={l.id}
            type="button"
            onClick={() => onChange(l.id)}
            title={worn ? `${l.name} · ${worn.join("、")} 在用` : l.name}
            aria-label={l.name}
            aria-pressed={on}
            className={cn(
              "ring-offset-background rounded-[23%] ring-offset-2 transition outline-none focus-visible:ring-2 focus-visible:ring-ring",
              on ? "ring-foreground ring-2" : worn ? "opacity-40 hover:opacity-100" : "hover:-translate-y-0.5",
            )}
          >
            <LogoImage logo={l} className="aspect-square w-full" />
          </button>
        );
      })}
    </div>
  );
}

/** Two bots cannot share a name, since @name has to mean exactly one of them. */
function freeName(name: string, bots: Bot[], selfId?: string): string {
  const taken = (n: string) => bots.some((b) => b.id !== selfId && b.name.toLowerCase() === n.toLowerCase());
  if (!taken(name)) return name;
  for (let i = 2; ; i++) if (!taken(`${name}${i}`)) return `${name}${i}`;
}

export function BotEditor({
  bot,
  template,
  bots,
  caps,
  onManageAgents,
  onCancel,
  onSaved,
}: {
  /** null creates a new bot */
  bot: Bot | null;
  template: Template | null;
  bots: Bot[];
  caps: Record<string, Capabilities>;
  /** opens the agent the form is on in settings; null opens a new one */
  onManageAgents: (executorId: string | null) => void;
  onCancel: () => void;
  onSaved: (bot: Bot) => void;
}) {
  const executor = useExecutor();
  const harnessLabels = useContext(HarnessLabels);
  // only agents that can run: the agent carries the source, so a broken one would carry the bot down with it
  const agents = useContext(Executors).filter((e) => e.problem === null);
  const models = useModels(agents.map((e) => e.id).join());
  const logos = useLogos();
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [form, setForm] = useState<BotInput>(() => {
    if (bot) {
      const { name, title, avatar, system_prompt, executor_id, model, permission_tier } = bot;
      return { name, title, avatar: logoOf(bot, logos)?.id ?? avatar, system_prompt, executor_id, model, permission_tier };
    }
    // a new bot starts on whatever agent the last one was made with; older saves still say backend
    type Last = { executor_id?: string; backend?: string; model: string | null } | null;
    let last: Last = null;
    try {
      last = JSON.parse(localStorage.getItem(LAST_BACKEND) ?? "null") as Last;
    } catch {
      // no memory of a previous choice is fine
    }
    const usable = (id: string | undefined) => (id && agents.some((e) => e.id === id) ? id : undefined);
    const recent = bots.at(-1);
    const lastId = last?.executor_id ?? last?.backend;
    const executor_id = usable(lastId) ?? usable(recent?.executor_id) ?? agents[0]?.id ?? "";
    const from = last && lastId === executor_id ? last : recent && recent.executor_id === executor_id ? recent : null;
    return {
      name: template ? freeName(template.name, bots) : "",
      title: template?.title ?? null,
      avatar: freeLogo(template?.avatar ?? null, logos, bots),
      system_prompt: template?.system_prompt ?? null,
      executor_id,
      model: from?.model ?? null,
      permission_tier: template?.permission_tier ?? "read",
    };
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** a setting is written as Markdown, and a long one is easier to check rendered */
  const [preview, setPreview] = useState(false);
  /** typing a model id the list does not have */
  const [customModel, setCustomModel] = useState(false);

  const set = <K extends keyof BotInput>(key: K, value: BotInput[K]) => setForm((f) => ({ ...f, [key]: value }));

  // pairings of harness and source with no agent yet, offered right in the list so a bot never waits on settings
  const agentsKey = agents.map((e) => e.id).join();
  useEffect(() => {
    void api.candidates().then((r) => setCandidates(r.candidates ?? []));
  }, [agentsKey]);

  const current = form.executor_id ? executor(form.executor_id) : null;
  const choices = models[form.executor_id] ?? [];
  const listed = form.model === null || choices.some((m) => m.id === form.model);
  const formCaps = caps[form.executor_id];
  const grouped = byHarness([...agents.map((e) => ({ type: e.type, agent: e })), ...candidates.map((c) => ({ type: c.type, candidate: c }))]);

  const pickAgent = async (value: string) => {
    setCustomModel(false);
    if (!value.startsWith(NEW_AGENT)) {
      setForm((f) => (value === f.executor_id ? f : { ...f, executor_id: value, model: null }));
      return;
    }
    const c = candidates.find((x) => candidateValue(x) === value);
    if (!c) return;
    setError(null);
    const r = await api.createExecutor({ type: c.type, source_kind: c.source_kind, provider_id: c.provider_id });
    if (r.error || !r.executor) return setError(r.error ?? "建 agent 失败");
    const made = r.executor;
    setForm((f) => ({ ...f, executor_id: made.id, model: null }));
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    const r = bot ? await api.updateBot(bot.id, form) : await api.createBot(form);
    setBusy(false);
    if (r.error || !r.bot) {
      setError(r.error ?? "保存失败");
      return;
    }
    try {
      localStorage.setItem(LAST_BACKEND, JSON.stringify({ executor_id: form.executor_id, model: form.model }));
    } catch {
      // only a default for next time
    }
    onSaved(r.bot);
  };

  const shuffle = () => {
    const worn = new Set(bots.filter((b) => b.id !== bot?.id).map((b) => b.avatar));
    const pool = logos.filter((l) => l.id !== form.avatar && !worn.has(l.id));
    const pick = (pool.length > 0 ? pool : logos)[Math.floor(Math.random() * (pool.length || logos.length))];
    if (pick) set("avatar", pick.id);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ScrollArea className="min-h-0 flex-1">
        <div className="@container mx-auto max-w-2xl px-8 py-8">
          <h2 className="text-lg font-semibold">{bot ? `编辑 ${bot.name}` : "新建 Bot"}</h2>
          {!bot && (
            <div className="mt-4">
              <div className="text-muted-foreground mb-2 text-xs">从角色开始</div>
              <div className="flex flex-wrap gap-1.5">
                {TEMPLATES.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() =>
                      setForm((f) => ({
                        ...f,
                        name: freeName(t.name, bots),
                        title: t.title,
                        avatar: freeLogo(t.avatar, logos, bots),
                        system_prompt: t.system_prompt,
                        permission_tier: t.permission_tier,
                      }))
                    }
                    className={cn(
                      "hover:bg-accent/60 inline-flex items-center gap-1.5 rounded-full border py-0.5 pr-2.5 pl-0.5 text-xs transition-colors",
                      form.system_prompt === t.system_prompt && "border-foreground/40 bg-accent",
                    )}
                  >
                    <BotAvatar bot={{ id: t.id, avatar: t.avatar }} size="xs" />
                    {t.name}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="mt-7 flex flex-wrap items-center gap-5">
            <BotAvatar bot={{ id: bot?.id ?? "new", avatar: form.avatar }} size="xl" />
            <div className="min-w-48 flex-1">
              <div className="text-sm font-medium">
                头像 · {logos.find((l) => l.id === form.avatar)?.name ?? "自动分配"}
              </div>
              <p className="text-muted-foreground mt-0.5 text-xs">
                所有 bot 共用同一套 IP 形象；变淡的是别的 bot 正在用的
              </p>
            </div>
            <Button type="button" variant="outline" size="sm" onClick={shuffle}>
              <Shuffle />
              随机换一个
            </Button>
          </div>
          <div className="mt-4">
            <LogoPicker value={form.avatar} onChange={(id) => set("avatar", id)} bots={bots} selfId={bot?.id} />
          </div>

          <div className="mt-6 grid gap-4 @md:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="bot-name">名字</Label>
              <Input
                id="bot-name"
                value={form.name}
                onChange={(e) => set("name", e.target.value)}
                placeholder="比如：Go工程师"
                autoFocus={!template && !bot}
              />
              <span className="text-muted-foreground text-xs">群里用 @{form.name || "名字"} 叫它，不能有空格</span>
            </div>
            <div className="grid content-start gap-2">
              <Label htmlFor="bot-title">职责</Label>
              <Input
                id="bot-title"
                value={form.title ?? ""}
                onChange={(e) => set("title", e.target.value || null)}
                placeholder="比如：Go 后端工程师"
              />
            </div>
          </div>

          <div className="mt-5 grid gap-2">
            <div className="flex items-baseline justify-between gap-3">
              <div className="flex items-baseline gap-1">
                <Label htmlFor="bot-prompt">设定</Label>
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  className="text-muted-foreground"
                  onClick={() => setPreview((p) => !p)}
                >
                  {preview ? <Pencil /> : <Eye />}
                  {preview ? "编辑" : "预览"}
                </Button>
              </div>
              <span className="text-muted-foreground text-xs">
                Markdown · 附加在 agent 自带的编码提示词之后，不会替换它
              </span>
            </div>
            {preview ? (
              <div className="bg-muted/50 min-h-56 rounded-lg border px-4 py-3">
                {form.system_prompt?.trim() ? (
                  <Markdown>{form.system_prompt}</Markdown>
                ) : (
                  <p className="text-muted-foreground text-sm">还没写设定。</p>
                )}
              </div>
            ) : (
              <Textarea
                id="bot-prompt"
                value={form.system_prompt ?? ""}
                onChange={(e) => set("system_prompt", e.target.value || null)}
                placeholder={"你是一名资深 Go 工程师……\n\n工作方式：\n- ……"}
                className="min-h-56 text-sm leading-relaxed"
              />
            )}
          </div>

          <div className="mt-5 grid gap-4 @md:grid-cols-2">
            <div className="grid content-start gap-2">
              <div className="flex items-baseline justify-between">
                <Label>Agent</Label>
                <Button
                  type="button"
                  variant="link"
                  size="xs"
                  className="text-muted-foreground h-auto p-0"
                  onClick={() => onManageAgents(current ? form.executor_id : null)}
                >
                  {current ? "管理 agent" : "新建 agent"}
                </Button>
              </div>
              {grouped.length === 0 ? (
                <p className="text-muted-foreground text-xs leading-relaxed">
                  还没有能用的 agent：本机没有能用的 harness，也没有接得上的模型 API。到设置里装一个 harness，或者加一个模型 API。
                </p>
              ) : (
                <Select value={form.executor_id} onValueChange={(v) => void pickAgent(v)}>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="选一个 agent" />
                  </SelectTrigger>
                  <SelectContent>
                    {grouped.map(([type, items]) => (
                      <SelectGroup key={type}>
                        <SelectLabel>{harnessLabels[type] ?? type}</SelectLabel>
                        {items.map((item) =>
                          "agent" in item ? (
                            <SelectItem key={item.agent.id} value={item.agent.id}>
                              {item.agent.label}
                            </SelectItem>
                          ) : (
                            <SelectItem key={candidateValue(item.candidate)} value={candidateValue(item.candidate)}>
                              {item.candidate.name}
                              <span className="text-muted-foreground"> · 新建</span>
                            </SelectItem>
                          ),
                        )}
                      </SelectGroup>
                    ))}
                  </SelectContent>
                </Select>
              )}
              <span className="text-muted-foreground text-xs">agent 定了 harness 和模型从哪来：订阅，或者一个模型 API</span>
            </div>
            <div className="grid content-start gap-2">
              <Label htmlFor="bot-model">模型</Label>
              {!current ? (
                <p className="text-muted-foreground text-xs leading-relaxed">先选一个 agent。</p>
              ) : (
                <Select
                  value={customModel || !listed ? CUSTOM_MODEL : (form.model ?? DEFAULT_MODEL)}
                  onValueChange={(v) => {
                    if (v === CUSTOM_MODEL) return setCustomModel(true);
                    setCustomModel(false);
                    set("model", v === DEFAULT_MODEL ? null : v);
                  }}
                >
                  <SelectTrigger id="bot-model" className="w-full">
                    <SelectValue placeholder="选模型" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={DEFAULT_MODEL}>
                      用 agent 的默认{current.model ? `（${current.model}）` : "模型"}
                    </SelectItem>
                    {choices.map((m) => (
                      <SelectItem key={m.id} value={m.id} disabled={!m.available}>
                        {m.label ?? m.id}
                        {!m.available && (
                          <span className="text-muted-foreground"> · {current.source_kind === "own" ? "没有登录" : "没有密钥"}</span>
                        )}
                      </SelectItem>
                    ))}
                    <SelectGroup>
                      <SelectLabel>其他</SelectLabel>
                      <SelectItem value={CUSTOM_MODEL}>手动填模型 id…</SelectItem>
                    </SelectGroup>
                  </SelectContent>
                </Select>
              )}
              {current && (customModel || !listed) && (
                <Input
                  value={form.model ?? ""}
                  onChange={(e) => set("model", e.target.value || null)}
                  placeholder="模型 id"
                  spellCheck={false}
                  autoFocus={customModel}
                  className="font-mono text-xs"
                />
              )}
            </div>
          </div>
          {formCaps && (
            <div className="mt-3 rounded-lg border px-3 py-2.5">
              <CapabilityNotes caps={formCaps} />
            </div>
          )}

          <div className="mt-5 grid gap-2">
            <Label>权限档</Label>
            <div className="grid gap-2 @lg:grid-cols-3">
              {(["read", "write", "execute"] as Tier[]).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => set("permission_tier", t)}
                  className={cn(
                    "rounded-lg border px-3 py-2 text-left transition-colors",
                    form.permission_tier === t ? "border-foreground/40 bg-accent" : "hover:bg-accent/50",
                  )}
                >
                  <span className="block text-sm font-medium">{TIER_LABEL[t]?.label}</span>
                  <span className="text-muted-foreground block text-xs leading-snug">{TIER_LABEL[t]?.hint}</span>
                </button>
              ))}
            </div>
            <span className="text-muted-foreground text-xs">
              {formCaps?.permissionModes
                ? "这个 agent 按自己的权限模式审批：档位只决定新会话从哪个模式开始，之后在输入框下方切换。"
                : "超出档位的操作会在聊天里发一张卡片问你；改档位立即生效。"}
            </span>
          </div>
        </div>
      </ScrollArea>
      <Separator />
      <div className="flex shrink-0 items-center justify-end gap-2 px-8 py-3">
        {error && <span className="text-destructive mr-auto text-xs">{error}</span>}
        <Button variant="outline" onClick={onCancel}>
          取消
        </Button>
        <Button onClick={() => void save()} disabled={busy || !form.name.trim()}>
          {bot ? "保存" : "创建"}
        </Button>
      </div>
    </div>
  );
}
