import { activeMembers, type Conversation, type Presence } from "./api";
import { BotAvatar, busyOf } from "./bot-avatar";

export function presenceLabel(p: Presence): string {
  switch (p.state) {
    case "starting":
      return "正在启动";
    case "thinking":
      return "正在思考";
    case "tool":
      return p.detail ? `正在执行 ${p.detail}` : "正在执行工具";
    case "waiting_permission":
      return p.detail ? `等你批准 ${p.detail}` : "等你批准";
    case "waiting_lock":
      return p.detail ? `等 ${p.detail} 改完文件` : "排队等着改文件";
    case "compacting":
      return "正在压缩上下文";
  }
}

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
  const rows = activeMembers(conv).flatMap((m) => {
    const p = presence[m.id];
    return p ? [{ m, p }] : [];
  });
  if (rows.length === 0) return null;
  return (
    <div className="text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1 px-5 pt-2.5 text-xs">
      {rows.map(({ m, p }) => (
        <span key={m.id} className="inline-flex items-center gap-1.5">
          <BotAvatar bot={m.bot} size="xs" busy={busyOf(p.state)} />
          {conv.shape === "group" && <span className="text-foreground font-medium">{m.bot.name}</span>}
          <span className={p.state === "waiting_permission" ? "text-amber-600 dark:text-amber-400" : undefined}>
            {presenceLabel(p)}
          </span>
          {(p.state === "thinking" || p.state === "starting" || p.state === "compacting") && <Dots />}
        </span>
      ))}
    </div>
  );
}
