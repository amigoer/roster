import { activeMembers, type Conversation, type Presence } from "./api";
import { BotAvatar, busyOf } from "./bot-avatar";
import { BotCardTrigger } from "./bot-card";
import { useI18n } from "./i18n";
import { Collapse } from "./motion";
import { presenceLabel } from "./presence-label";

export { presenceLabel };

function Dots() {
  return (
    <span className="inline-flex items-end gap-0.5" aria-hidden>
      {[0, 150, 300].map((delay) => (
        <span
          key={delay}
          className="bg-muted-foreground/60 size-1 animate-bounce rounded-full"
          style={{ animationDelay: `${delay}ms` }}
        />
      ))}
    </span>
  );
}

/** What each bot is doing right now; running is quiet, so this stays a single muted line. */
export function PresenceStrip({
  conv,
  presence,
}: {
  conv: Conversation;
  presence: Record<string, Presence>;
}) {
  const { t } = useI18n();
  const rows = activeMembers(conv).flatMap((m) => {
    const p = presence[m.id];
    return p ? [{ m, p }] : [];
  });
  return (
    // unfolds rather than appears: the composer under it moves with it instead of jumping
    <Collapse open={rows.length > 0}>
      {rows.length > 0 && (
        <div className="text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1 px-5 pt-2.5 text-xs">
          {rows.map(({ m, p }) => (
            <span key={m.id} className="inline-flex items-center gap-1.5">
              <BotCardTrigger bot={m.bot} presence={p}>
                <BotAvatar bot={m.bot} size="xs" busy={busyOf(p.state)} />
              </BotCardTrigger>
              {activeMembers(conv).length > 1 && <span className="text-foreground font-medium">{m.bot.name}</span>}
              <span className={p.state === "waiting_permission" ? "text-amber-600 dark:text-amber-400" : undefined}>
                {presenceLabel(t, p)}
              </span>
              {(p.state === "thinking" || p.state === "writing" || p.state === "starting" || p.state === "compacting") && <Dots />}
            </span>
          ))}
        </div>
      )}
    </Collapse>
  );
}
