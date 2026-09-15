import { DRAG, NO_DRAG } from "./app-region";
import { HumanAvatar } from "./bot-avatar";
import { useI18n } from "./i18n";
import { useMe } from "./me";
import { ContactsIcon, MessagesIcon, SettingsIcon, SpaceIcon } from "./rail-icons";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/** What each entry is called is in the catalog, under nav.<id>. */
export const NAV = [
  { id: "messages", icon: MessagesIcon },
  { id: "contacts", icon: ContactsIcon },
  { id: "space", icon: SpaceIcon },
] as const;

/** neither has a place in the rail's three entries: your profile is your avatar above them, settings the gear under them */
export type Nav = (typeof NAV)[number]["id"] | "profile" | "settings";

/**
 * Icons and a word each: three entries never justify a resizable column. It is
 * as wide as it is to hold the traffic lights, which main.cjs centres on it.
 */
export const RAIL = 72;

/** Every entry, labelled or not, is the same tile holding the same size of icon. */
const TILE =
  "relative flex size-10 items-center justify-center rounded-xl outline-none transition-[background-color,color,box-shadow] duration-150 focus-visible:ring-2 focus-visible:ring-ring/60";
/** The active entry is lifted onto the same white as the panel it opens. */
const RAISED = "bg-background text-primary shadow-panel";
const RESTING = "text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground";
const ICON = "size-[22px]";

export function NavRail({ nav, onNav, waiting }: { nav: Nav; onNav: (nav: Nav) => void; waiting: number }) {
  const { t } = useI18n();
  const { profile } = useMe();
  return (
    <nav className="flex shrink-0 flex-col items-center pb-3" style={{ width: RAIL, ...DRAG }}>
      {/* the traffic lights sit in the top strip, main.cjs puts them there; you come right under them, as in any IM */}
      <div className="h-12 shrink-0" />
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={t("nav.profile")}
            aria-current={nav === "profile" ? "page" : undefined}
            onClick={() => onNav("profile")}
            style={NO_DRAG}
            className={cn(
              "ring-offset-sidebar mb-4 shrink-0 rounded-[23%] ring-offset-2 transition-shadow duration-150 outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
              // neutral, like a picked logo: a blue ring fights whatever colour the avatar is
              nav === "profile" ? "ring-foreground/80 ring-2" : "hover:ring-foreground/15 hover:ring-2",
            )}
          >
            {/* the plain grey tile is the rail's own grey; white lifts it the way an active entry is lifted */}
            <HumanAvatar className="bg-background" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="right">{profile.name || t("nav.profile")}</TooltipContent>
      </Tooltip>
      <div className="flex flex-col items-center gap-1.5" style={NO_DRAG}>
        {NAV.map((n) => {
          const on = nav === n.id;
          return (
            <button
              key={n.id}
              type="button"
              onClick={() => onNav(n.id)}
              aria-current={on ? "page" : undefined}
              className="group/nav flex w-16 flex-col items-center gap-1 rounded-xl py-1 outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
            >
              <span className={cn(TILE, on ? RAISED : "text-muted-foreground group-hover/nav:bg-sidebar-accent group-hover/nav:text-sidebar-foreground")}>
                <n.icon active={on} className={ICON} />
                {/* the same count the dock badge carries: conversations that are waiting on you */}
                {n.id === "messages" && waiting > 0 && (
                  <span className="ring-sidebar absolute -top-1 -right-1.5 min-w-4 rounded-full bg-amber-500 px-1 text-center text-[10px] leading-4 font-semibold text-white tabular-nums ring-2">
                    {waiting}
                  </span>
                )}
              </span>
              <span
                className={cn(
                  "text-[11px] leading-4 transition-colors duration-150",
                  on ? "font-medium" : "text-muted-foreground group-hover/nav:text-sidebar-foreground",
                )}
              >
                {t(`nav.${n.id}`)}
              </span>
            </button>
          );
        })}
      </div>

      <div className="mt-auto flex flex-col items-center gap-1.5" style={NO_DRAG}>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label={t("nav.settings")}
              aria-current={nav === "settings" ? "page" : undefined}
              onClick={() => onNav("settings")}
              className={cn(TILE, nav === "settings" ? RAISED : RESTING)}
            >
              <SettingsIcon active={nav === "settings"} className={ICON} />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right">{t("nav.settingsHint")}</TooltipContent>
        </Tooltip>
      </div>
    </nav>
  );
}
