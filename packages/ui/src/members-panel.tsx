import { useEffect, useRef, useState } from "react";
import {
  Crown,
  Hand,
  MessagesSquare,
  MoreHorizontal,
  RefreshCw,
  UserMinus,
  UserPlus,
  UserRound,
  X,
} from "lucide-react";
import {
  activeMembers,
  api,
  type Bot,
  type Conversation,
  type Member,
  type Mode,
  type Presence,
  type Quota,
  type SessionInfo,
  type SessionOptions,
} from "./api";
import { BotAvatar, busyOf, HumanAvatar } from "./bot-avatar";
import { BotCardTrigger } from "./bot-card";
import { useExecutor } from "./executors";
import { useI18n } from "./i18n";
import { DirectorySection } from "./location";
import { useMe } from "./me";
import { leaderOf } from "./mentions";
import { presenceLabel } from "./presence";
import { SessionPickers, SessionUsage } from "./session-controls";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

/** What each member's session runs with and its agent's plan usage, as loaded for the open conversation. */
export type MemberSessions = {
  info: Record<string, SessionInfo>;
  options: Record<string, SessionOptions>;
  quota: Record<string, Quota | null>;
};

/** A mode answers exactly one question: who speaks next. What each is called is in the catalog, under mode.<id>. */
export const MODES: Array<{ id: Mode; icon: typeof Hand }> = [
  { id: "human_led", icon: Hand },
  { id: "leader", icon: Crown },
  { id: "discussion", icon: MessagesSquare },
];

export function ModePicker({ value, onChange }: { value: Mode; onChange: (m: Mode) => void }) {
  const { t } = useI18n();
  return (
    <div className="grid gap-1.5">
      {MODES.map((m) => (
        <button
          key={m.id}
          type="button"
          onClick={() => onChange(m.id)}
          className={cn(
            "flex gap-2.5 rounded-lg border px-3 py-2 text-left transition-colors",
            value === m.id ? "border-foreground/40 bg-accent" : "hover:bg-accent/50",
          )}
        >
          <m.icon className={cn("mt-0.5 size-4 shrink-0", value !== m.id && "text-muted-foreground")} />
          <span className="min-w-0">
            <span className="block text-sm font-medium">{t(`mode.${m.id}`)}</span>
            <span className="text-muted-foreground block text-xs leading-snug">{t(`mode.${m.id}.hint`)}</span>
          </span>
        </button>
      ))}
    </div>
  );
}

export function MembersPanel({
  open,
  mode,
  conv,
  bots,
  presence,
  sessions,
  convs,
  onClose,
  onOpenBot,
}: {
  /** closed, it folds or slides away and drops out of the tab order, but stays mounted to do so */
  open: boolean;
  /** a column beside the chat when there is room; a sheet over it when a column would crush it */
  mode: "column" | "overlay";
  conv: Conversation;
  bots: Bot[];
  presence: Record<string, Presence>;
  sessions: MemberSessions;
  /** every conversation, so a directory change can say who else works there */
  convs: Conversation[];
  onClose: () => void;
  onOpenBot: (botId: string) => void;
}) {
  const { t } = useI18n();
  // settled: the move in the current direction has ended; only then is a closed panel hidden outright
  const [settled, setSettled] = useState(true);
  const [was, setWas] = useState(open);
  if (was !== open) {
    setWas(open);
    setSettled(false);
  }
  // a sheet over the chat closes the way any sheet does; a column beside it is not in the way
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    if (!open || mode !== "overlay") return;
    const onKey = (e: KeyboardEvent) => {
      // a menu open inside the panel takes its Escape first
      if (e.key === "Escape" && !e.defaultPrevented) close.current();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, mode]);
  const column = mode === "column";
  return (
    <>
      {!column && (
        <div
          aria-hidden
          onClick={onClose}
          className={cn(
            "absolute inset-0 z-10 rounded-xl bg-black/20 transition-opacity duration-200 ease-soft",
            open ? "opacity-100" : "pointer-events-none opacity-0",
          )}
        />
      )}
      {/* the column's width is what moves, so the chat beside it reflows with it; the sheet slides over the chat instead */}
      <div
        inert={!open || undefined}
        onTransitionEnd={(e) => {
          if (e.target === e.currentTarget) setSettled(true);
        }}
        className={cn(
          "shrink-0 duration-200 ease-soft",
          column
            ? // 2px past the panel keeps its hairline inside the clip; the half rem before it is the gap to the chat
              cn("relative overflow-x-clip transition-[width]", open ? "w-[calc(18.5rem+2px)]" : "w-0")
            : cn("absolute inset-y-0 right-0 z-20 transition-[translate]", open ? "translate-x-0" : "translate-x-[calc(100%+1rem)]"),
          !open && settled && "invisible",
        )}
      >
        <aside
          className={cn(
            "bg-background flex h-full w-72 flex-col overflow-hidden rounded-xl",
            column ? "shadow-panel absolute inset-y-0 right-[2px]" : "ring-border shadow-xl ring-1",
          )}
        >
          <header className="flex h-13 shrink-0 items-center justify-between px-4">
            {/* you are in the room as much as they are, so every head count includes you */}
            <span className="text-sm font-semibold">{t("members.groupTitle", { count: activeMembers(conv).length + 1 })}</span>
            <Button variant="ghost" size="icon-sm" onClick={onClose} title={t("common.collapse")}>
              <X className="size-4" />
            </Button>
          </header>
          <Separator />
          <ScrollArea className="min-h-0 flex-1">
            <MemberSections conv={conv} bots={bots} presence={presence} sessions={sessions} onOpenBot={onOpenBot} className="p-4" />
            <DirectorySection conv={conv} convs={convs} className="px-4 pb-4" />
          </ScrollArea>
        </aside>
      </div>
    </>
  );
}

/** Who answers and who is in the room; the chat's side panel and a group's profile change them the same way. */
export function MemberSections({
  conv,
  bots,
  presence,
  sessions,
  onOpenBot,
  className,
}: {
  conv: Conversation;
  bots: Bot[];
  presence: Record<string, Presence>;
  /** absent where the conversation is not open, so its sessions are not loaded */
  sessions?: MemberSessions;
  onOpenBot: (botId: string) => void;
  className?: string;
}) {
  const [error, setError] = useState<string | null>(null);
  const { t } = useI18n();
  const { profile: me } = useMe();
  const members = activeMembers(conv);
  const leader = conv.mode === "leader" ? leaderOf(conv) : undefined;
  const outsiders = bots.filter((b) => !members.some((m) => m.bot.id === b.id));

  const run = async (p: Promise<{ error?: string }>) => {
    const r = await p;
    setError(r.error ?? null);
  };

  return (
    <div className={cn("space-y-5", className)}>
      <section className="space-y-2">
        <h3 className="text-muted-foreground text-xs font-medium">{t("members.whoAnswers")}</h3>
        <ModePicker value={conv.mode} onChange={(m) => void run(api.setMode(conv.id, m))} />
      </section>

      <section className="space-y-1">
        <div className="flex items-center justify-between pb-1">
          <h3 className="text-muted-foreground text-xs font-medium">{t("members.title")}</h3>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="xs" className="text-muted-foreground">
                <UserPlus />
                {t("members.add")}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-60">
              <DropdownMenuLabel className="text-muted-foreground text-xs font-normal">
                {t("members.fromContacts")}
              </DropdownMenuLabel>
              {outsiders.length === 0 && (
                <DropdownMenuItem disabled>{t("members.allHere")}</DropdownMenuItem>
              )}
              {outsiders.map((b) => (
                <DropdownMenuItem key={b.id} onSelect={() => void run(api.addMember(conv.id, b.id))}>
                  <BotAvatar bot={b} size="xs" />
                  <span className="font-medium">{b.name}</span>
                  <span className="text-muted-foreground truncate text-xs">{b.title}</span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <div className="-mx-2 flex items-center gap-2.5 px-2 py-2">
          <HumanAvatar />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <span className="truncate text-sm font-medium">{me.name || t("members.you")}</span>
              {me.name && (
                <span className="bg-foreground/[0.06] text-muted-foreground shrink-0 rounded px-1 text-[10px] leading-4">
                  {t("members.you")}
                </span>
              )}
            </div>
            {me.title && <div className="text-muted-foreground truncate text-xs">{me.title}</div>}
          </div>
        </div>

        {members.map((m) => (
          <MemberRow
            key={m.id}
            conv={conv}
            member={m}
            presence={presence[m.id]}
            sessions={sessions}
            isLeader={leader?.id === m.id}
            canLead={conv.mode === "leader" && leader?.id !== m.id}
            canRemove={members.length > 1}
            onOpen={() => onOpenBot(m.bot.id)}
            onLead={() => void run(api.setMode(conv.id, "leader", m.id))}
            onSync={() => void run(api.syncMember(conv.id, m.id))}
            onRemove={() => void run(api.removeMember(conv.id, m.id))}
            onError={setError}
          />
        ))}
        {error && <p className="text-destructive pt-1 text-xs">{error}</p>}
      </section>
    </div>
  );
}

function MemberRow({
  conv,
  member,
  presence,
  sessions,
  isLeader,
  canLead,
  canRemove,
  onOpen,
  onLead,
  onSync,
  onRemove,
  onError,
}: {
  conv: Conversation;
  member: Member;
  presence?: Presence;
  sessions: MemberSessions | undefined;
  isLeader: boolean;
  canLead: boolean;
  canRemove: boolean;
  onOpen: () => void;
  onLead: () => void;
  onSync: () => void;
  onRemove: () => void;
  onError: (error: string | null) => void;
}) {
  const { bot } = member;
  const { t } = useI18n();
  // what this member's session runs on, which can lag behind the bot until it is synced
  const executor = useExecutor()(member.executor_id);
  const model = member.model ?? executor.model;
  const info = sessions?.info[member.id];
  const choices = sessions?.options[member.id];
  // the mode picker shows what gates its tool calls, a tier included; without one the bot's tier is spelled out
  const modes = Boolean(info?.mode && choices?.modes.length);
  return (
    <div className="group/member hover:bg-accent/50 -mx-2 flex items-start gap-2.5 rounded-md px-2 py-2 transition-colors">
      <BotCardTrigger bot={bot} presence={presence} className="mt-0.5">
        <BotAvatar bot={bot} busy={busyOf(presence?.state)} />
      </BotCardTrigger>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1">
          <span className="truncate text-sm font-medium">{bot.name}</span>
          {isLeader && <Crown className="size-3.5 shrink-0 text-amber-500" aria-label={t("members.leader")} />}
          {sessions && info && (
            // beside the name, so the model below has the width; the negative margins keep the line its height
            <span className="-my-1 -mr-1.5 ml-auto flex shrink-0">
              <SessionUsage conv={conv} member={member} info={info} choices={choices} quota={sessions.quota} onError={onError} dense />
            </span>
          )}
        </div>
        <div className="text-muted-foreground truncate text-xs">
          {presence ? presenceLabel(t, presence) : (bot.title ?? executor.label)}
        </div>
        {sessions && info ? (
          // the pills' padding hangs into the gutter, so their text lines up with the lines above
          <div className="-ml-1.5 flex min-w-0 items-center pt-0.5">
            <SessionPickers conversationId={conv.id} member={member} info={info} choices={choices} onError={onError} dense />
            {!modes && (
              <span className="text-muted-foreground/70 shrink-0 px-1 text-[11px]">{t(`tier.${bot.permission_tier}`)}</span>
            )}
          </div>
        ) : (
          <div className="text-muted-foreground/70 truncate text-[11px]">
            {executor.label} · {model ?? t("common.defaultModel")} · {t(`tier.${bot.permission_tier}`)}
          </div>
        )}
        {member.stale && (
          <button
            onClick={onSync}
            className="mt-1 inline-flex items-center gap-1 rounded bg-amber-500/10 px-1.5 py-0.5 text-[11px] text-amber-700 hover:bg-amber-500/20 dark:text-amber-300"
            title={t("members.syncHint")}
          >
            <RefreshCw className="size-3" />
            {t("members.syncButton")}
          </button>
        )}
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-xs"
            className="text-muted-foreground opacity-0 transition-opacity group-hover/member:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
          >
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={onOpen}>
            <UserRound className="size-3.5" />
            {t("members.viewProfile")}
          </DropdownMenuItem>
          {canLead && (
            <DropdownMenuItem onSelect={onLead}>
              <Crown className="size-3.5" />
              {t("members.makeLeader")}
            </DropdownMenuItem>
          )}
          {member.stale && (
            <DropdownMenuItem onSelect={onSync}>
              <RefreshCw className="size-3.5" />
              {t("members.sync")}
            </DropdownMenuItem>
          )}
          {canRemove && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onSelect={onRemove}>
                <UserMinus className="size-3.5" />
                {t("members.remove")}
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
