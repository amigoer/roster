import { ChevronDown, ExternalLink, Loader, Pencil, Plus, RefreshCw, Users } from "lucide-react";
import type { Conversation } from "./api";
import { desktop } from "./desktop";
import { useI18n } from "./i18n";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/** A direct chat's sessions with its bot: the open one named, the others a click away, a fresh one on top. */
export function SessionSwitcher({
  conv,
  sessions,
  name,
  time,
  onPick,
  onNew,
  onGroup,
  onRename,
  style,
}: {
  conv: Conversation;
  /** every open session with this bot, the current one included, in the list's order */
  sessions: Conversation[];
  /** the bot's name, for the menu's heading */
  name: string;
  time: (ts: number) => string;
  onPick: (id: string) => void;
  onNew: () => void;
  /** a group with this bot in it: a new room, since a 1:1 stays one */
  onGroup: () => void;
  onRename: () => void;
  style?: React.CSSProperties;
}) {
  const { t } = useI18n();
  const bridge = desktop();
  const others = sessions.filter((s) => s.id !== conv.id);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          style={style}
          className="hover:bg-accent focus-visible:ring-ring/60 -ml-1.5 inline-flex max-w-full items-center gap-1 rounded px-1.5 py-0.5 text-[11px] outline-none focus-visible:ring-2"
        >
          <span className="truncate">{conv.title}</span>
          <ChevronDown className="size-3 shrink-0" />
          {sessions.length > 1 && <span className="shrink-0">· {t("session.count", { count: sessions.length })}</span>}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72">
        <DropdownMenuItem onSelect={onNew}>
          <Plus className="size-3.5" />
          {t("session.new")}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onRename}>
          <Pencil className="size-3.5" />
          {t("common.rename")}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onGroup}>
          <Users className="size-3.5" />
          {t("session.group", { name })}
        </DropdownMenuItem>
        {bridge && (
          <DropdownMenuItem onSelect={() => void bridge.revealDirectory(conv.repo_path)}>
            <ExternalLink className="size-3.5" />
            {t("session.reveal")}
          </DropdownMenuItem>
        )}
        {others.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-muted-foreground text-xs font-normal">{t("session.with", { name })}</DropdownMenuLabel>
            {others.map((s) => (
              <DropdownMenuItem key={s.id} onSelect={() => onPick(s.id)}>
                <span className="min-w-0 flex-1 truncate">{s.title}</span>
                {s.attention !== "none" ? (
                  <span className="shrink-0 text-[10px] text-amber-600 dark:text-amber-400">{t(`attention.${s.attention}`)}</span>
                ) : s.run_state === "running" ? (
                  <Loader className="text-muted-foreground/60 size-3 shrink-0 animate-spin" />
                ) : (
                  <span className="text-muted-foreground shrink-0 text-[10px] tabular-nums">{time(s.last_activity_at)}</span>
                )}
              </DropdownMenuItem>
            ))}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** A 1:1 whose bot's setup changed since the session began: the note a group's members panel would carry, and the sync it offers. */
export function StaleNote({ busy, onSync, style }: { busy: boolean; onSync: () => void; style?: React.CSSProperties }) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      style={style}
      title={t("session.staleHint")}
      disabled={busy}
      onClick={onSync}
      className="inline-flex shrink-0 items-center gap-1 rounded bg-amber-500/10 px-1.5 py-0.5 text-[11px] text-amber-700 transition-colors hover:bg-amber-500/20 disabled:opacity-70 dark:text-amber-300"
    >
      {busy ? <Loader className="size-3 animate-spin" /> : <RefreshCw className="size-3" />}
      {t("session.staleSync")}
    </button>
  );
}
