import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Archive, Loader, MessageSquarePlus, Plus, Users, WifiOff } from "lucide-react";
import {
  activeMembers,
  api,
  connect,
  isThought,
  type Bot,
  type Capabilities,
  type Conversation,
  type Executor,
  type ExecutorSettings,
  type ExtensionsView,
  type Logo,
  type Member,
  type Message,
  type Presence,
  type Quota,
  type Quote,
  type SessionInfo,
  type SessionOptions,
  type SourceRef,
  type StepsBody,
} from "./api";
import { DRAG, NO_DRAG } from "./app-region";
import { BotAvatar, busyOf, GroupAvatar, Logos, type Busy } from "./bot-avatar";
import { CapabilityBadge } from "./capabilities";
import { MessageCard, TurnView, Who } from "./cards";
import { Composer, type ComposerHandle } from "./composer";
import { BotEditor, BotProfile, ContactList, forgetModels, GroupProfile, TemplateGallery, type Contact } from "./contacts";
import { ConversationMenu, RenameInput } from "./conversation-menu";
import { Executors, HarnessLabels, SourceRefs } from "./executors";
import { useI18n, type I18n } from "./i18n";
import { LIST_BODY, ListSearch, ROW, rowState } from "./list";
import { MentionNames } from "./markdown";
import { MembersPanel } from "./members-panel";
import { leaderOf } from "./mentions";
import { PAGE_IN, useAtLeast } from "./motion";
import { NavRail, RAIL, type Nav } from "./nav-rail";
import { NewConversation, startDirect } from "./new-conversation";
import { Outline } from "./outline";
import { PresenceStrip } from "./presence";
import { ProfilePanel } from "./profile";
import { Resizer, useColumnWidth } from "./resizable";
import { SettingsList, SettingsPage, type SettingsRoute } from "./settings";
import type { AboutState } from "./settings/about";
import type { Template } from "./templates";
import { useTheme } from "./theme";
import { pickFloor, transcript, type Row, type Turn } from "./transcript";
import { useTypography } from "./typography";
import { toast } from "sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

/** What a jump to a turn lands on: its reply once it has one, else the row it started with. */
const anchorId = (turn: Turn) => {
  const id = turn.text?.id ?? turn.anchor?.id;
  return id ? `m-${id}` : undefined;
};

/** Every column past the rail floats on the chrome; gaps separate them, never lines. */
const PANEL = "bg-background shadow-panel overflow-hidden rounded-xl";

/** The list wants a glanceable time, not a precise one. */
function listTime({ t, clock, day }: Pick<I18n, "t" | "clock" | "day">, ts: number): string {
  const d = new Date(ts);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return clock(ts);
  const yesterday = new Date(today.getTime() - 86400000);
  if (d.toDateString() === yesterday.toDateString()) return t("time.yesterday");
  return day(ts);
}

/** Exactly one unread meaning: this one is waiting for you. Running is never unread. */
const isWaiting = (attention: Conversation["attention"]): attention is Exclude<Conversation["attention"], "none"> => attention !== "none";

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
  const i18n = useI18n();
  const { t, list, sync } = i18n;
  const { theme, setTheme } = useTheme();
  const { typography, setFont, setCustomFont, setSize } = useTypography();
  const [nav, setNav] = useState<Nav>("messages");
  const [bots, setBots] = useState<Bot[]>([]);
  /** by agent: its source settles its channel, and the channel settles what it can do */
  const [caps, setCaps] = useState<Record<string, Capabilities>>({});
  const [logos, setLogos] = useState<Logo[]>([]);
  const [executors, setExecutors] = useState<Executor[]>([]);
  /** model APIs by name, so an agent's source can be labelled anywhere */
  const [sourceRefs, setSourceRefs] = useState<SourceRef[]>([]);
  /** what each harness is called, by type */
  const [harnessLabels, setHarnessLabels] = useState<Record<string, string>>({});
  /** agents, harnesses and model APIs as the settings page edits them; loaded when it is first opened */
  const [settingsView, setSettingsView] = useState<ExecutorSettings | null>(null);
  /** null until a page is picked; the settings page then opens on whatever a fresh install needs first */
  const [settingsRoute, setSettingsRoute] = useState<SettingsRoute | null>(null);
  /** what is installed and what could be; refreshed whenever core says extensions changed */
  const [extView, setExtView] = useState<ExtensionsView | null>(null);
  const [about, setAbout] = useState<AboutState>(null);
  const [defaultDir, setDefaultDir] = useState("");
  const [convs, setConvs] = useState<Conversation[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  /** text still being written, per member of the open conversation */
  const [streams, setStreams] = useState<Record<string, string>>({});
  /** thinking still coming in, per thought of the open conversation; a finished one is read from the log */
  const [thinking, setThinking] = useState<Record<string, string>>({});
  /** what every running member is doing, across all conversations */
  const [presence, setPresence] = useState<Record<string, Presence>>({});
  /** what each member's session runs with; kept across switches, so going back shows it at once */
  const [sessions, setSessions] = useState<Record<string, SessionInfo>>({});
  /** plan usage per agent, which is account-wide */
  const [quota, setQuota] = useState<Record<string, Quota | null>>({});
  /** what each member's session can be switched to */
  const [sessionOptions, setSessionOptions] = useState<Record<string, SessionOptions>>({});
  const [draft, setDraft] = useState("");
  /** the message the next send replies to */
  const [quoting, setQuoting] = useState<Quote | null>(null);
  const [contact, setContact] = useState<Contact | null>(null);
  const [editing, setEditing] = useState<{ botId: string | null; template: Template | null } | null>(null);
  const [starting, setStarting] = useState<{ open: boolean; botIds: string[] }>({ open: false, botIds: [] });
  const [panel, setPanel] = usePanelOpen();
  /** room for the members panel as a column beside the chat, rather than a sheet over it */
  const [wide, detailRef] = useAtLeast(768);
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
  /** the turn whose words are shown as they come, kept until it ends: see pickFloor */
  const floorRef = useRef<{ conv: string | null; turnId: string | null }>({ conv: null, turnId: null });
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [query, setQuery] = useState("");
  /** the event stream is down and has been for more than a blip */
  const [offline, setOffline] = useState(false);

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
    // a jump that lands mid-history needs to say where it landed
    el.classList.add("found");
    setTimeout(() => el.classList.remove("found"), 1800);
  };

  /** The editor only moves on once the list it points into has the row: a new id looked up in the old list reads as "new". */
  const reloadSettings = (next: SettingsRoute) =>
    void api.executorSettings().then((v) => {
      setSettingsView(v);
      setSettingsRoute(next);
    });
  const reloadExtensions = () => void api.extensions().then(setExtView).catch(() => {});
  const loadAbout = () =>
    void api
      .about()
      .then((r) => setAbout("version" in r ? r : { error: (r as { error?: string }).error ?? t("app.coreSilent") }))
      .catch((e: unknown) => setAbout({ error: String(e) }));
  const openSettings = (r: SettingsRoute) => {
    // re-read on open: whether core is stale can change while the app runs
    if (r.page === "about") loadAbout();
    setSettingsRoute(r);
  };

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
        setHarnessLabels(Object.fromEntries((s.harnesses ?? []).map((h) => [h.type, h.label])));
        setDefaultDir(s.defaultDir ?? "");
        setPresence(Object.fromEntries((s.presence ?? []).map((p) => [p.memberId, p])));
        if (s.preferences) sync(s.preferences.locale);
        if (!activeRef.current && s.conversations[0]) setActive(s.conversations[0].id);
      });
    /** Everything core wrote for this window to read, fetched again: after a dropped stream, or once it writes in another language. */
    const reload = () => {
      void load();
      const id = activeRef.current;
      if (id) {
        void api.messages(id).then((r) => {
          if (activeRef.current !== id) return;
          setMessages(r.messages);
          setStreams(r.streams ?? {});
          setThinking(r.thoughts ?? {});
        });
        void loadStatus(id);
      }
    };
    void load();
    // a reconnect that lands within a second is not news; one that does not is
    let downSince: ReturnType<typeof setTimeout> | null = null;
    const onLink = (up: boolean) => {
      if (up) {
        if (downSince) clearTimeout(downSince);
        downSince = null;
        setOffline(false);
      } else {
        downSince ??= setTimeout(() => setOffline(true), 1500);
      }
    };
    const stop = connect((m) => {
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
          // a harness that came or went changes what the agent picker groups under
          void api.state(archivedRef.current).then((s) => setHarnessLabels(Object.fromEntries((s.harnesses ?? []).map((h) => [h.type, h.label]))));
          if (settingsLoaded.current) reloadExtensions();
          return;
        case "bots":
          setBots(m.bots);
          return;
        case "preferences":
          sync(m.locale);
          // notices and logo names come back in the new language; executors and extensions are pushed right after
          reload();
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
        case "thinking":
          if (m.conversationId === activeRef.current) {
            setThinking((s) => ({ ...s, [m.id]: (s[m.id] ?? "") + m.text }));
          }
          return;
        case "message": {
          if (m.conversationId !== activeRef.current) return;
          const author = m.message.author_member_id;
          if (m.message.card_kind === "text" && author) setStreams((s) => omit(s, author));
          if (m.message.card_kind === "steps") {
            // a thought that has ended is in the log whole; what streamed of it is no longer needed
            const ended = (JSON.parse(m.message.body_json) as StepsBody).steps.filter((x) => isThought(x) && x.endedAt !== undefined);
            if (ended.length > 0) setThinking((s) => ended.reduce((rest, x) => omit(rest, x.id), s));
          }
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
    }, reload, onLink);
    return () => {
      if (downSince) clearTimeout(downSince);
      stop();
    };
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
    setThinking({});
    setMessages([]);
    setQuoting(null);
    void api.messages(active).then((r) => {
      setMessages(r.messages);
      setStreams(r.streams ?? {});
      setThinking(r.thoughts ?? {});
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

  // a pane that changes height under a reader parked at the bottom keeps them there: the presence strip unfolding, the window resizing
  useEffect(() => {
    const vp = viewport();
    if (!vp) return;
    const ro = new ResizeObserver(() => {
      if (stick.current) vp.scrollTop = vp.scrollHeight;
    });
    ro.observe(vp);
    return () => ro.disconnect();
  }, [loadedFor, nav]);

  /** who is doing what in the open conversation */
  const present = useMemo(() => Object.values(presence).filter((p) => p.conversationId === active), [presence, active]);
  // one live speaker on screen at a time; the rest wait in the presence strip
  const floor = useMemo(() => {
    if (floorRef.current.conv !== active) floorRef.current = { conv: active, turnId: null };
    floorRef.current.turnId = pickFloor(messages, present, streams, floorRef.current.turnId);
    return floorRef.current.turnId;
  }, [messages, present, streams, active]);
  const rows = useMemo(() => transcript(messages, present, streams, floor), [messages, present, streams, floor]);
  const floorRow = rows.find((r): r is Extract<Row, { kind: "turn" }> => r.kind === "turn" && r.floor);
  // only the floor's words move the page: a member writing off screen must not scroll it
  const streamed = floorRow?.turn.memberId ? (streams[floorRow.turn.memberId]?.length ?? 0) : 0;
  // a thought opened while it streams grows the transcript as much as a reply does
  const thought = floorRow?.turn.steps.reduce((n, s) => n + (isThought(s) ? (thinking[s.id]?.length ?? 0) : 0), 0) ?? 0;
  const rowKeys = rows.map((r) => r.key).join("\n");
  // a row landing or moving, such as a reply settling above the one being written, snaps before paint: the reader parked
  // at the bottom sees the bottom stay put and the older rows shift up, never the row they are reading pushed down
  useLayoutEffect(() => {
    if (!stick.current) return;
    const vp = viewport();
    if (vp) vp.scrollTop = vp.scrollHeight;
  }, [rowKeys]);
  // words arriving a few at a time are followed smoothly; a steps card grows in place
  useEffect(() => {
    if (!stick.current) return;
    const vp = viewport();
    vp?.scrollTo({ top: vp.scrollHeight, behavior: "smooth" });
  }, [messages, streamed, thought]);
  // the rows the log had when it was read; only what lands after them arrives with motion
  const settledRows = useMemo(() => new Set(rows.map((r) => r.key)), [loadedFor]);

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
        toast.error(t("app.startFailed"), { description: r.error });
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

  /** Replying puts the passage in the composer's reply bar, not into what you are typing. */
  const quote = (q: Quote) => {
    setQuoting(q);
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
    <HarnessLabels.Provider value={harnessLabels}>
    <SourceRefs.Provider value={sourceRefs}>
    <TooltipProvider delayDuration={200}>
      <div className="bg-sidebar text-sidebar-foreground flex h-full">
        {/* 1. The rail: a fixed strip of icons. Two entries do not fill a column, so the width goes to the list and the conversation */}
        <NavRail nav={nav} onNav={setNav} waiting={waiting} />

        {/* the margins around the panels are chrome too: the window drags by them */}
        <div className="text-foreground flex min-w-0 flex-1 py-2 pr-2" style={DRAG}>
        {nav === "profile" ? (
          // one person has nothing to list, so the page takes the list's width too
          <main className={cn(PANEL, "flex min-h-0 min-w-0 flex-1 flex-col", PAGE_IN)} style={NO_DRAG}>
            <ProfilePanel />
          </main>
        ) : (
        <>
        {/* 2. The list */}
        <section className={cn(PANEL, "flex min-h-0 shrink-0 flex-col")} style={{ width: list_.width, ...NO_DRAG }}>
          <header className="flex h-13 shrink-0 items-center justify-between pr-2.5 pl-4.5" style={DRAG}>
            <h1 className="text-[15px] font-semibold">{t(`nav.${nav}`)}</h1>
            {nav === "messages" && (
              <div className="flex items-center gap-1" style={NO_DRAG}>
                <Button
                  variant="ghost"
                  size="icon"
                  className={cn("size-7 rounded-lg", showArchived ? "bg-selected text-primary hover:bg-selected hover:text-primary" : "text-muted-foreground")}
                  title={showArchived ? t("app.activeOnly") : t("app.showArchived")}
                  aria-pressed={showArchived}
                  onClick={() => setShowArchived((v) => !v)}
                >
                  <Archive className="size-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="bg-foreground/[0.05] hover:bg-foreground/10 size-7 rounded-lg"
                  title={t("newConversation.title")}
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
                title={t("bot.new")}
                onClick={() => {
                  setContact(null);
                  setEditing(null);
                }}
              >
                <Plus className="size-4" />
              </Button>
            )}
          </header>
          <div key={nav} className={cn("flex min-h-0 flex-1 flex-col", PAGE_IN)}>
            {nav === "settings" ? (
              <SettingsList view={settingsView} ext={extView} theme={theme} typography={typography} about={about} route={settingsRoute} onRoute={openSettings} />
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
            ) : (
              <>
                <ListSearch value={query} onChange={setQuery} placeholder={t("app.search")} />
                <ScrollArea className="min-h-0 flex-1 [mask-image:linear-gradient(to_bottom,transparent,black_0.375rem)]">
                  <div className={cn(LIST_BODY, "pt-1.5")}>
                    {convs.length === 0 ? (
                      <p className="text-muted-foreground px-2.5 py-6 text-sm">{t("app.noConversations")}</p>
                    ) : (
                      shownConvs.length === 0 && (
                        <p className="text-muted-foreground px-2.5 py-6 text-sm">{t("app.noMatches", { query: query.trim() })}</p>
                      )
                    )}
                    {shownConvs.map((c) => {
                      const waiting = isWaiting(c.attention) ? t(`attention.${c.attention}`) : null;
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
                                <span className="bg-foreground/[0.06] text-muted-foreground shrink-0 rounded px-1 text-[10px] leading-4">
                                  {t("conversation.groupBadge")}
                                </span>
                              )}
                              {c.archived && (
                                <span className="text-muted-foreground shrink-0 rounded border px-1 text-[10px] leading-[14px]">
                                  {t("app.archived")}
                                </span>
                              )}
                              {/* the menu takes this corner on hover; the time gives it up rather than reserving room all the time */}
                              <span className="text-muted-foreground ml-auto shrink-0 pl-1 text-[11px] tabular-nums transition-opacity group-hover/item:opacity-0 group-has-[[data-state=open]]/item:opacity-0">
                                {listTime(i18n, c.last_activity_at)}
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
          </div>
        </section>

        {/* the list starts at the rail and the gap's centre is 4px past its edge, so its width is what is left of x */}
        <Resizer label={t("app.resizeList")} onDrag={(x) => list_.set(x - RAIL - 4)} onReset={list_.reset} />

        {/* 3. The detail */}
        <main ref={detailRef} className="relative flex min-h-0 min-w-0 flex-1" style={NO_DRAG}>
          {nav === "settings" ? (
            <div className={cn(PANEL, "flex min-h-0 min-w-0 flex-1 flex-col", PAGE_IN)}>
              <SettingsPage
                route={settingsRoute}
                onRoute={openSettings}
                view={settingsView}
                ext={extView}
                bots={bots}
                about={about}
                theme={theme}
                onTheme={setTheme}
                typography={typography}
                onFont={setFont}
                onCustomFont={setCustomFont}
                onSize={setSize}
                onReload={reloadSettings}
                onRefresh={() => void api.executorSettings().then(setSettingsView)}
                onExtensions={setExtView}
                onReloadExtensions={reloadExtensions}
              />
            </div>
          ) : nav === "contacts" ? (
            <div className={cn(PANEL, "flex min-h-0 min-w-0 flex-1 flex-col", PAGE_IN)}>
              <header className="flex h-13 shrink-0 items-center px-5" style={DRAG}>
                <span className="text-sm font-semibold">
                  {editing
                    ? editing.botId
                      ? t("app.editProfile")
                      : t("bot.new")
                    : selectedBot
                      ? t("app.profile")
                      : selectedGroup
                        ? t("app.groupProfile")
                        : t("app.roles")}
                </span>
              </header>
              <div
                key={editing ? `edit:${editing.botId ?? "new"}` : selectedBot ? `bot:${selectedBot.id}` : selectedGroup ? `group:${selectedGroup.id}` : "gallery"}
                className={cn("flex min-h-0 flex-1 flex-col", PAGE_IN)}
              >
                {editing ? (
                  <BotEditor
                    key={editing.botId ?? `new-${editing.template?.id ?? "blank"}`}
                    bot={editing.botId ? (bots.find((b) => b.id === editing.botId) ?? null) : null}
                    template={editing.template}
                    bots={bots}
                    caps={caps}
                    onManageAgents={(id) => {
                      setNav("settings");
                      setSettingsRoute({ page: "agent", id });
                    }}
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
                  <TemplateGallery onPick={(template) => setEditing({ botId: null, template })} />
                )}
              </div>
            </div>
          ) : !conv ? (
            <Empty label={t("app.pickConversation")} className={PANEL} />
          ) : (
            <div className={cn("relative flex min-h-0 min-w-0 flex-1", PAGE_IN)}>
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
                  <div className="border-primary/60 bg-background/85 text-primary animate-in fade-in-0 pointer-events-none absolute inset-2 z-40 flex items-center justify-center rounded-xl border-2 border-dashed text-sm font-medium duration-150">
                    {t("app.dropFiles")}
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
                          title={t("conversation.clickToRename")}
                          style={NO_DRAG}
                          className="hover:bg-accent cursor-text truncate rounded px-1.5 py-0.5 text-sm font-semibold"
                        >
                          {conv.title}
                        </span>
                      )}
                      {group ? (
                        <Badge variant="secondary" className="px-1 py-0 text-[10px]">
                          {t("conversation.groupBadge")}
                        </Badge>
                      ) : (
                        members[0] && (
                          <CapabilityBadge executor={members[0].executor_id} caps={caps[members[0].executor_id]} />
                        )
                      )}
                    </div>
                    <div className="text-muted-foreground truncate px-1.5 text-[11px]">
                      {group
                        ? `${t("conversation.groupSubtitle", { count: members.length + 1, mode: t(`mode.${conv.mode}`) })}${
                            conv.mode === "leader" ? t("conversation.leaderSuffix", { name: leaderOf(conv)?.bot.name ?? "-" }) : ""
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
                    variant={panelOpen ? "secondary" : "ghost"}
                    size="sm"
                    style={NO_DRAG}
                    title={panelOpen ? t("app.hideMembers") : t("app.membersAndMode")}
                    onClick={() => setPanel((p) => ({ ...p, [conv.shape]: !p[conv.shape] }))}
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
                    <div className="cursor-auto space-y-4 px-5 py-4 select-text">
                      {/* only once the log is read: while it loads, an empty pane must not claim there is nothing in it */}
                      {loadedFor === conv.id && messages.length === 0 && streamed === 0 && (
                        // absolute against the scroll area root: the scrolled content is only as tall as its rows
                        <div className="text-muted-foreground absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center">
                          {group ? (
                            <>
                              <GroupAvatar bots={members.map((m) => m.bot)} size="lg" />
                              <p className="text-sm">{t("app.groupHas", { names: list(members.map((m) => m.bot.name)) })}</p>
                              <p className="max-w-sm text-xs">{t(`mode.${conv.mode}.hint`)}</p>
                            </>
                          ) : (
                            <>
                              <MessageSquarePlus className="size-7 opacity-40" />
                              <p className="text-sm">{t("app.noMessages")}</p>
                              <p className="text-xs">{t("app.firstMessage")}</p>
                            </>
                          )}
                        </div>
                      )}
                      {rows.map((row) =>
                        row.kind === "message" ? (
                          // the id is what the outline scrolls to
                          <div key={row.key} id={`m-${row.message.id}`} className={cn(!settledRows.has(row.key) && PAGE_IN)}>
                            <MessageCard
                              conversationId={conv.id}
                              message={row.message}
                              group={group}
                              author={row.message.author_member_id ? memberById.get(row.message.author_member_id) : undefined}
                              onQuote={quote}
                              onJump={jump}
                            />
                          </div>
                        ) : (
                          // a reply points at the turn's answer; before there is one, at where the turn starts
                          <div key={row.key} id={anchorId(row.turn)} className={cn(!settledRows.has(row.key) && PAGE_IN)}>
                            <TurnView
                              conversationId={conv.id}
                              turn={row.turn}
                              live={row.live}
                              stream={row.floor && row.turn.memberId ? streams[row.turn.memberId] : undefined}
                              thinking={thinking}
                              author={row.turn.memberId ? memberById.get(row.turn.memberId) : undefined}
                              group={group}
                              onQuote={quote}
                              root={conv.repo_path}
                            />
                          </div>
                        ),
                      )}
                    </div>
                  </ScrollArea>
                </MentionNames.Provider>

                <PresenceStrip conv={conv} presence={presence} />
                <Composer
                  // pending uploads belong to one conversation
                  key={conv.id}
                  conv={conv}
                  sessions={sessions}
                  sessionOptions={sessionOptions}
                  quota={quota}
                  messages={messages}
                  draft={draft}
                  setDraft={setDraft}
                  quote={quoting}
                  setQuote={setQuoting}
                  inputRef={composer}
                  handle={composerHandle}
                  onRename={() => setRenaming(conv.id)}
                />
              </div>
              <MembersPanel
                open={panelOpen}
                mode={wide ? "column" : "overlay"}
                conv={conv}
                bots={bots}
                presence={presence}
                sessions={{ info: sessions, options: sessionOptions, quota }}
                onClose={() => setPanel((p) => ({ ...p, [conv.shape]: false }))}
                onOpenBot={(id) => {
                  setNav("contacts");
                  setContact({ kind: "bot", id });
                  setEditing(null);
                }}
              />
            </div>
          )}
        </main>
        </>
        )}
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

      <div
        role="status"
        aria-hidden={!offline || undefined}
        className={cn(
          "bg-foreground text-background fixed top-[68px] left-1/2 z-50 flex -translate-x-1/2 items-center gap-2 rounded-full px-3 py-1.5 text-xs shadow-lg transition-[opacity,translate] duration-200 ease-soft",
          offline ? "translate-y-0 opacity-100" : "pointer-events-none -translate-y-2 opacity-0",
        )}
      >
        <WifiOff className="size-3.5" />
        {t("app.offline")}
      </div>

      {/* below the headers: over their drag region a toast could not be clicked or hovered */}
      <Toaster position="top-center" offset={{ top: 68 }} />
    </TooltipProvider>
    </SourceRefs.Provider>
    </HarnessLabels.Provider>
    </Executors.Provider>
    </Logos.Provider>
  );
}

function Empty({ label, className }: { label: string; className?: string }) {
  return (
    <div className={cn("text-muted-foreground flex flex-1 items-center justify-center px-6 text-center text-sm", PAGE_IN, className)}>
      {label}
    </div>
  );
}
