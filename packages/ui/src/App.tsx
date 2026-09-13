import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Archive, Loader, MessageSquarePlus, Plus, Users } from "lucide-react";
import {
  activeMembers,
  api,
  connect,
  type Bot,
  type CapabilitySet,
  type Conversation,
  type Executor,
  type ExecutorSettings,
  type ExtensionsView,
  type Logo,
  type Member,
  type Message,
  type Presence,
  type Quota,
  type SessionInfo,
  type SessionOptions,
  type SourceRef,
} from "./api";
import { DRAG, NO_DRAG } from "./app-region";
import { AboutPanel, type AboutState } from "./about";
import { AppearancePanel } from "./appearance";
import { BotAvatar, busyOf, GroupAvatar, Logos, type Busy } from "./bot-avatar";
import { CapabilityBadge } from "./capabilities";
import { MessageCard, StreamingBubble, Who } from "./cards";
import { Composer, type ComposerHandle } from "./composer";
import { BotEditor, BotProfile, ContactList, forgetModels, GroupProfile, TemplateGallery, type Contact } from "./contacts";
import { ContextPanel } from "./context-panel";
import { ConversationMenu, RenameInput } from "./conversation-menu";
import { capsOf, Executors, SourceRefs } from "./executors";
import { LIST_BODY, ListSearch, ROW, rowState } from "./list";
import { MentionNames } from "./markdown";
import { MembersPanel, MODES } from "./members-panel";
import { leaderOf } from "./mentions";
import { NAV, NavRail, RAIL, type Nav } from "./nav-rail";
import { NewConversation, startDirect } from "./new-conversation";
import { Outline } from "./outline";
import { PresenceStrip } from "./presence";
import { Resizer, useColumnWidth } from "./resizable";
import { ExecutorEditor, ExtensionsPanel, ProviderEditor, SettingsList, type SettingsSelection } from "./settings";
import type { Template } from "./templates";
import { useTheme } from "./theme";
import { useTypography } from "./typography";
import { toast } from "sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

/** Every column past the rail floats on the chrome; gaps separate them, never lines. */
const PANEL = "bg-background shadow-panel overflow-hidden rounded-xl";

/** The list wants a glanceable time, not a precise one. */
function listTime(ts: number): string {
  const d = new Date(ts);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  if (sameDay) {
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  }
  const yesterday = new Date(today.getTime() - 86400000);
  if (d.toDateString() === yesterday.toDateString()) return "昨天";
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

/** Exactly one unread meaning: this one is waiting for you. Running is never unread. */
const WAITING: Record<string, string> = {
  waiting_permission: "等你批准",
  waiting_input: "等你回复",
  error: "出错了",
  stalled: "卡住了",
};

const repoName = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;

const omit = <T,>(rec: Record<string, T>, key: string): Record<string, T> => {
  if (!(key in rec)) return rec;
  const next = { ...rec };
  delete next[key];
  return next;
};

/** 1:1s read as a plain chat, so the members panel is remembered per shape. */
function usePanelOpen() {
  const [open, setOpen] = useState<Record<"direct" | "group", boolean>>(() => {
    try {
      return { direct: false, group: true, ...JSON.parse(localStorage.getItem("roster.membersPanel") ?? "{}") };
    } catch {
      return { direct: false, group: true };
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem("roster.membersPanel", JSON.stringify(open));
    } catch {
      // a panel that cannot be remembered still opens and closes
    }
  }, [open]);
  return [open, setOpen] as const;
}

export default function App() {
  const { theme, setTheme } = useTheme();
  const { typography, setFont, setCustomFont, setSize } = useTypography();
  const [nav, setNav] = useState<Nav>("messages");
  const [bots, setBots] = useState<Bot[]>([]);
  const [caps, setCaps] = useState<Record<string, CapabilitySet>>({});
  const [logos, setLogos] = useState<Logo[]>([]);
  const [executors, setExecutors] = useState<Executor[]>([]);
  /** endpoints by name, so a bot's model source can be labelled anywhere */
  const [sourceRefs, setSourceRefs] = useState<SourceRef[]>([]);
  /** executors and providers as the settings page edits them; loaded when it is first opened */
  const [settingsView, setSettingsView] = useState<ExecutorSettings | null>(null);
  const [settingsSel, setSettingsSel] = useState<SettingsSelection>(null);
  /** what is installed and what could be; refreshed whenever core says extensions changed */
  const [extView, setExtView] = useState<ExtensionsView | null>(null);
  const [extBump, setExtBump] = useState(0);
  const [about, setAbout] = useState<AboutState>(null);
  const [defaultDir, setDefaultDir] = useState("");
  const [convs, setConvs] = useState<Conversation[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  /** text still being written, per member of the open conversation */
  const [streams, setStreams] = useState<Record<string, string>>({});
  /** what every running member is doing, across all conversations */
  const [presence, setPresence] = useState<Record<string, Presence>>({});
  /** what each member's session runs with; kept across switches, so going back shows it at once */
  const [sessions, setSessions] = useState<Record<string, SessionInfo>>({});
  /** plan usage per executor, which is account-wide */
  const [quota, setQuota] = useState<Record<string, Quota | null>>({});
  /** what a session on each executor can be switched to */
  const [sessionOptions, setSessionOptions] = useState<Record<string, SessionOptions>>({});
  const [draft, setDraft] = useState("");
  const [contact, setContact] = useState<Contact | null>(null);
  const [editing, setEditing] = useState<{ botId: string | null; template: Template | null } | null>(null);
  const [starting, setStarting] = useState<{ open: boolean; botIds: string[] }>({ open: false, botIds: [] });
  const [panel, setPanel] = usePanelOpen();
  /** the member whose context window is open on the right, which takes the members panel's place */
  const [contextFor, setContextFor] = useState<string | null>(null);
  const list_ = useColumnWidth("roster.w.list", 300, 240, 520);
  const activeRef = useRef<string | null>(null);
  const scrollRoot = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const composerHandle = useRef<ComposerHandle | null>(null);
  /** a file is being dragged over the conversation */
  const [dropping, setDropping] = useState(false);
  /** a chat opened to write in; the composer takes the caret once it is on screen */
  const focusComposer = useRef(false);
  /** whether the reader is parked at the bottom; if not, new messages must not yank them down */
  const stick = useRef(true);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [query, setQuery] = useState("");

  const viewport = () =>
    scrollRoot.current?.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]') ?? null;

  /** Jumping lands you mid-history, so the stream must stop following the bottom. */
  const jump = (messageId: string) => {
    const vp = viewport();
    const el = document.getElementById(`m-${messageId}`);
    if (!vp || !el) return;
    stick.current = false;
    const top = el.getBoundingClientRect().top - vp.getBoundingClientRect().top + vp.scrollTop - 12;
    vp.scrollTo({ top, behavior: "smooth" });
  };

  /** The editor only moves on once the list it points into has the row: a new id looked up in the old list reads as "new". */
  const reloadSettings = (next: SettingsSelection) =>
    void api.executorSettings().then((v) => {
      setSettingsView(v);
      setSettingsSel(next);
    });
  const reloadExtensions = () => void api.extensions().then(setExtView).catch(() => {});
  const loadAbout = () =>
    void api
      .about()
      .then((r) => setAbout("version" in r ? r : { error: (r as { error?: string }).error ?? "core 没有回答" }))
      .catch((e: unknown) => setAbout({ error: String(e) }));

  const loadStatus = (id: string) =>
    api.status(id).then((r) => {
      setSessions((s) => ({ ...s, ...r.sessions }));
      setSessionOptions((o) => ({ ...o, ...r.options }));
      setQuota((q) => ({ ...q, ...r.quota }));
    });

  // a file let go anywhere the conversation does not take it would navigate the whole window to that file
  useEffect(() => {
    const swallow = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
    };
    const end = () => setDropping(false);
    window.addEventListener("dragover", swallow);
    window.addEventListener("drop", swallow);
    window.addEventListener("dragend", end);
    return () => {
      window.removeEventListener("dragover", swallow);
      window.removeEventListener("drop", swallow);
      window.removeEventListener("dragend", end);
    };
  }, []);

  const archivedRef = useRef(false);
  const settingsLoaded = useRef(false);
  activeRef.current = active;
  archivedRef.current = showArchived;

  useEffect(() => {
    const load = () =>
      api.state(archivedRef.current).then((s) => {
        setBots(s.bots);
        setConvs(s.conversations);
        setCaps(s.capabilities ?? {});
        setLogos(s.logos ?? []);
        setExecutors(s.executors ?? []);
        setSourceRefs(s.sources ?? []);
        setDefaultDir(s.defaultDir ?? "");
        setPresence(Object.fromEntries((s.presence ?? []).map((p) => [p.memberId, p])));
        if (!activeRef.current && s.conversations[0]) setActive(s.conversations[0].id);
      });
    void load();
    return connect((m) => {
      switch (m.kind) {
        case "conversations": {
          // the push carries the default view; while showing archived, refetch instead
          if (archivedRef.current) void api.state(true).then((s) => setConvs(s.conversations));
          else setConvs(m.conversations);
          // an idle conversation has nobody working, whatever presence event went missing
          const idle = new Set(m.conversations.filter((c) => c.run_state === "idle").map((c) => c.id));
          setPresence((prev) => {
            const kept = Object.entries(prev).filter(([, p]) => !idle.has(p.conversationId));
            return kept.length === Object.keys(prev).length ? prev : Object.fromEntries(kept);
          });
          return;
        }
        case "executors":
          setExecutors(m.executors);
          setCaps(m.capabilities);
          forgetModels();
          // endpoint names ride on the state, and an edit to one is what triggers this push
          void api.state(archivedRef.current).then((s) => setSourceRefs(s.sources ?? []));
          if (settingsLoaded.current) void api.executorSettings().then(setSettingsView);
          return;
        case "extensions":
          setExtBump((n) => n + 1);
          if (settingsLoaded.current) reloadExtensions();
          return;
        case "bots":
          setBots(m.bots);
          return;
        case "session":
          setSessions((s) => ({ ...s, [m.memberId]: m.info }));
          return;
        case "quota":
          setQuota((q) => ({ ...q, [m.executor]: m.quota }));
          return;
        case "presence": {
          const { kind: _, state, ...rest } = m;
          setPresence((prev) => (state === "idle" ? omit(prev, m.memberId) : { ...prev, [m.memberId]: { ...rest, state } }));
          // a turn can end with nothing said (stopped, failed); its draft bubble must go
          if (state === "idle" && m.conversationId === activeRef.current) setStreams((s) => omit(s, m.memberId));
          return;
        }
        case "delta":
          if (m.conversationId === activeRef.current) {
            setStreams((s) => ({ ...s, [m.memberId]: (s[m.memberId] ?? "") + m.text }));
          }
          return;
        case "message": {
          if (m.conversationId !== activeRef.current) return;
          const author = m.message.author_member_id;
          if (m.message.card_kind === "text" && author) setStreams((s) => omit(s, author));
          setMessages((prev) => {
            const i = prev.findIndex((x) => x.id === m.message.id);
            if (i === -1) return [...prev, m.message];
            const next = [...prev];
            next[i] = m.message;
            return next;
          });
          return;
        }
      }
    }, () => {
      void load();
      const id = activeRef.current;
      if (id) {
        void api.messages(id).then((r) => {
          if (activeRef.current !== id) return;
          setMessages(r.messages);
          setStreams(r.streams ?? {});
        });
        void loadStatus(id);
      }
    });
  }, []);

  useEffect(() => {
    void api.state(showArchived).then((s) => setConvs(s.conversations));
  }, [showArchived]);

  useEffect(() => {
    if (nav !== "settings") return;
    settingsLoaded.current = true;
    void api.executorSettings().then(setSettingsView);
    reloadExtensions();
    loadAbout();
  }, [nav]);

  useEffect(() => {
    if (!active) return;
    setStreams({});
    setMessages([]);
    setContextFor(null);
    void api.messages(active).then((r) => {
      setMessages(r.messages);
      setStreams(r.streams ?? {});
      setLoadedFor(active);
    });
    void loadStatus(active);
  }, [active]);

  // opening it is reading it, and so is watching it finish -- the live kinds of attention survive this
  const conv = convs.find((c) => c.id === active);
  useEffect(() => {
    const read = () => {
      if (nav !== "messages" || !conv || !document.hasFocus()) return;
      if (conv.attention === "waiting_input" || conv.attention === "error") void api.markRead(conv.id);
    };
    read();
    window.addEventListener("focus", read);
    return () => window.removeEventListener("focus", read);
  }, [conv?.id, conv?.attention, nav]);

  useEffect(() => {
    if (nav !== "messages" || !conv || !focusComposer.current) return;
    focusComposer.current = false;
    composer.current?.focus();
  }, [conv?.id, nav]);

  // switching conversations lands at the bottom instantly. Animating it would
  // scroll the whole history past the reader on every switch.
  useLayoutEffect(() => {
    const vp = viewport();
    if (vp) vp.scrollTop = vp.scrollHeight;
    stick.current = true;
  }, [loadedFor, nav]);

  useEffect(() => {
    const vp = viewport();
    if (!vp) return;
    let lastTop = vp.scrollTop;
    const onScroll = () => {
      // only the reader scrolling up unpins: a smooth follow still in flight when
      // the next message lands is short of the bottom too, but moving down
      if (vp.scrollHeight - vp.scrollTop - vp.clientHeight < 40) stick.current = true;
      else if (vp.scrollTop < lastTop) stick.current = false;
      lastTop = vp.scrollTop;
    };
    vp.addEventListener("scroll", onScroll, { passive: true });
    return () => vp.removeEventListener("scroll", onScroll);
  }, [loadedFor, nav]);

  const streamed = Object.values(streams).reduce((n, s) => n + s.length, 0);
  // follow new content only when the reader was already at the bottom
  useEffect(() => {
    if (!stick.current) return;
    const vp = viewport();
    vp?.scrollTo({ top: vp.scrollHeight, behavior: "smooth" });
  }, [messages.length, streamed]);

  const busyByBot = useMemo(() => {
    const out: Record<string, Busy> = {};
    for (const c of convs) {
      for (const m of c.members) {
        const b = busyOf(presence[m.id]?.state);
        if (b && out[m.bot.id] !== "needs_you") out[m.bot.id] = b;
      }
    }
    return out;
  }, [convs, presence]);

  const busyOfConv = (c: Conversation): Busy => {
    let out: Busy = null;
    for (const m of c.members) {
      const b = busyOf(presence[m.id]?.state);
      if (b === "needs_you") return b;
      out ??= b;
    }
    return out;
  };

  const openConversation = (id: string) => {
    setNav("messages");
    setActive(id);
  };

  /** archived or deleted: it leaves the list, and the chat if it was open */
  const dropConversation = (id: string) => {
    setConvs((prev) => prev.filter((x) => x.id !== id));
    if (activeRef.current === id) setActive(null);
  };

  /** Straight to the chat, like any messenger: the latest 1:1 with the bot, or a new one if there is none. */
  const messageBot = async (bot: Bot) => {
    let id = convs
      .filter((c) => c.shape === "direct" && !c.archived && activeMembers(c).some((m) => m.bot.id === bot.id))
      .sort((a, b) => b.last_activity_at - a.last_activity_at)[0]?.id;
    if (!id) {
      const r = await startDirect(bot, defaultDir);
      if (!r.conversation) {
        // most likely the remembered directory is gone, and the dialog is where another is picked
        toast.error("没能直接开始会话", { description: r.error });
        setStarting({ open: true, botIds: [bot.id] });
        return;
      }
      const c = r.conversation;
      setConvs((prev) => [c, ...prev.filter((x) => x.id !== c.id)]);
      id = c.id;
    }
    focusComposer.current = true;
    openConversation(id);
  };

  const quote = (text: string) => {
    const body = text
      .split("\n")
      .map((l) => `> ${l}`)
      .join("\n");
    setDraft((d) => (d ? `${body}\n\n${d}` : `${body}\n\n`));
    composer.current?.focus();
  };

  const waiting = convs.filter((c) => c.attention !== "none").length;
  const q = query.trim().toLowerCase();
  const shownConvs = q
    ? convs.filter((c) =>
        [c.title, c.preview ?? "", repoName(c.repo_path), ...c.members.map((m) => m.bot.name)].some((s) =>
          s.toLowerCase().includes(q),
        ),
      )
    : convs;
  const members = activeMembers(conv);
  const memberById = useMemo(() => new Map<string, Member>((conv?.members ?? []).map((m) => [m.id, m])), [conv]);
  const names = useMemo(() => (conv?.members ?? []).map((m) => m.bot.name), [conv]);
  const group = conv?.shape === "group";
  const panelOpen = conv ? panel[conv.shape] : false;
  const selectedBot = contact?.kind === "bot" ? bots.find((b) => b.id === contact.id) : undefined;
  const selectedGroup = contact?.kind === "group" ? convs.find((c) => c.id === contact.id && !c.archived) : undefined;

  return (
    <Logos.Provider value={logos}>
    <Executors.Provider value={executors}>
    <SourceRefs.Provider value={sourceRefs}>
    <TooltipProvider delayDuration={200}>
      <div className="bg-sidebar text-sidebar-foreground flex h-full">
        {/* 一、导航栏：一条图标栏，宽度固定 —— 三个入口撑不满一整列，剩下的宽度归列表和正文 */}
        <NavRail nav={nav} onNav={setNav} waiting={waiting} />

        {/* the margins around the panels are chrome too: the window drags by them */}
        <div className="text-foreground flex min-w-0 flex-1 py-2 pr-2" style={DRAG}>
        {/* 二、列表 */}
        <section className={cn(PANEL, "flex min-h-0 shrink-0 flex-col")} style={{ width: list_.width, ...NO_DRAG }}>
          <header className="flex h-13 shrink-0 items-center justify-between pr-2.5 pl-4.5" style={DRAG}>
            <h1 className="text-[15px] font-semibold">{nav === "settings" ? "设置" : NAV.find((n) => n.id === nav)?.label}</h1>
            {nav === "messages" && (
              <div className="flex items-center gap-1" style={NO_DRAG}>
                <Button
                  variant="ghost"
                  size="icon"
                  className={cn("size-7 rounded-lg", showArchived ? "bg-selected text-primary hover:bg-selected hover:text-primary" : "text-muted-foreground")}
                  title={showArchived ? "只看进行中" : "显示已归档"}
                  aria-pressed={showArchived}
                  onClick={() => setShowArchived((v) => !v)}
                >
                  <Archive className="size-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="bg-foreground/[0.05] hover:bg-foreground/10 size-7 rounded-lg"
                  title="发起会话"
                  onClick={() => setStarting({ open: true, botIds: [] })}
                >
                  <Plus className="size-4" />
                </Button>
              </div>
            )}
            {nav === "contacts" && (
              <Button
                variant="ghost"
                size="icon"
                className="bg-foreground/[0.05] hover:bg-foreground/10 size-7 rounded-lg"
                style={NO_DRAG}
                title="新建 Bot"
                onClick={() => {
                  setContact(null);
                  setEditing(null);
                }}
              >
                <Plus className="size-4" />
              </Button>
            )}
          </header>
          {nav === "settings" ? (
            <SettingsList
              view={settingsView}
              ext={extView}
              theme={theme}
              typography={typography}
              about={about}
              selected={settingsSel}
              onSelect={(s) => {
                // re-read on open: whether core is stale can change while the app runs
                if (s?.kind === "about") loadAbout();
                setSettingsSel(s);
              }}
            />
          ) : nav === "contacts" ? (
            <ContactList
              bots={bots}
              convs={convs}
              busyByBot={busyByBot}
              selected={editing ? (editing.botId ? { kind: "bot", id: editing.botId } : null) : contact}
              onSelect={(c) => {
                setContact(c);
                setEditing(null);
              }}
            />
          ) : nav !== "messages" ? (
            <Empty label={`${NAV.find((n) => n.id === nav)?.label}：第一版还没做`} />
          ) : (
            <>
              <ListSearch value={query} onChange={setQuery} placeholder="搜索会话、bot 或仓库" />
              <ScrollArea className="min-h-0 flex-1 [mask-image:linear-gradient(to_bottom,transparent,black_0.375rem)]">
                <div className={cn(LIST_BODY, "pt-1.5")}>
                  {convs.length === 0 ? (
                    <p className="text-muted-foreground px-2.5 py-6 text-sm">还没有会话，点右上角 + 发起。</p>
                  ) : (
                    shownConvs.length === 0 && (
                      <p className="text-muted-foreground px-2.5 py-6 text-sm">没有和「{query.trim()}」相关的会话。</p>
                    )
                  )}
                  {shownConvs.map((c) => {
                    const waiting = WAITING[c.attention];
                    const people = activeMembers(c);
                    const face = people[0] ?? c.members[0];
                    return (
                      <div
                        key={c.id}
                        role="button"
                        tabIndex={0}
                        aria-current={c.id === active || undefined}
                        onClick={() => setActive(c.id)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            setActive(c.id);
                          }
                        }}
                        // a div, not a button: the row holds a menu button and nesting buttons is invalid markup
                        className={cn(ROW, "group/item cursor-default py-2.5", c.archived && "opacity-60", rowState(c.id === active))}
                      >
                        {c.shape === "group" ? (
                          <GroupAvatar bots={people.map((m) => m.bot)} busy={busyOfConv(c)} />
                        ) : face ? (
                          <BotAvatar bot={face.bot} busy={busyOfConv(c)} />
                        ) : (
                          <Who kind="bot" />
                        )}
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5">
                            {/* weight is the unread mark: it stays heavy exactly as long as the conversation waits on you */}
                            <span className={cn("truncate text-sm", waiting ? "font-semibold" : "font-medium")}>{c.title}</span>
                            {c.shape === "group" && (
                              <span className="bg-foreground/[0.06] text-muted-foreground shrink-0 rounded px-1 text-[10px] leading-4">群</span>
                            )}
                            {c.archived && (
                              <span className="text-muted-foreground shrink-0 rounded border px-1 text-[10px] leading-[14px]">已归档</span>
                            )}
                            {/* the menu takes this corner on hover; the time gives it up rather than reserving room all the time */}
                            <span className="text-muted-foreground ml-auto shrink-0 pl-1 text-[11px] tabular-nums transition-opacity group-hover/item:opacity-0 group-has-[[data-state=open]]/item:opacity-0">
                              {listTime(c.last_activity_at)}
                            </span>
                          </div>
                          <div className="mt-0.5 flex items-center gap-2">
                            <span className="text-muted-foreground min-w-0 flex-1 truncate text-xs">
                              {c.preview ?? repoName(c.repo_path)}
                            </span>
                            {waiting ? (
                              // opaque, so it keeps its colour on a selected row instead of mixing with the blue
                              <span className="inline-flex shrink-0 items-center rounded-full bg-amber-100 px-1.5 text-[10px] leading-4 font-medium text-amber-700 dark:bg-amber-950 dark:text-amber-300">
                                {waiting}
                              </span>
                            ) : (
                              // running is deliberately quiet: it does not need you
                              c.run_state === "running" && <Loader className="text-muted-foreground/50 size-3 shrink-0 animate-spin" />
                            )}
                          </div>
                        </div>
                        <ConversationMenu
                          conv={c}
                          className="absolute top-2 right-1.5"
                          onRename={() => {
                            setActive(c.id);
                            setRenaming(c.id);
                          }}
                          onGone={dropConversation}
                        />
                      </div>
                    );
                  })}
                </div>
              </ScrollArea>
            </>
          )}
        </section>

        {/* the list starts at the rail and the gap's centre is 4px past its edge, so its width is what is left of x */}
        <Resizer label="调整列表宽度" onDrag={(x) => list_.set(x - RAIL - 4)} onReset={list_.reset} />

        {/* 三、详情 */}
        <main className="@container relative flex min-h-0 min-w-0 flex-1 gap-2" style={NO_DRAG}>
          {nav === "settings" ? (
            <div className={cn(PANEL, "flex min-h-0 min-w-0 flex-1 flex-col")}>
              <header className="flex h-13 shrink-0 items-center px-5" style={DRAG}>
                <span className="text-sm font-semibold">
                  {settingsSel?.kind === "appearance"
                    ? "外观"
                    : settingsSel?.kind === "about"
                      ? "关于"
                      : settingsSel?.kind === "provider"
                      ? "模型 API"
                      : settingsSel?.kind === "executor"
                        ? "执行器"
                        : settingsSel?.kind === "extensions" || (settingsView && settingsView.executors.length === 0)
                          ? "Agent"
                          : "设置"}
                </span>
              </header>
              {settingsSel?.kind === "appearance" ? (
                <AppearancePanel
                  theme={theme}
                  onChange={setTheme}
                  typography={typography}
                  onFont={setFont}
                  onCustomFont={setCustomFont}
                  onSize={setSize}
                />
              ) : settingsSel?.kind === "about" ? (
                <AboutPanel about={about} />
              ) : !settingsView ? (
                <Empty label="" />
              ) : settingsSel?.kind === "executor" ? (
                <ExecutorEditor
                  key={settingsSel.id ?? `new-${settingsSel.type}`}
                  view={settingsView}
                  executor={settingsView.executors.find((e) => e.id === settingsSel.id) ?? null}
                  type={settingsSel.type}
                  env={extView?.environment ?? null}
                  ext={extView}
                  onSaved={(e) => reloadSettings({ kind: "executor", id: e.id, type: e.type })}
                  // back to the card it was opened from
                  onCancel={() => setSettingsSel({ kind: "extensions", id: settingsSel.type })}
                  onDeleted={() => reloadSettings({ kind: "extensions", id: settingsSel.type })}
                  onExtensions={() => setSettingsSel({ kind: "extensions", id: settingsSel.type })}
                />
              ) : settingsSel?.kind === "provider" ? (
                <ProviderEditor
                  key={settingsSel.id ?? "new"}
                  view={settingsView}
                  provider={settingsView.providers.find((p) => p.id === settingsSel.id) ?? null}
                  env={extView?.environment ?? null}
                  bots={bots}
                  onSaved={(p) => reloadSettings({ kind: "provider", id: p.id })}
                  onCancel={() => setSettingsSel(null)}
                  onDeleted={() => reloadSettings(null)}
                />
              ) : settingsSel?.kind === "extensions" || settingsView.executors.length === 0 ? (
                <ExtensionsPanel
                  bump={extBump}
                  view={settingsView}
                  intro={settingsView.executors.length === 0}
                  focus={settingsSel?.kind === "extensions" ? settingsSel.id : undefined}
                  onChanged={() => {
                    reloadExtensions();
                    void api.executorSettings().then(setSettingsView);
                  }}
                  onSelect={setSettingsSel}
                />
              ) : (
                <Empty label="左边选一项设置" />
              )}
            </div>
          ) : nav === "contacts" ? (
            <div className={cn(PANEL, "flex min-h-0 min-w-0 flex-1 flex-col")}>
              <header className="flex h-13 shrink-0 items-center px-5" style={DRAG}>
                <span className="text-sm font-semibold">
                  {editing ? (editing.botId ? "编辑资料" : "新建 Bot") : selectedBot ? "资料" : selectedGroup ? "群资料" : "角色"}
                </span>
              </header>
              {editing ? (
                <BotEditor
                  key={editing.botId ?? `new-${editing.template?.id ?? "blank"}`}
                  bot={editing.botId ? (bots.find((b) => b.id === editing.botId) ?? null) : null}
                  template={editing.template}
                  bots={bots}
                  caps={caps}
                  onManageExecutors={() => setNav("settings")}
                  onCancel={() => setEditing(null)}
                  onSaved={(b) => {
                    setBots((prev) => (prev.some((x) => x.id === b.id) ? prev.map((x) => (x.id === b.id ? b : x)) : [...prev, b]));
                    setContact({ kind: "bot", id: b.id });
                    setEditing(null);
                  }}
                />
              ) : selectedBot ? (
                <BotProfile
                  key={selectedBot.id}
                  bot={selectedBot}
                  caps={caps}
                  convs={convs}
                  busy={busyByBot[selectedBot.id] ?? null}
                  onEdit={() => setEditing({ botId: selectedBot.id, template: null })}
                  onMessage={() => messageBot(selectedBot)}
                  onGroup={() => setStarting({ open: true, botIds: [selectedBot.id] })}
                  onOpenConversation={openConversation}
                  onDeleted={() => setContact(null)}
                />
              ) : selectedGroup ? (
                <GroupProfile
                  key={selectedGroup.id}
                  conv={selectedGroup}
                  bots={bots}
                  presence={presence}
                  busy={busyOfConv(selectedGroup)}
                  onMessage={() => {
                    focusComposer.current = true;
                    openConversation(selectedGroup.id);
                  }}
                  onOpenBot={(id) => setContact({ kind: "bot", id })}
                  onGone={(id) => {
                    dropConversation(id);
                    setContact(null);
                  }}
                />
              ) : (
                <TemplateGallery onPick={(t) => setEditing({ botId: null, template: t })} />
              )}
            </div>
          ) : nav !== "messages" || !conv ? (
            <Empty label={nav === "messages" ? "选一个会话" : "第一版还没做"} className={PANEL} />
          ) : (
            <>
              <div
                className={cn(PANEL, "relative flex min-h-0 min-w-0 flex-1 flex-col")}
                // anywhere on the conversation takes a file, not only the few pixels of the composer
                onDragOver={(e) => {
                  if (!e.dataTransfer.types.includes("Files")) return;
                  e.preventDefault();
                  setDropping(true);
                }}
                onDragLeave={(e) => {
                  if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropping(false);
                }}
                onDrop={(e) => {
                  if (!e.dataTransfer.types.includes("Files")) return;
                  e.preventDefault();
                  setDropping(false);
                  composerHandle.current?.addFiles([...e.dataTransfer.files]);
                }}
              >
                {dropping && (
                  <div className="border-primary/60 bg-background/85 text-primary pointer-events-none absolute inset-2 z-40 flex items-center justify-center rounded-xl border-2 border-dashed text-sm font-medium">
                    松开，添加到这条消息里
                  </div>
                )}
                <header className="flex h-13 shrink-0 items-center gap-3 px-5" style={DRAG}>
                  {group ? (
                    <GroupAvatar bots={members.map((m) => m.bot)} busy={busyOfConv(conv)} />
                  ) : members[0] ? (
                    <BotAvatar bot={members[0].bot} busy={busyOfConv(conv)} />
                  ) : null}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      {renaming === conv.id ? (
                        <RenameInput conv={conv} style={NO_DRAG} className="text-sm" onDone={() => setRenaming(null)} />
                      ) : (
                        <span
                          onClick={() => setRenaming(conv.id)}
                          title="点击重命名"
                          style={NO_DRAG}
                          className="hover:bg-accent cursor-text truncate rounded px-1.5 py-0.5 text-sm font-semibold"
                        >
                          {conv.title}
                        </span>
                      )}
                      {group ? (
                        <Badge variant="secondary" className="px-1 py-0 text-[10px]">
                          群
                        </Badge>
                      ) : (
                        members[0] && (
                          <CapabilityBadge executor={members[0].bot.executor_id} caps={capsOf(caps, members[0].bot)} />
                        )
                      )}
                    </div>
                    <div className="text-muted-foreground truncate px-1.5 text-[11px]">
                      {group
                        ? `${members.length + 1} 位成员 · ${MODES.find((x) => x.id === conv.mode)?.label}${
                            conv.mode === "leader" ? `（群主 ${leaderOf(conv)?.bot.name ?? "-"}）` : ""
                          }`
                        : [members[0]?.bot.name, members[0]?.bot.title].filter(Boolean).join(" · ")}
                      <span className="font-mono"> · {conv.repo_path}</span>
                    </div>
                  </div>
                  {!group && (
                    <span style={NO_DRAG}>
                      <Outline messages={messages} onJump={jump} />
                    </span>
                  )}
                  <Button
                    variant={panelOpen && !contextFor ? "secondary" : "ghost"}
                    size="sm"
                    style={NO_DRAG}
                    title={panelOpen && !contextFor ? "收起成员" : "成员与模式"}
                    onClick={() => {
                      // the context window is in that slot; the first press brings the members back
                      if (contextFor) return setContextFor(null), setPanel((p) => ({ ...p, [conv.shape]: true }));
                      setPanel((p) => ({ ...p, [conv.shape]: !p[conv.shape] }));
                    }}
                  >
                    <Users className="size-4" />
                    {members.length + 1}
                  </Button>
                </header>

                <MentionNames.Provider value={names}>
                  {/* no rules above or below: the stream fades out under the header and composer instead */}
                  <ScrollArea
                    className="min-h-0 flex-1 [mask-image:linear-gradient(to_bottom,transparent,black_1rem,black_calc(100%_-_1rem),transparent)]"
                    ref={scrollRoot}
                  >
                    {/* the one place text is content: select across messages, quote a passage, copy code */}
                    <div className="cursor-auto space-y-3 px-5 py-4 select-text">
                      {messages.length === 0 && streamed === 0 && (
                        // absolute against the scroll area root: the scrolled content is only as tall as its rows
                        <div className="text-muted-foreground absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center">
                          {group ? (
                            <>
                              <GroupAvatar bots={members.map((m) => m.bot)} size="lg" />
                              <p className="text-sm">群里有 {members.map((m) => m.bot.name).join("、")}</p>
                              <p className="max-w-sm text-xs">{MODES.find((x) => x.id === conv.mode)?.hint}</p>
                            </>
                          ) : (
                            <>
                              <MessageSquarePlus className="size-7 opacity-40" />
                              <p className="text-sm">还没有消息</p>
                              <p className="text-xs">发第一条消息开始。它会成为这个会话的标题。</p>
                            </>
                          )}
                        </div>
                      )}
                      {messages.map((m) => (
                        // the id is what the outline scrolls to
                        <div key={m.id} id={`m-${m.id}`}>
                          <MessageCard
                            conversationId={conv.id}
                            message={m}
                            group={group}
                            author={m.author_member_id ? memberById.get(m.author_member_id) : undefined}
                            onQuote={quote}
                          />
                        </div>
                      ))}
                      {Object.entries(streams).map(([memberId, text]) =>
                        text.trim() ? (
                          <StreamingBubble key={memberId} text={text} author={memberById.get(memberId)} group={group} />
                        ) : null,
                      )}
                    </div>
                  </ScrollArea>
                </MentionNames.Provider>

                <PresenceStrip conv={conv} presence={presence} />
                <Composer
                  // pending uploads belong to one conversation
                  key={conv.id}
                  conv={conv}
                  bots={bots}
                  sessions={sessions}
                  sessionOptions={sessionOptions}
                  quota={quota}
                  messages={messages}
                  draft={draft}
                  setDraft={setDraft}
                  inputRef={composer}
                  handle={composerHandle}
                  onContext={setContextFor}
                  onRename={() => setRenaming(conv.id)}
                />
              </div>
              {contextFor ? (
                <ContextPanel
                  conversationId={conv.id}
                  memberId={contextFor}
                  title={memberById.get(contextFor)?.bot.name ?? ""}
                  used={sessions[contextFor]?.context?.used}
                  onClose={() => setContextFor(null)}
                />
              ) : (
                panelOpen && (
                  <MembersPanel
                    conv={conv}
                    bots={bots}
                    presence={presence}
                    onClose={() => setPanel((p) => ({ ...p, [conv.shape]: false }))}
                    onOpenBot={(id) => {
                      setNav("contacts");
                      setContact({ kind: "bot", id });
                      setEditing(null);
                    }}
                  />
                )
              )}
            </>
          )}
        </main>
        </div>
      </div>

      <NewConversation
        open={starting.open}
        onOpenChange={(open) => setStarting((s) => ({ ...s, open }))}
        bots={bots}
        capabilities={caps}
        defaultDir={defaultDir}
        initialBotIds={starting.botIds}
        onCreated={(c) => {
          setConvs((prev) => [c, ...prev.filter((x) => x.id !== c.id)]);
          openConversation(c.id);
        }}
      />

      {/* below the headers: over their drag region a toast could not be clicked or hovered */}
      <Toaster position="top-center" offset={{ top: 68 }} />
    </TooltipProvider>
    </SourceRefs.Provider>
    </Executors.Provider>
    </Logos.Provider>
  );
}

function Empty({ label, className }: { label: string; className?: string }) {
  return (
    <div className={cn("text-muted-foreground flex flex-1 items-center justify-center px-6 text-center text-sm", className)}>
      {label}
    </div>
  );
}
