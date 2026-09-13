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
import { BotAvatar, busyOf, HumanAvatar, TIER_LABEL } from "./bot-avatar";
import { useExecutor, useSourceLabel } from "./executors";
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

/** A mode answers exactly one question: who speaks next. */
export const MODES: Array<{ id: Mode; label: string; hint: string; icon: typeof Hand }> = [
  { id: "human_led", label: "人主导", hint: "你 @ 谁谁回复；不 @ 就接着和上一个回复你的成员聊", icon: Hand },
  { id: "leader", label: "群主分发", hint: "你只跟群主说；群主拆任务 @ 成员分派，收齐结果再回复你", icon: Crown },
  { id: "discussion", label: "讨论", hint: "每条消息所有成员各说一次，只读不改文件，由你拍板", icon: MessagesSquare },
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
            <span className="block text-sm font-medium">{m.label}</span>
            <span className="text-muted-foreground block text-xs leading-snug">{m.hint}</span>
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
  return (
    // a column when there is room; over the chat when a column would crush it
    <aside className="bg-background ring-border absolute inset-y-0 right-0 z-20 flex w-72 shrink-0 flex-col overflow-hidden rounded-xl shadow-xl ring-1 @3xl:static @3xl:shadow-panel @3xl:ring-0">
      <header className="flex h-13 shrink-0 items-center justify-between px-4">
        {/* you are in the room as much as they are, so every head count includes you */}
        <span className="text-sm font-semibold">{group ? `群成员 · ${activeMembers(conv).length + 1}` : "成员"}</span>
        <Button variant="ghost" size="icon-sm" onClick={onClose} title="收起">
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
          <h3 className="text-muted-foreground text-xs font-medium">谁来接话</h3>
          <ModePicker value={conv.mode} onChange={(m) => void run(api.setMode(conv.id, m))} />
        </section>
      )}

      <section className="space-y-1">
        <div className="flex items-center justify-between pb-1">
          <h3 className="text-muted-foreground text-xs font-medium">成员</h3>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="xs" className="text-muted-foreground">
                <UserPlus />
                {group ? "拉人" : "拉人建群"}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-60">
              <DropdownMenuLabel className="text-muted-foreground text-xs font-normal">
                从通讯录添加
              </DropdownMenuLabel>
              {outsiders.length === 0 && (
                <DropdownMenuItem disabled>通讯录里的 bot 都在这了</DropdownMenuItem>
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
          <span className="text-sm font-medium">你</span>
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
  const executor = useExecutor()(bot.executor_id);
  const sourceLabel = useSourceLabel();
  return (
    <div className="group/member hover:bg-accent/50 -mx-2 flex items-start gap-2.5 rounded-md px-2 py-2">
      <button onClick={onOpen} title="查看资料" className="mt-0.5">
        <BotAvatar bot={bot} busy={busyOf(presence?.state)} />
      </button>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1">
          <span className="truncate text-sm font-medium">{bot.name}</span>
          {isLeader && <Crown className="size-3.5 shrink-0 text-amber-500" aria-label="群主" />}
        </div>
        <div className="text-muted-foreground truncate text-xs">
          {presence ? presenceLabel(presence) : (bot.title ?? `${executor.label}${bot.model ? ` · ${bot.model}` : ""}`)}
        </div>
        <div className="text-muted-foreground/70 truncate text-[11px]">
          {executor.label} · {bot.model ?? sourceLabel(bot)} · {TIER_LABEL[bot.permission_tier]?.label}
        </div>
        {member.stale && (
          <button
            onClick={onSync}
            className="mt-1 inline-flex items-center gap-1 rounded bg-amber-500/10 px-1.5 py-0.5 text-[11px] text-amber-700 hover:bg-amber-500/20 dark:text-amber-300"
            title="它还在用加入时的设定；同步后会在执行器上开一个新会话，并把群聊记录重新交给它"
          >
            <RefreshCw className="size-3" />
            设定有更新，点此同步
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
            查看资料
          </DropdownMenuItem>
          {canLead && (
            <DropdownMenuItem onSelect={onLead}>
              <Crown className="size-3.5" />
              设为群主
            </DropdownMenuItem>
          )}
          {member.stale && (
            <DropdownMenuItem onSelect={onSync}>
              <RefreshCw className="size-3.5" />
              同步最新设定
            </DropdownMenuItem>
          )}
          {canRemove && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onSelect={onRemove}>
                <UserMinus className="size-3.5" />
                移出群聊
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
