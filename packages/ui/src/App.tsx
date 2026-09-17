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
import { BotCardActions, BotCardTrigger } from "./bot-card";
import { CapabilityBadge } from "./capabilities";
import { MessageCard, TurnView, Who } from "./cards";
import { Composer, type ComposerHandle } from "./composer";
import { BotEditor, BotProfile, ContactList, forgetModels, GroupProfile, TemplateGallery, type Contact } from "./contacts";
import { ConversationMenu, RenameInput } from "./conversation-menu";
import { Executors, HarnessLabels, SourceRefs } from "./executors";
import { useI18n, type I18n } from "./i18n";
import { LIST_BODY, ListSearch, ROW, rowState } from "./list";
import { MembersPanel } from "./members-panel";
import { MentionBots } from "./mention-chip";
import type { EditorHandle } from "./mention-editor";
import { leaderOf } from "./mentions";
import { PAGE_IN, useAtLeast } from "./motion";
import { SelectionMenu } from "./selection";
import { NavRail, RAIL, type Nav } from "./nav-rail";
import { PlaceChip, repoName } from "./location";
import { NewConversation, startDirect } from "./new-conversation";
import { SessionSwitcher, StaleNote } from "./session-switcher";
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


const omit = <T,>(rec: Record<string, T>, key: string): Record<string, T> => {
  if (!(key in rec)) return rec;
  const next = { ...rec };
  delete next[key];
  return next;
};

/** The members panel is a group's alone; whether it stands open is remembered across groups and restarts. */
function usePanelOpen() {
  const [open, setOpen] = useState<boolean>(() => {
    try {
      const v: unknown = JSON.parse(localStorage.getItem("roster.membersPanel") ?? "true");
      // remembered per shape before 1:1s lost their panel
      return typeof v === "boolean" ? v : Boolean((v as { group?: boolean } | null)?.group ?? true);
    } catch {
      return true;
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

const REMEMBERED_CONVERSATION = "roster.activeConversation";
const LAST_SESSION = "roster.lastSession";

/** Per bot, the direct chat open last: where its entry goes back to when no session waits on you. */
function lastSessions(): Record<string, string> {
  try {
    return (JSON.parse(localStorage.getItem(LAST_SESSION) ?? "{}") as Record<string, string> | null) ?? {};
  } catch {
    return {};
  }
}

function rememberedConversation(): string | null {
  try {
    return localStorage.getItem(REMEMBERED_CONVERSATION);
  } catch {
    return null;
  }
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
  const [convs, setConvs] = useState<Conversation[]>([]);
  const [active, setActive] = useState<string | null>(null);
  // the open chat survives a reload; it is adopted once the list confirms it still exists
  useEffect(() => {
    try {
      if (active) localStorage.setItem(REMEMBERED_CONVERSATION, active);
    } catch {
      // a chat that cannot be remembered still opens
    }
  }, [active]);
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
  const transcriptRoot = useRef<HTMLDivElement>(null);
  const composer = useRef<EditorHandle>(null);
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
        setPresence(Object.fromEntries((s.presence ?? []).map((p) => [p.memberId, p])));
        if (s.preferences) sync(s.preferences.locale);
        if (!activeRef.current) {
          const kept = rememberedConversation();
          const open = (kept && s.conversations.find((c) => c.id === kept)) ?? s.conversations[0];
          if (open) setActive(open.id);
        }
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

  /** A bot's open direct chats, in the list's order: what waits on you first, then the latest. */
  const sessionsOf = (botId: string) =>
    convs.filter((c) => c.shape === "direct" && !c.archived && activeMembers(c).some((m) => m.bot.id === botId));
  const lastSession = useRef(lastSessions());
  useEffect(() => {
    const c = active ? convs.find((x) => x.id === active) : undefined;
    const bot = c?.shape === "direct" ? activeMembers(c)[0]?.bot : undefined;
    if (!bot || !c || lastSession.current[bot.id] === c.id) return;
    lastSession.current[bot.id] = c.id;
    try {
      localStorage.setItem(LAST_SESSION, JSON.stringify(lastSession.current));
    } catch {
      // still remembered for this window
    }
  }, [active, convs]);
  /** Which of a bot's sessions its entry opens: the one waiting on you longest, else the one open last, else the latest. */
  const entryOf = (botId: string, sessions: Conversation[]): Conversation | undefined =>
    sessions.find((c) => isWaiting(c.attention)) ?? sessions.find((c) => c.id === lastSession.current[botId]) ?? sessions[0];

  const adopt = (c: Conversation) => {
    setConvs((prev) => [c, ...prev.filter((x) => x.id !== c.id)]);
    focusComposer.current = true;
    openConversation(c.id);
  };

  // the member being brought onto its bot's current setup, so the note that asked shows the wait
  const [syncing, setSyncing] = useState<string | null>(null);
  /** A 1:1's bot onto the setup it has now: a fresh backend session, handed the chat again. */
  const syncMember = async (convId: string, memberId: string) => {
    setSyncing(memberId);
    const r = await api.syncMember(convId, memberId);
    setSyncing(null);
    if (r.error) toast.error(r.error);
  };

  /** Another session with the same bot, in a chat space of its own, opened at once. */
  const newSession = async (bot: Bot) => {
    const r = await startDirect(bot);
    if (!r.conversation) {
      toast.error(t("app.startFailed"), { description: r.error });
      return;
    }
    adopt(r.conversation);
  };

  /** The bot's own entry, like any messenger: the session waiting on you, else the one open last, else the latest; none at all makes one. */
  const messageBot = async (bot: Bot) => {
    const id = entryOf(bot.id, sessionsOf(bot.id))?.id;
    if (!id) return newSession(bot);
    focusComposer.current = true;
    openConversation(id);
  };

  const waiting = convs.filter((c) => c.attention !== "none").length;
  const q = query.trim().toLowerCase();
  const shownConvs = q
    ? convs.filter((c) =>
        [c.title, c.preview ?? "", c.dir_kind === "repo" ? repoName(c.repo_path) : "", ...c.members.map((m) => m.bot.name)].some((s) =>
          s.toLowerCase().includes(q),
        ),
      )
    : convs;
  // direct chats fold into one entry per bot, the list's order deciding which session fronts it; everything else is its own row
  const entries: Array<{ conv: Conversation; sessions: Conversation[] | null }> = [];
  {
    const byBot = new Map<string, Conversation[]>();
    for (const c of shownConvs) {
      const bot = c.shape === "direct" && !c.archived ? activeMembers(c)[0]?.bot : undefined;
      if (!bot) {
        entries.push({ conv: c, sessions: null });
        continue;
      }
      const mine = byBot.get(bot.id);
      if (mine) mine.push(c);
      else {
        const sessions = [c];
        byBot.set(bot.id, sessions);
        entries.push({ conv: c, sessions });
      }
    }
  }
  const members = activeMembers(conv);
  const memberById = useMemo(() => new Map<string, Member>((conv?.members ?? []).map((m) => [m.id, m])), [conv]);
  /** Replying puts the passage in the composer's reply bar, not into what you are typing; who said it is read off the message. */
  const quote = (messageId: string, text: string) => {
    const said = messages.find((m) => m.id === messageId);
    const author = said?.author_member_id ? memberById.get(said.author_member_id) : undefined;
    setQuoting({ messageId, name: author?.bot.name, text });
    composer.current?.focus();
  };
  const mentionable = useMemo(() => (conv?.members ?? []).map((m) => m.bot), [conv]);
  const group = conv?.shape === "group";
  const panelOpen = conv?.shape === "group" && panel;
  const selectedBot = contact?.kind === "bot" ? bots.find((b) => b.id === contact.id) : undefined;
  const selectedGroup = contact?.kind === "group" ? convs.find((c) => c.id === contact.id && !c.archived) : undefined;

  /** What a bot's card can do, wherever its face is clicked. */
  const cardActions: BotCardActions = {
    message: (bot) => void messageBot(bot),
    profile: (bot) => {
      setNav("contacts");
      setContact({ kind: "bot", id: bot.id });
      setEditing(null);
    },
    // @name addresses someone in a group; alone with a bot there is no one else to address
    ...(members.length > 1
      ? {
          mention: (bot: Bot) => {
            setDraft((d) => (d && !/\s$/.test(d) ? `${d} @${bot.name} ` : `${d}@${bot.name} `));
            composer.current?.focus();
          },
        }
      : {}),
  };

  return (
    <Logos.Provider value={logos}>
    <BotCardActions.Provider value={cardActions}>
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
                    {entries.map(({ conv: c, sessions: many }) => {
                      const people = activeMembers(c);
                      const face = people[0] ?? c.members[0];
                      const all = many ?? [c];
                      // a bot's entry fronts the session that needs you, else the one open last, else the latest
                      const target = many && face ? (entryOf(face.bot.id, many) ?? c) : c;
                      const current = all.some((s) => s.id === active);
                      const menuFor = many ? (many.find((s) => s.id === active) ?? target) : c;
                      const waitingOnes = all.filter((s) => isWaiting(s.attention));
                      const first = waitingOnes[0];
                      const waiting =
                        first && isWaiting(first.attention)
                          ? `${t(`attention.${first.attention}`)}${waitingOnes.length > 1 ? ` · ${waitingOnes.length}` : ""}`
                          : null;
                      const busy: Busy = all.map(busyOfConv).find((b) => b === "needs_you") ?? all.map(busyOfConv).find(Boolean) ?? null;
                      const open = () => setActive(target.id);
                      return (
                        <div
                          key={many && face ? `bot:${face.bot.id}` : c.id}
                          role="button"
                          tabIndex={0}
                          aria-current={current || undefined}
                          onClick={open}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              open();
                            }
                          }}
                          // a div, not a button: the row holds a menu button and nesting buttons is invalid markup
                          className={cn(ROW, "group/item cursor-default py-2.5", c.archived && "opacity-60", rowState(current))}
                        >
                          {c.shape === "group" ? (
                            <GroupAvatar bots={people.map((m) => m.bot)} avatar={c.avatar} busy={busy} />
                          ) : face ? (
                            <BotAvatar bot={face.bot} busy={busy} />
                          ) : (
                            <Who kind="bot" />
                          )}
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-1.5">
                              {/* weight is the unread mark: it stays heavy exactly as long as the conversation waits on you */}
                              <span className={cn("truncate text-sm", waiting ? "font-semibold" : "font-medium")}>
                                {many && face ? face.bot.name : c.title}
                              </span>
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
                                {listTime(i18n, Math.max(...all.map((s) => s.last_activity_at)))}
                              </span>
                            </div>
                            <div className="mt-0.5 flex items-center gap-2">
                              {/* which repository, always: same-named conversations in different ones are told apart here */}
                              {!many && c.dir_kind === "repo" && (
                                <span className="bg-foreground/[0.06] text-muted-foreground max-w-[45%] shrink-0 truncate rounded px-1 text-[10px] leading-4">
                                  {repoName(c.repo_path)}
                                </span>
                              )}
                              <span className="text-muted-foreground min-w-0 flex-1 truncate text-xs">
                                {target.preview ?? (!many && c.dir_kind === "chat" ? t("location.chat") : t("app.noMessages"))}
                              </span>
                              {waiting ? (
                                // opaque, so it keeps its colour on a selected row instead of mixing with the blue
                                <span className="inline-flex shrink-0 items-center rounded-full bg-amber-100 px-1.5 text-[10px] leading-4 font-medium text-amber-700 dark:bg-amber-950 dark:text-amber-300">
                                  {waiting}
                                </span>
                              ) : (
                                // running is deliberately quiet: it does not need you
                                all.some((s) => s.run_state === "running") && (
                                  <Loader className="text-muted-foreground/50 size-3 shrink-0 animate-spin" />
                                )
                              )}
                            </div>
                          </div>
                          <ConversationMenu
                            conv={menuFor}
                            className="absolute top-2 right-1.5"
                            onRename={() => {
                              setActive(menuFor.id);
                              setRenaming(menuFor.id);
                            }}
                            onGone={dropConversation}
                            onNewSession={many && face ? () => void newSession(face.bot) : undefined}
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
                    convs={convs}
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
                    <GroupAvatar bots={members.map((m) => m.bot)} avatar={conv.avatar} busy={busyOfConv(conv)} />
                  ) : members[0] ? (
                    <BotCardTrigger bot={members[0].bot} presence={presence[members[0].id] ?? null} style={NO_DRAG}>
                      <BotAvatar bot={members[0].bot} busy={busyOfConv(conv)} />
                    </BotCardTrigger>
                  ) : null}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      {!group ? (
                        // a direct chat is headed by the bot; the session is named below, where it is switched
                        <span className="truncate px-1.5 py-0.5 text-sm font-semibold">{members[0]?.bot.name ?? conv.title}</span>
                      ) : renaming === conv.id ? (
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
                    {group ? (
                      <div className="text-muted-foreground flex min-w-0 items-center gap-1.5 px-1.5 text-[11px]">
                        <span className="truncate">
                          {`${t("conversation.groupSubtitle", { count: members.length + 1, mode: t(`mode.${conv.mode}`) })}${
                            conv.mode === "leader" ? t("conversation.leaderSuffix", { name: leaderOf(conv)?.bot.name ?? "-" }) : ""
                          }`}
                        </span>
                        {/* the place by name, the way the list says it; the whole path waits in the tooltip */}
                        <PlaceChip conv={conv} style={NO_DRAG} onOpen={() => setPanel(true)} />
                      </div>
                    ) : renaming === conv.id ? (
                      <div className="px-1.5">
                        <RenameInput conv={conv} style={NO_DRAG} className="text-[11px]" onDone={() => setRenaming(null)} />
                      </div>
                    ) : (
                      <div className="text-muted-foreground flex min-w-0 items-center gap-1.5 px-1.5 text-[11px]">
                        <SessionSwitcher
                          conv={conv}
                          sessions={members[0] ? sessionsOf(members[0].bot.id) : [conv]}
                          name={members[0]?.bot.name ?? ""}
                          time={(ts) => listTime(i18n, ts)}
                          onPick={openConversation}
                          onNew={() => {
                            if (members[0]) void newSession(members[0].bot);
                          }}
                          onGroup={() => {
                            if (members[0]) setStarting({ open: true, botIds: [members[0].bot.id] });
                          }}
                          onRename={() => setRenaming(conv.id)}
                          style={NO_DRAG}
                        />
                        {members[0]?.stale && (
                          <StaleNote busy={syncing === members[0].id} onSync={() => void syncMember(conv.id, members[0]!.id)} style={NO_DRAG} />
                        )}
                      </div>
                    )}
                  </div>
                  {!group && (
                    <span style={NO_DRAG}>
                      <Outline messages={messages} onJump={jump} />
                    </span>
                  )}
                  {/* a 1:1 has no members to speak of: what its panel held is in the session menu and a note beside it */}
                  {group && (
                    <Button
                      variant={panelOpen ? "secondary" : "ghost"}
                      size="sm"
                      style={NO_DRAG}
                      title={panelOpen ? t("app.hideMembers") : t("app.membersAndMode")}
                      onClick={() => setPanel((p) => !p)}
                    >
                      <Users className="size-4" />
                      {members.length + 1}
                    </Button>
                  )}
                </header>

                <MentionBots.Provider value={mentionable}>
                  {/* no rules above or below: the stream fades out under the header and composer instead */}
                  <ScrollArea
                    className="min-h-0 flex-1 [mask-image:linear-gradient(to_bottom,transparent,black_1rem,black_calc(100%_-_1rem),transparent)]"
                    ref={scrollRoot}
                  >
                    {/* only once the log is read: while it loads, an empty pane must not claim there is nothing in it */}
                    {loadedFor === conv.id && messages.length === 0 && streamed === 0 && (
                      // a sibling of the transcript, not a child: absolute against the scroll area root, which is as tall as the pane;
                      // the transcript is only as tall as its rows, and it is positioned for the selection menu
                      <div className="text-muted-foreground absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center">
                        {group ? (
                          <>
                            <GroupAvatar bots={members.map((m) => m.bot)} avatar={conv.avatar} size="lg" />
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
                    {/* the one place text is content: select across messages, quote a passage, copy code */}
                    <div className="relative cursor-auto space-y-4 px-5 py-4 select-text" ref={transcriptRoot}>
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
                      <SelectionMenu host={transcriptRoot} onQuote={quote} />
                    </div>
                  </ScrollArea>
                </MentionBots.Provider>

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
              {group && (
                <MembersPanel
                  open={panelOpen}
                  mode={wide ? "column" : "overlay"}
                  conv={conv}
                  bots={bots}
                  presence={presence}
                  sessions={{ info: sessions, options: sessionOptions, quota }}
                  convs={convs}
                  onClose={() => setPanel(false)}
                  onOpenBot={(id) => {
                    setNav("contacts");
                    setContact({ kind: "bot", id });
                    setEditing(null);
                  }}
                />
              )}
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
        convs={convs}
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
    </BotCardActions.Provider>
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
