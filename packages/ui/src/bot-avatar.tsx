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
        "bg-muted text-muted-foreground relative flex shrink-0 items-center justify-center overflow-hidden rounded-[23%]",
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

/** The square's side, the ring that lifts a tile off the one under it, and the count pill in the free corner. */
const GROUP_SIZES = {
  md: { box: "size-9", ring: "ring-[1.5px]", badge: "h-3.5 min-w-3.5 px-1 text-[8px]" },
  lg: { box: "size-14", ring: "ring-2", badge: "h-5 min-w-5 px-1.5 text-[10px]" },
  xl: { box: "size-20", ring: "ring-[3px]", badge: "h-7 min-w-7 px-2 text-xs" },
} as const;

/** How many faces a group shows before the rest become a count. */
const FACES = 3;

/** Three tiles down the diagonal, each stepping past the one under it; two alone get the pair's bigger tiles. */
const STACK = ["top-0 left-0", "top-[21%] left-[21%]", "right-0 bottom-0"] as const;

/**
 * A group's face: a logo picked for it, or its members' faces stacked down
 * the diagonal the way a pile of cards sits, the front one ringed off the
 * one under it. Whole faces, since these characters do not survive being
 * quartered; past three, the free corner counts the rest.
 */
export function GroupAvatar({
  bots,
  avatar = null,
  size = "md",
  busy = null,
}: {
  bots: Array<Pick<Bot, "id" | "avatar">>;
  /** a logo id chosen for the group; null stacks the members */
  avatar?: string | null;
  size?: keyof typeof GROUP_SIZES;
  busy?: Busy;
}) {
  const logos = useLogos();
  const { box, ring, badge } = GROUP_SIZES[size];
  const chosen = avatar ? logos.find((l) => l.id === avatar) : undefined;
  const shown = bots.slice(0, FACES);
  const more = bots.length - shown.length;
  return (
    <span className="relative inline-flex shrink-0">
      {chosen || shown.length < 2 ? (
        // one member wears its own face; the group badge beside the title says the rest
        <LogoImage logo={chosen ?? (shown[0] ? logoOf(shown[0], logos) : undefined)} className={box} />
      ) : (
        <span className={cn("relative block", box)} aria-hidden>
          {shown.map((b, i) => (
            <LogoImage
              key={i}
              logo={logoOf(b, logos)}
              className={cn(
                "absolute",
                shown.length === 2 ? cn("size-[72%]", i === 0 ? STACK[0] : STACK[2]) : cn("size-[58%]", STACK[i]),
                i > 0 && cn("ring-background", ring),
              )}
            />
          ))}
          {more > 0 && (
            <span
              className={cn(
                "bg-foreground text-background ring-background absolute -top-0.5 -right-0.5 inline-flex items-center justify-center rounded-full leading-none font-semibold tabular-nums",
                ring,
                badge,
              )}
            >
              +{more}
            </span>
          )}
        </span>
      )}
      <Dot busy={busy} size={size} />
    </span>
  );
}
