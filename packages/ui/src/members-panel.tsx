import { useState } from "react";
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
import { activeMembers, api, type Bot, type Conversation, type Member, type Mode, type Presence } from "./api";
import { BotAvatar, busyOf, HumanAvatar } from "./bot-avatar";
import { useExecutor } from "./executors";
import { useI18n } from "./i18n";
import { useMe } from "./me";
import { leaderOf } from "./mentions";
import { presenceLabel } from "./presence";
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

/** A mode answers exactly one question: who speaks next. What each is called is in the catalog, under mode.<id>. */
export const MODES: Array<{ id: Mode; icon: typeof Hand }> = [
  { id: "human_led", icon: Hand },
  { id: "leader", icon: Crown },
  { id: "discussion", icon: MessagesSquare },
];

export function ModePicker({
  value,
  onChange,
  compact = false,
}: {
  value: Mode;
  onChange: (m: Mode) => void;
  compact?: boolean;
}) {
  const { t } = useI18n();
  return (
    <div className={cn("grid gap-1.5", compact && "grid-cols-3")}>
      {MODES.map((m) => (
        <button
          key={m.id}
          type="button"
          onClick={() => onChange(m.id)}
          className={cn(
            "flex gap-2.5 rounded-lg border px-3 py-2 text-left transition-colors",
            compact && "flex-col gap-1",
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
  conv,
  bots,
  presence,
  onClose,
  onOpenBot,
}: {
  conv: Conversation;
  bots: Bot[];
  presence: Record<string, Presence>;
  onClose: () => void;
  onOpenBot: (botId: string) => void;
}) {
  const group = conv.shape === "group";
  const { t } = useI18n();
  return (
    // a column when there is room; over the chat when a column would crush it
    <aside className="bg-background ring-border absolute inset-y-0 right-0 z-20 flex w-72 shrink-0 flex-col overflow-hidden rounded-xl shadow-xl ring-1 @3xl:static @3xl:shadow-panel @3xl:ring-0">
      <header className="flex h-13 shrink-0 items-center justify-between px-4">
        {/* you are in the room as much as they are, so every head count includes you */}
        <span className="text-sm font-semibold">{group ? t("members.groupTitle", { count: activeMembers(conv).length + 1 }) : t("members.title")}</span>
        <Button variant="ghost" size="icon-sm" onClick={onClose} title={t("common.collapse")}>
          <X className="size-4" />
        </Button>
      </header>
      <Separator />
      <ScrollArea className="min-h-0 flex-1">
        <MemberSections conv={conv} bots={bots} presence={presence} onOpenBot={onOpenBot} className="p-4" />
      </ScrollArea>
    </aside>
  );
}

/** Who answers and who is in the room; the chat's side panel and a group's profile change them the same way. */
export function MemberSections({
  conv,
  bots,
  presence,
  onOpenBot,
  className,
}: {
  conv: Conversation;
  bots: Bot[];
  presence: Record<string, Presence>;
  onOpenBot: (botId: string) => void;
  className?: string;
}) {
  const [error, setError] = useState<string | null>(null);
  const { t } = useI18n();
  const { profile: me } = useMe();
  const members = activeMembers(conv);
  const group = conv.shape === "group";
  const leader = conv.mode === "leader" ? leaderOf(conv) : undefined;
  const outsiders = bots.filter((b) => !members.some((m) => m.bot.id === b.id));

  const run = async (p: Promise<{ error?: string }>) => {
    const r = await p;
    setError(r.error ?? null);
  };

  return (
    <div className={cn("space-y-5", className)}>
      {group && (
        <section className="space-y-2">
          <h3 className="text-muted-foreground text-xs font-medium">{t("members.whoAnswers")}</h3>
          <ModePicker value={conv.mode} onChange={(m) => void run(api.setMode(conv.id, m))} />
        </section>
      )}

      <section className="space-y-1">
        <div className="flex items-center justify-between pb-1">
          <h3 className="text-muted-foreground text-xs font-medium">{t("members.title")}</h3>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="xs" className="text-muted-foreground">
                <UserPlus />
                {group ? t("members.add") : t("members.addToGroup")}
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
            member={m}
            presence={presence[m.id]}
            isLeader={leader?.id === m.id}
            canLead={conv.mode === "leader" && leader?.id !== m.id}
            canRemove={members.length > 1}
            onOpen={() => onOpenBot(m.bot.id)}
            onLead={() => void run(api.setMode(conv.id, "leader", m.id))}
            onSync={() => void run(api.syncMember(conv.id, m.id))}
            onRemove={() => void run(api.removeMember(conv.id, m.id))}
          />
        ))}
        {error && <p className="text-destructive pt-1 text-xs">{error}</p>}
      </section>
    </div>
  );
}

function MemberRow({
  member,
  presence,
  isLeader,
  canLead,
  canRemove,
  onOpen,
  onLead,
  onSync,
  onRemove,
}: {
  member: Member;
  presence?: Presence;
  isLeader: boolean;
  canLead: boolean;
  canRemove: boolean;
  onOpen: () => void;
  onLead: () => void;
  onSync: () => void;
  onRemove: () => void;
}) {
  const { bot } = member;
  const { t } = useI18n();
  // what this member's session runs on, which can lag behind the bot until it is synced
  const executor = useExecutor()(member.executor_id);
  const model = member.model ?? executor.model;
  return (
    <div className="group/member hover:bg-accent/50 -mx-2 flex items-start gap-2.5 rounded-md px-2 py-2">
      <button onClick={onOpen} title={t("members.viewProfile")} className="mt-0.5">
        <BotAvatar bot={bot} busy={busyOf(presence?.state)} />
      </button>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1">
          <span className="truncate text-sm font-medium">{bot.name}</span>
          {isLeader && <Crown className="size-3.5 shrink-0 text-amber-500" aria-label={t("members.leader")} />}
        </div>
        <div className="text-muted-foreground truncate text-xs">
          {presence ? presenceLabel(t, presence) : (bot.title ?? `${executor.label}${model ? ` · ${model}` : ""}`)}
        </div>
        <div className="text-muted-foreground/70 truncate text-[11px]">
          {executor.label} · {model ?? t("common.defaultModel")} · {t(`tier.${bot.permission_tier}`)}
        </div>
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
            className="text-muted-foreground opacity-0 group-hover/member:opacity-100 data-[state=open]:opacity-100"
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
