import { createContext, useContext } from "react";
import { User } from "lucide-react";
import type { Bot, Logo, PresenceState } from "./api";
import { useI18n } from "./i18n";
import { colorOf, initialOf, useMe, type Profile } from "./me";
import { ICON_IN } from "./motion";
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
  md: "size-11",
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

/** A square with softly cut corners, the way a contact's face is framed. */
const RING =
  "after:pointer-events-none after:absolute after:inset-0 after:rounded-[inherit] after:ring-1 after:ring-black/5 after:ring-inset dark:after:ring-white/10";

/**
 * One logo tile. It sits on its own background colour so a slow load reads as
 * a coloured square.
 */
export function LogoImage({ logo, className }: { logo: Logo | undefined; className?: string }) {
  return (
    <span
      className={cn("bg-muted relative block shrink-0 overflow-hidden rounded-[12%]", RING, className)}
      style={logo ? { backgroundColor: logo.background } : undefined}
    >
      {logo && <img src={logoUrl(logo.id)} alt="" draggable={false} className="size-full select-none" />}
    </span>
  );
}

const ICONS = { xs: "size-3", sm: "size-3.5", md: "size-4", lg: "size-6", xl: "size-9" } as const;

const LETTERS = { xs: "text-[9px]", sm: "text-xs", md: "text-[15px]", lg: "text-2xl", xl: "text-[34px]" } as const;

/**
 * Your photo, or your initial on your colour; the figure stands in until there
 * is a name. A className background only shows while no colour is picked.
 */
function YouTile({ profile, className, letter, icon }: { profile: Profile; className: string; letter: string; icon: string }) {
  const initial = initialOf(profile.name);
  const color = !profile.photo && profile.color ? colorOf(profile.color) : undefined;
  return (
    <span
      className={cn(
        "bg-muted text-muted-foreground relative flex shrink-0 items-center justify-center overflow-hidden rounded-[12%]",
        RING,
        className,
        color && "text-white",
      )}
      style={color ? { backgroundColor: color } : undefined}
    >
      {profile.photo ? (
        <img src={profile.photo} alt="" draggable={false} className="size-full object-cover select-none" />
      ) : initial ? (
        <span className={cn("leading-none font-semibold", letter)}>{initial}</span>
      ) : (
        <User className={icon} />
      )}
    </span>
  );
}

/** You, wherever a conversation shows the people in it. The profile editor passes the draft it is changing. */
export function HumanAvatar({ size = "md", profile, className }: { size?: keyof typeof SIZES; profile?: Profile; className?: string }) {
  const me = useMe().profile;
  return <YouTile profile={profile ?? me} className={cn(SIZES[size], className)} letter={LETTERS[size]} icon={ICONS[size]} />;
}

function Dot({ busy, size }: { busy: Busy; size: keyof typeof DOTS }) {
  const { t } = useI18n();
  if (!busy) return null;
  return (
    <span
      className={cn(
        "ring-background absolute -right-0.5 -bottom-0.5 rounded-full ring-2",
        DOTS[size],
        // pulsing is the busy dot's own animation, so only the other one grows in
        busy === "needs_you" ? cn("bg-amber-500", ICON_IN) : "animate-pulse bg-emerald-500",
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

/** The square's side, the gap between the tiles in it, and the count in the last cell. */
const GROUP_SIZES = {
  md: { box: "size-11", gap: "gap-px", tile: "rounded-[2px]", count: "text-[9px]" },
  lg: { box: "size-14", gap: "gap-[2px]", tile: "rounded-[3px]", count: "text-[11px]" },
  xl: { box: "size-20", gap: "gap-[3px]", tile: "rounded-[4px]", count: "text-[15px]" },
} as const;

/**
 * A group's face: a logo picked for it, or its members' faces in a grid, the
 * way a messenger tiles a group's picture. Up to four fill a two-by-two;
 * more switch to three-by-three, and whoever is left over is counted in the
 * last cell.
 */
export function GroupAvatar({
  bots,
  avatar = null,
  size = "md",
  busy = null,
}: {
  bots: Array<Pick<Bot, "id" | "avatar">>;
  /** a logo id chosen for the group; null tiles the members */
  avatar?: string | null;
  size?: keyof typeof GROUP_SIZES;
  busy?: Busy;
}) {
  const logos = useLogos();
  const { box, gap, tile, count } = GROUP_SIZES[size];
  const chosen = avatar ? logos.find((l) => l.id === avatar) : undefined;
  const cols = bots.length <= 4 ? 2 : 3;
  const room = cols * cols;
  const more = Math.max(0, bots.length - room);
  // with someone left over the last cell says how many, so one face gives up its place
  const shown = bots.slice(0, more > 0 ? room - 1 : room);
  return (
    <span className="relative inline-flex shrink-0">
      {chosen || bots.length < 2 ? (
        // one member wears its own face; the group badge beside the title says the rest
        <LogoImage logo={chosen ?? (shown[0] ? logoOf(shown[0], logos) : undefined)} className={box} />
      ) : (
        <span
          className={cn("grid overflow-hidden", gap, box, cols === 2 ? "grid-cols-2" : "grid-cols-3")}
          aria-hidden
        >
          {shown.map((b, i) => (
            <LogoImage key={i} logo={logoOf(b, logos)} className={cn("size-full", tile)} />
          ))}
          {more > 0 && (
            <span className={cn("bg-muted text-muted-foreground flex size-full items-center justify-center font-semibold tabular-nums", tile, count)}>
              +{more}
            </span>
          )}
        </span>
      )}
      <Dot busy={busy} size={size} />
    </span>
  );
}
