import { createContext, useContext, useState, type ReactNode } from "react";
import { AtSign, MessageCircle, UserRound } from "lucide-react";
import type { Bot, Presence } from "./api";
import { BotAvatar, busyOf } from "./bot-avatar";
import { useExecutor } from "./executors";
import { useI18n } from "./i18n";
import { presenceLabel } from "./presence-label";
import { ProviderIcon, providerOf } from "./provider-icon";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

/** What a bot's card can do; the window provides these once, wherever a card can open. */
export interface BotCardActions {
  /** the bot's own entry: its open direct chat, or a new one */
  message(bot: Bot): void;
  profile(bot: Bot): void;
  /** puts @name into the composer; only offered in a group, where a name addresses someone */
  mention?: (bot: Bot) => void;
}

export const BotCardActions = createContext<BotCardActions | null>(null);

/**
 * Wraps a bot's face wherever it shows: a click opens its card, the way
 * tapping a member does in any messenger. Without actions in scope it is a
 * plain face, so a card never opens where nothing could be done from it.
 */
export function BotCardTrigger({
  bot,
  presence,
  className,
  style,
  children,
}: {
  bot: Bot;
  /** what it is doing right now, when the caller knows */
  presence?: Presence | null;
  className?: string;
  style?: React.CSSProperties;
  children: ReactNode;
}) {
  const actions = useContext(BotCardActions);
  const [open, setOpen] = useState(false);
  const { t } = useI18n();
  const executor = useExecutor()(bot.executor_id);
  if (!actions) return <>{children}</>;
  const act = (fn: (bot: Bot) => void) => () => {
    setOpen(false);
    fn(bot);
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          title={bot.name}
          style={style}
          // the face sits inside rows and bubbles with clicks of their own; opening the card is this click's whole job
          onClick={(e) => e.stopPropagation()}
          className={cn("focus-visible:ring-ring/50 shrink-0 rounded-[23%] outline-none focus-visible:ring-2", className)}
        >
          {children}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-0">
        <div className="flex items-start gap-3 p-4">
          <BotAvatar bot={bot} size="lg" busy={busyOf(presence?.state)} />
          <div className="min-w-0 flex-1 pt-0.5">
            <p className="truncate text-sm font-semibold">{bot.name}</p>
            <p className="text-muted-foreground mt-0.5 truncate text-xs">{bot.title ?? t("profile.noTitle")}</p>
            <div className="mt-2 flex flex-wrap gap-1">
              <Badge variant="outline" className="max-w-full font-normal">
                <ProviderIcon provider={providerOf(bot, executor.type)} />
                <span className="truncate">
                  {executor.label} · {bot.model ?? executor.model ?? t("common.defaultModel")}
                </span>
              </Badge>
              <Badge variant="outline" className="font-normal">
                {t(`tier.${bot.permission_tier}`)}
              </Badge>
            </div>
            {presence && (
              <p className={cn("mt-2 text-xs", presence.state === "waiting_permission" ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground")}>
                {presenceLabel(t, presence)}
              </p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1.5 border-t px-3 py-2">
          <Button size="sm" onClick={act(actions.message)}>
            <MessageCircle />
            {t("profile.message")}
          </Button>
          {actions.mention && (
            <Button size="sm" variant="outline" onClick={act(actions.mention)}>
              <AtSign />
              {t("card.mention")}
            </Button>
          )}
          <Button size="sm" variant="ghost" className="text-muted-foreground ml-auto" onClick={act(actions.profile)}>
            <UserRound />
            {t("members.viewProfile")}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
