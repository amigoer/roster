import { useContext, useEffect, useMemo, useState } from "react";
import { Archive, Eye, Loader, MessageCircle, Pencil, Plus, Shuffle, Trash2, Users } from "lucide-react";
import { toast } from "sonner";
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
import { BotAvatar, GroupAvatar, LogoImage, logoOf, useLogos, type Busy } from "./bot-avatar";
import { CapabilityNotes } from "./capabilities";
import { DeleteConversation, RenameInput } from "./conversation-menu";
import { byHarness, Executors, HarnessLabels, useExecutor } from "./executors";
import { useI18n } from "./i18n";
import { LIST_BODY, ListSearch, ROW, rowState, SectionLabel } from "./list";
import { DirectorySection, locationLabel } from "./location";
import { Markdown } from "./markdown";
import { MemberSections, MODES } from "./members-panel";
import { leaderOf } from "./mentions";
import { ProviderIcon, providerOf } from "./provider-icon";
import { templates, type Template } from "./templates";
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
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
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
  const { t, list } = useI18n();
  const isSelected = (kind: Contact["kind"], id: string) => selected?.kind === kind && selected.id === id;
  const q = query.trim().toLowerCase();
  const shownBots = q
    ? bots.filter((b) => b.name.toLowerCase().includes(q) || (b.title ?? "").toLowerCase().includes(q))
    : bots;
  const groups = convs.filter((c) => c.shape === "group" && !c.archived && (!q || c.title.toLowerCase().includes(q)));

  return (
    <>
      <ListSearch value={query} onChange={setQuery} placeholder={t("contacts.search")} />
      <ScrollArea className="min-h-0 flex-1 [mask-image:linear-gradient(to_bottom,transparent,black_0.5rem)]">
        <div className={LIST_BODY}>
          <SectionLabel>{t("contacts.bots", { count: shownBots.length })}</SectionLabel>
          {bots.length === 0 && (
            <p className="text-muted-foreground px-2.5 py-4 text-sm">{t("contacts.noBots")}</p>
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
                  {b.title ?? `${executor(b.executor_id).label} · ${b.model ?? executor(b.executor_id).model ?? t("common.defaultModel")}`}
                </div>
              </div>
            </button>
          ))}
          {groups.length > 0 && (
            <>
              <SectionLabel>{t("contacts.groups", { count: groups.length })}</SectionLabel>
              {groups.map((c) => {
                const members = activeMembers(c);
                return (
                  <button
                    key={c.id}
                    onClick={() => onSelect({ kind: "group", id: c.id })}
                    className={cn(ROW, rowState(isSelected("group", c.id)))}
                  >
                    <GroupAvatar bots={members.map((m) => m.bot)} avatar={c.avatar} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">{c.title}</div>
                      <div className="text-muted-foreground truncate text-xs">
                        {list(members.map((m) => m.bot.name)) || t("contacts.noMembers")}
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
  const { t } = useI18n();
  const roles = useMemo(() => templates(t), [t]);
  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="mx-auto max-w-3xl px-8 py-10">
        <h2 className="text-lg font-semibold">{t("gallery.title")}</h2>
        <p className="text-muted-foreground mt-1 text-sm">{t("gallery.description")}</p>
        <div className="mt-6 grid grid-cols-[repeat(auto-fill,minmax(210px,1fr))] gap-2.5">
          <button
            onClick={() => onPick(null)}
            className="hover:bg-accent/50 flex items-center gap-3 rounded-xl border border-dashed p-3 text-left transition-colors"
          >
            <span className="bg-muted inline-flex size-9 items-center justify-center rounded-[30%]">
              <Plus className="size-4" />
            </span>
            <span>
              <span className="block text-sm font-medium">{t("gallery.blank")}</span>
              <span className="text-muted-foreground block text-xs">{t("gallery.blankHint")}</span>
            </span>
          </button>
          {roles.map((role) => (
            <button
              key={role.id}
              onClick={() => onPick(role)}
              className="hover:bg-accent/50 flex items-center gap-3 rounded-xl border p-3 text-left transition-colors"
            >
              <BotAvatar bot={{ id: role.id, avatar: role.avatar }} />
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium">{role.name}</span>
                <span className="text-muted-foreground block truncate text-xs">{role.title}</span>
              </span>
              <Badge variant="outline" className="ml-auto shrink-0 px-1.5 py-0 text-[10px] font-normal">
                {t(`tier.${role.permission_tier}`)}
              </Badge>
            </button>
          ))}
        </div>
      </div>
    </ScrollArea>
  );
}

export function Section({ title, children }: { title: string; children: React.ReactNode }) {
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
  const { t } = useI18n();
  const executor = useExecutor()(bot.executor_id);
  const botCaps = caps[bot.executor_id];
  const joined = convs.filter((c) => !c.archived && activeMembers(c).some((m) => m.bot.id === bot.id));

  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="mx-auto max-w-2xl px-8 py-10">
        {/* wraps rather than squeezing the name into a one-character column in a narrow pane */}
        <div className="flex flex-wrap items-start gap-5">
          <BotAvatar bot={bot} size="xl" busy={busy} />
          <div className="min-w-48 flex-1 pt-1">
            <h2 className="truncate text-xl font-semibold">{bot.name}</h2>
            <p className="text-muted-foreground mt-0.5 text-sm">{bot.title ?? t("profile.noTitle")}</p>
            <div className="mt-2.5 flex flex-wrap gap-1.5">
              <Badge variant="outline" className="font-normal">
                <ProviderIcon provider={providerOf(bot, executor.type)} />
                {executor.label} · {bot.model ?? executor.model ?? t("common.defaultModel")}
              </Badge>
              <Badge variant="outline" className="font-normal">
                {t(`tier.${bot.permission_tier}`)}
              </Badge>
              {busy && (
                <Badge variant="secondary" className="font-normal">
                  {busy === "needs_you" ? t("profile.needsApproval") : t("busy.working")}
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
            {opening ? <Loader className="animate-spin" /> : <MessageCircle />}
            {t("profile.message")}
          </Button>
          <Button size="sm" variant="outline" onClick={onGroup}>
            <Users />
            {t("profile.startGroup")}
          </Button>
          <Button size="sm" variant="outline" onClick={onEdit}>
            <Pencil />
            {t("common.edit")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="text-muted-foreground hover:text-destructive ml-auto"
            onClick={() => setConfirming(true)}
          >
            <Trash2 />
            {t("common.delete")}
          </Button>
        </div>

        <Section title={t("bot.instructions")}>
          {bot.system_prompt ? (
            <div className="bg-muted/50 rounded-lg border px-4 py-3">
              <Markdown>{bot.system_prompt}</Markdown>
            </div>
          ) : (
            <p className="text-muted-foreground text-sm">{t("profile.noInstructions")}</p>
          )}
        </Section>

        <Section title={t("profile.permissions")}>
          <p className="text-sm">
            <span className="font-medium">{t(`tier.${bot.permission_tier}`)}</span>
            <span className="text-muted-foreground">
              {" · "}
              {botCaps?.permissionModes ? t("profile.modesHint") : t(`tier.${bot.permission_tier}.hint`)}
            </span>
          </p>
        </Section>

        {botCaps && (
          <Section title={t("profile.capabilities", { name: executor.label })}>
            <CapabilityNotes caps={botCaps} />
          </Section>
        )}

        <Section title={t("profile.conversations", { count: joined.length })}>
          {joined.length === 0 ? (
            <p className="text-muted-foreground text-sm">{t("profile.noConversations")}</p>
          ) : (
            <div className="-mx-2">
              {joined.map((c) => (
                <button
                  key={c.id}
                  onClick={() => onOpenConversation(c.id)}
                  className="hover:bg-accent/50 focus-visible:ring-ring/50 flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors duration-120 outline-none focus-visible:ring-2"
                >
                  {c.shape === "group" ? (
                    <GroupAvatar bots={activeMembers(c).map((m) => m.bot)} avatar={c.avatar} />
                  ) : (
                    <BotAvatar bot={bot} />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm">{c.title}</span>
                    <span className={cn("text-muted-foreground block truncate text-[11px]", c.dir_kind === "repo" && "font-mono")}>
                      {locationLabel(t, c)}
                    </span>
                  </span>
                  {c.shape === "group" && (
                    <Badge variant="secondary" className="px-1 py-0 text-[10px]">
                      {t("conversation.groupBadge")}
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
            <AlertDialogTitle>{t("profile.deleteTitle", { name: bot.name })}</AlertDialogTitle>
            <AlertDialogDescription>{t("profile.deleteBody")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                void api.deleteBot(bot.id).then(onDeleted);
              }}
            >
              {t("common.delete")}
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
  convs,
  presence,
  busy,
  onMessage,
  onOpenBot,
  onGone,
}: {
  conv: Conversation;
  bots: Bot[];
  /** every conversation, so a directory change can say who else works there */
  convs: Conversation[];
  presence: Record<string, Presence>;
  busy: Busy;
  onMessage: () => void;
  onOpenBot: (botId: string) => void;
  /** archived or deleted */
  onGone: (id: string) => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [picking, setPicking] = useState(false);
  const { t, list } = useI18n();
  const members = activeMembers(conv);
  const mode = MODES.find((m) => m.id === conv.mode);
  const choose = async (avatar: string | null) => {
    setPicking(false);
    const r = await api.setAvatar(conv.id, avatar);
    if (r.error) toast.error(r.error);
  };

  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="mx-auto max-w-2xl px-8 py-10">
        <div className="flex flex-wrap items-start gap-5">
          <button
            type="button"
            onClick={() => setPicking(true)}
            title={t("group.avatarChange")}
            className="ring-offset-background rounded-[23%] ring-offset-2 transition outline-none hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring"
          >
            <GroupAvatar bots={members.map((m) => m.bot)} avatar={conv.avatar} size="xl" busy={busy} />
          </button>
          <div className="min-w-48 flex-1 pt-1">
            {/* both pad the text by the same amount, so it does not jump when the field swaps in */}
            {renaming ? (
              <RenameInput conv={conv} className="-ml-1.5 text-xl" onDone={() => setRenaming(false)} />
            ) : (
              <h2
                onClick={() => setRenaming(true)}
                title={t("conversation.clickToRename")}
                className="hover:bg-accent -ml-1.5 w-fit max-w-full cursor-text truncate rounded px-1.5 py-0.5 text-xl font-semibold"
              >
                {conv.title}
              </h2>
            )}
            <p className="text-muted-foreground mt-0.5 text-sm">{list(members.map((m) => m.bot.name)) || t("contacts.noMembers")}</p>
            <div className="mt-2.5 flex flex-wrap gap-1.5">
              {mode && (
                <Badge variant="outline" className="font-normal">
                  <mode.icon />
                  {t(`mode.${mode.id}`)}
                  {conv.mode === "leader" && t("group.leader", { name: leaderOf(conv)?.bot.name ?? "-" })}
                </Badge>
              )}
              {busy && (
                <Badge variant="secondary" className="font-normal">
                  {busy === "needs_you" ? t("profile.needsApproval") : t("busy.working")}
                </Badge>
              )}
            </div>
          </div>
        </div>

        <div className="mt-6 flex flex-wrap gap-2">
          <Button size="sm" onClick={onMessage}>
            <MessageCircle />
            {t("profile.message")}
          </Button>
          <Button size="sm" variant="outline" onClick={() => setRenaming(true)}>
            <Pencil />
            {t("common.rename")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="text-muted-foreground ml-auto"
            onClick={() =>
              void api.archive(conv.id, true).then(() => {
                onGone(conv.id);
                toast(t("group.archived", { title: conv.title }), {
                  action: { label: t("common.undo"), onClick: () => void api.archive(conv.id, false) },
                });
              })
            }
          >
            <Archive />
            {t("common.archive")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="text-muted-foreground hover:text-destructive"
            onClick={() => setConfirming(true)}
          >
            <Trash2 />
            {t("common.delete")}
          </Button>
        </div>

        <MemberSections conv={conv} bots={bots} presence={presence} onOpenBot={onOpenBot} className="mt-7 space-y-7" />

        <DirectorySection conv={conv} convs={convs} className="mt-7" />
      </div>

      <DeleteConversation conv={conv} open={confirming} onOpenChange={setConfirming} onDeleted={onGone} />

      <Dialog open={picking} onOpenChange={setPicking}>
        <DialogContent className="max-h-[calc(100vh-2rem)] overflow-y-auto sm:max-w-[520px]">
          <DialogHeader>
            <DialogTitle>{t("group.avatarTitle")}</DialogTitle>
            <DialogDescription>{t("group.avatarHint")}</DialogDescription>
          </DialogHeader>
          <button
            type="button"
            onClick={() => void choose(null)}
            className={cn(
              "flex items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors",
              conv.avatar === null ? "border-foreground/40 bg-accent" : "hover:bg-accent/50",
            )}
          >
            <GroupAvatar bots={members.map((m) => m.bot)} />
            <span>
              <span className="block text-sm font-medium">{t("group.avatarAuto")}</span>
              <span className="text-muted-foreground block text-xs">{t("group.avatarAutoHint")}</span>
            </span>
          </button>
          <LogoPicker value={conv.avatar} onChange={(id) => void choose(id)} bots={bots} />
        </DialogContent>
      </Dialog>
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
  const { t, list } = useI18n();
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
            title={worn ? t("editor.logoWornBy", { logo: l.name, names: list(worn) }) : l.name}
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
  const { t } = useI18n();
  const roles = useMemo(() => templates(t), [t]);
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
    if (r.error || !r.executor) return setError(r.error ?? t("editor.createAgentFailed"));
    const made = r.executor;
    setForm((f) => ({ ...f, executor_id: made.id, model: null }));
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    const r = bot ? await api.updateBot(bot.id, form) : await api.createBot(form);
    setBusy(false);
    if (r.error || !r.bot) {
      setError(r.error ?? t("common.saveFailed"));
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
          <h2 className="text-lg font-semibold">{bot ? t("editor.titleEdit", { name: bot.name }) : t("bot.new")}</h2>
          {!bot && (
            <div className="mt-4">
              <div className="text-muted-foreground mb-2 text-xs">{t("editor.fromRole")}</div>
              <div className="flex flex-wrap gap-1.5">
                {roles.map((role) => (
                  <button
                    key={role.id}
                    type="button"
                    onClick={() =>
                      setForm((f) => ({
                        ...f,
                        name: freeName(role.name, bots),
                        title: role.title,
                        avatar: freeLogo(role.avatar, logos, bots),
                        system_prompt: role.system_prompt,
                        permission_tier: role.permission_tier,
                      }))
                    }
                    className={cn(
                      "hover:bg-accent/60 inline-flex items-center gap-1.5 rounded-full border py-0.5 pr-2.5 pl-0.5 text-xs transition-colors",
                      form.system_prompt === role.system_prompt && "border-foreground/40 bg-accent",
                    )}
                  >
                    <BotAvatar bot={{ id: role.id, avatar: role.avatar }} size="xs" />
                    {role.name}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="mt-7 flex flex-wrap items-center gap-5">
            <BotAvatar bot={{ id: bot?.id ?? "new", avatar: form.avatar }} size="xl" />
            <div className="min-w-48 flex-1">
              <div className="text-sm font-medium">
                {t("editor.avatar", { name: logos.find((l) => l.id === form.avatar)?.name ?? t("editor.avatarAuto") })}
              </div>
              <p className="text-muted-foreground mt-0.5 text-xs">{t("editor.avatarHint")}</p>
            </div>
            <Button type="button" variant="outline" size="sm" onClick={shuffle}>
              <Shuffle />
              {t("editor.shuffle")}
            </Button>
          </div>
          <div className="mt-4">
            <LogoPicker value={form.avatar} onChange={(id) => set("avatar", id)} bots={bots} selfId={bot?.id} />
          </div>

          <div className="mt-6 grid gap-4 @md:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="bot-name">{t("editor.name")}</Label>
              <Input
                id="bot-name"
                value={form.name}
                onChange={(e) => set("name", e.target.value)}
                placeholder={t("editor.namePlaceholder")}
                autoFocus={!template && !bot}
              />
              <span className="text-muted-foreground text-xs">
                {t("editor.nameHint", { name: form.name || t("editor.nameFallback") })}
              </span>
            </div>
            <div className="grid content-start gap-2">
              <Label htmlFor="bot-title">{t("editor.role")}</Label>
              <Input
                id="bot-title"
                value={form.title ?? ""}
                onChange={(e) => set("title", e.target.value || null)}
                placeholder={t("editor.rolePlaceholder")}
              />
            </div>
          </div>

          <div className="mt-5 grid gap-2">
            <div className="flex items-baseline justify-between gap-3">
              <div className="flex items-baseline gap-1">
                <Label htmlFor="bot-prompt">{t("bot.instructions")}</Label>
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  className="text-muted-foreground"
                  onClick={() => setPreview((p) => !p)}
                >
                  {preview ? <Pencil /> : <Eye />}
                  {preview ? t("common.edit") : t("common.preview")}
                </Button>
              </div>
              <span className="text-muted-foreground text-xs">{t("editor.promptHint")}</span>
            </div>
            {preview ? (
              <div key="preview" className="bg-muted/50 animate-in fade-in-0 min-h-56 rounded-lg border px-4 py-3 duration-200">
                {form.system_prompt?.trim() ? (
                  <Markdown>{form.system_prompt}</Markdown>
                ) : (
                  <p className="text-muted-foreground text-sm">{t("editor.noPrompt")}</p>
                )}
              </div>
            ) : (
              <Textarea
                key="edit"
                id="bot-prompt"
                value={form.system_prompt ?? ""}
                onChange={(e) => set("system_prompt", e.target.value || null)}
                placeholder={t("editor.promptPlaceholder")}
                className="animate-in fade-in-0 min-h-56 text-sm leading-relaxed duration-200"
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
                  {current ? t("editor.manageAgent") : t("agent.new")}
                </Button>
              </div>
              {grouped.length === 0 ? (
                <p className="text-muted-foreground text-xs leading-relaxed">{t("editor.noAgents")}</p>
              ) : (
                <Select value={form.executor_id} onValueChange={(v) => void pickAgent(v)}>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder={t("editor.pickAgent")} />
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
                              <span className="text-muted-foreground">{t("editor.newSuffix")}</span>
                            </SelectItem>
                          ),
                        )}
                      </SelectGroup>
                    ))}
                  </SelectContent>
                </Select>
              )}
              <span className="text-muted-foreground text-xs">{t("editor.agentHint")}</span>
            </div>
            <div className="grid content-start gap-2">
              <Label htmlFor="bot-model">{t("editor.model")}</Label>
              {!current ? (
                <p className="text-muted-foreground text-xs leading-relaxed">{t("editor.pickAgentFirst")}</p>
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
                    <SelectValue placeholder={t("editor.pickModel")} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={DEFAULT_MODEL}>
                      {current.model ? t("editor.agentDefaultNamed", { model: current.model }) : t("editor.agentDefault")}
                    </SelectItem>
                    {choices.map((m) => (
                      <SelectItem key={m.id} value={m.id} disabled={!m.available}>
                        {m.label ?? m.id}
                        {!m.available && (
                          <span className="text-muted-foreground">
                            {" · "}
                            {current.source_kind === "own" ? t("common.notSignedIn") : t("common.noKey")}
                          </span>
                        )}
                      </SelectItem>
                    ))}
                    <SelectGroup>
                      <SelectLabel>{t("editor.other")}</SelectLabel>
                      <SelectItem value={CUSTOM_MODEL}>{t("editor.customModel")}</SelectItem>
                    </SelectGroup>
                  </SelectContent>
                </Select>
              )}
              {current && (customModel || !listed) && (
                <Input
                  value={form.model ?? ""}
                  onChange={(e) => set("model", e.target.value || null)}
                  placeholder={t("editor.modelId")}
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
            <Label>{t("editor.tier")}</Label>
            <div className="grid gap-2 @lg:grid-cols-3">
              {(["read", "write", "execute"] as Tier[]).map((tier) => (
                <button
                  key={tier}
                  type="button"
                  onClick={() => set("permission_tier", tier)}
                  className={cn(
                    "rounded-lg border px-3 py-2 text-left transition-colors",
                    form.permission_tier === tier ? "border-foreground/40 bg-accent" : "hover:bg-accent/50",
                  )}
                >
                  <span className="block text-sm font-medium">{t(`tier.${tier}`)}</span>
                  <span className="text-muted-foreground block text-xs leading-snug">{t(`tier.${tier}.hint`)}</span>
                </button>
              ))}
            </div>
            <span className="text-muted-foreground text-xs">
              {formCaps?.permissionModes ? t("editor.tierModesHint") : t("editor.tierHint")}
            </span>
          </div>
        </div>
      </ScrollArea>
      <Separator />
      <div className="flex shrink-0 items-center justify-end gap-2 px-8 py-3">
        {error && <span className="text-destructive mr-auto text-xs">{error}</span>}
        <Button variant="outline" onClick={onCancel}>
          {t("common.cancel")}
        </Button>
        <Button onClick={() => void save()} disabled={busy || !form.name.trim()}>
          {busy && <Loader className="animate-spin" />}
          {bot ? t("common.save") : t("common.create")}
        </Button>
      </div>
    </div>
  );
}
