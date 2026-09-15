import { createContext, useContext } from "react";
import { User } from "lucide-react";
import type { Bot, Logo, PresenceState } from "./api";
import { useI18n } from "./i18n";
import { cn } from "@/lib/utils";

/** The bundled logo set, as core ships it in /api/state. */
export const Logos = createContext<readonly Logo[]>([]);

export const useLogos = () => useContext(Logos);

export const logoUrl = (id: string) => `/api/logos/${id}.webp`;

/** Core backfills every bot at startup; an unknown id still maps to a stable logo rather than a hole. */
export function logoOf(bot: Pick<Bot, "id" | "avatar">, logos: readonly Logo[]): Logo | undefined {
  const hit = logos.find((l) => l.id === bot.avatar);
  if (hit || logos.length === 0) return hit;
  let h = 0;
  for (const ch of bot.id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return logos[h % logos.length];
}

const SIZES = {
  xs: "size-5",
  sm: "size-7",
  md: "size-9",
  lg: "size-14",
  xl: "size-20",
} as const;

const DOTS = { xs: "size-2", sm: "size-2.5", md: "size-2.5", lg: "size-3.5", xl: "size-4" } as const;

/** Busy is quiet; only needing you is loud. */
export type Busy = "busy" | "needs_you" | null;

export function busyOf(state: PresenceState | undefined): Busy {
  if (!state) return null;
  return state === "waiting_permission" ? "needs_you" : "busy";
}

/** Keeps a light tile from dissolving into a light page. */
const RING =
  "after:pointer-events-none after:absolute after:inset-0 after:rounded-[inherit] after:ring-1 after:ring-black/5 after:ring-inset dark:after:ring-white/10";

/**
 * One logo tile. It sits on its own background colour so a slow load reads as
 * a coloured square.
 */
export function LogoImage({ logo, className }: { logo: Logo | undefined; className?: string }) {
  return (
    <span
      className={cn("bg-muted relative block shrink-0 overflow-hidden rounded-[23%]", RING, className)}
      style={logo ? { backgroundColor: logo.background } : undefined}
    >
      {logo && <img src={logoUrl(logo.id)} alt="" draggable={false} className="size-full select-none" />}
    </span>
  );
}

const ICONS = { xs: "size-3", sm: "size-3.5", md: "size-4", lg: "size-6", xl: "size-9" } as const;

/** You, wherever a conversation shows the people in it. */
export function HumanAvatar({ size = "md", className }: { size?: keyof typeof SIZES; className?: string }) {
  return (
    <span
      className={cn(
        "bg-muted text-muted-foreground relative flex shrink-0 items-center justify-center overflow-hidden rounded-[23%]",
        RING,
        SIZES[size],
        className,
      )}
    >
      <User className={ICONS[size]} />
    </span>
  );
}

function Dot({ busy, size }: { busy: Busy; size: keyof typeof DOTS }) {
  const { t } = useI18n();
  if (!busy) return null;
  return (
    <span
      className={cn(
        "ring-background absolute -right-0.5 -bottom-0.5 rounded-full ring-2",
        DOTS[size],
        busy === "needs_you" ? "bg-amber-500" : "animate-pulse bg-emerald-500",
      )}
      title={busy === "needs_you" ? t("busy.waiting") : t("busy.working")}
    />
  );
}

export function BotAvatar({
  bot,
  size = "md",
  busy = null,
  className,
}: {
  bot: Pick<Bot, "id" | "avatar">;
  size?: keyof typeof SIZES;
  busy?: Busy;
  className?: string;
}) {
  const logos = useLogos();
  return (
    <span className={cn("relative inline-flex shrink-0", className)}>
      <LogoImage logo={logoOf(bot, logos)} className={SIZES[size]} />
      <Dot busy={busy} size={size} />
    </span>
  );
}

/** Two cells plus the gap must fit the box's inner width, or the tiles wrap one per row. */
const GROUP_SIZES = {
  md: { box: "size-9 gap-px p-[2px]", tile: "size-[15px]", you: "size-2.5" },
  lg: { box: "size-14 gap-0.5 p-[3px]", tile: "size-6", you: "size-3.5" },
  xl: { box: "size-20 gap-[3px] p-1", tile: "size-[34px]", you: "size-5" },
} as const;

/** A group's face is its members' logos tiled together, like any IM -- and you are one of the people in it. */
export function GroupAvatar({
  bots,
  size = "md",
  busy = null,
}: {
  bots: Array<Pick<Bot, "id" | "avatar">>;
  size?: keyof typeof GROUP_SIZES;
  busy?: Busy;
}) {
  const logos = useLogos();
  const { box, tile, you } = GROUP_SIZES[size];
  return (
    <span className="relative inline-flex shrink-0">
      <span
        className={cn(
          "bg-muted inline-flex flex-wrap content-center items-center justify-center overflow-hidden rounded-[23%]",
          box,
        )}
        aria-hidden
      >
        {/* four tiles is what the square holds; a crowded group drops a bot, never you */}
        {bots.slice(0, 3).map((b) => (
          <LogoImage key={b.id} logo={logoOf(b, logos)} className={tile} />
        ))}
        <span
          className={cn(
            "bg-background text-muted-foreground relative flex shrink-0 items-center justify-center overflow-hidden rounded-[23%]",
            RING,
            tile,
          )}
        >
          <User className={you} />
        </span>
      </span>
      <Dot busy={busy} size={size} />
    </span>
  );
}
