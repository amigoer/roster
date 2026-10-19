import { DRAG, NO_DRAG } from "./app-region";
import { HumanAvatar } from "./bot-avatar";
import { useI18n } from "./i18n";
import { useMe } from "./me";
import { ContactsIcon, MessagesIcon, SettingsIcon } from "./rail-icons";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/** What each entry is called is in the catalog, under nav.<id>. */
export const NAV = [
  { id: "messages", icon: MessagesIcon },
  { id: "contacts", icon: ContactsIcon },
] as const;

/** neither has a place in the rail's two entries: your profile is your avatar above them, settings the gear under them */
export type Nav = (typeof NAV)[number]["id"] | "profile" | "settings";

/**
 * Icons and a word each: two entries never justify a resizable column. It is
 * as wide as it is to hold the traffic lights, which main.cjs centres on it.
 */
export const RAIL = 72;

/** Every entry, labelled or not, is the same tile holding the same size of icon. */
const TILE =
  "relative flex size-10 items-center justify-center rounded-[10px] outline-none transition-[background-color,color] duration-150 focus-visible:ring-2 focus-visible:ring-ring/60";
const RAISED = "text-primary";
const RESTING = "text-muted-foreground hover:bg-sidebar-accent hover:text-foreground";
const ICON = "size-[23px]";

/** A count in the top corner of an icon, the way a messenger marks what is waiting. */
const COUNT =
  "ring-sidebar absolute -top-0.5 -right-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] leading-none font-semibold text-white tabular-nums ring-2";

export function NavRail({ nav, onNav, waiting }: { nav: Nav; onNav: (nav: Nav) => void; waiting: number }) {
  const { t } = useI18n();
  const { profile } = useMe();
  return (
    <nav className="flex shrink-0 flex-col items-center pb-4" style={{ width: RAIL, ...DRAG }}>
      {/* the traffic lights sit in the top strip, main.cjs puts them there; you come right under them */}
      <div className="h-13 shrink-0" />
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={t("nav.profile")}
            aria-current={nav === "profile" ? "page" : undefined}
            onClick={() => onNav("profile")}
            style={NO_DRAG}
            className={cn(
              "ring-offset-sidebar mb-6 shrink-0 rounded-[12%] outline-none ring-offset-2 transition-shadow duration-150 focus-visible:ring-2 focus-visible:ring-ring/60",
              nav === "profile" ? "ring-2 ring-primary" : "hover:ring-2 hover:ring-foreground/15",
            )}
          >
            <HumanAvatar className="bg-muted" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="right">{profile.name || t("nav.profile")}</TooltipContent>
      </Tooltip>
      <div className="flex flex-col items-center gap-2" style={NO_DRAG}>
        {NAV.map((n) => {
          const on = nav === n.id;
          return (
            <Tooltip key={n.id}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => onNav(n.id)}
                  aria-label={t(`nav.${n.id}`)}
                  aria-current={on ? "page" : undefined}
                  className={cn(TILE, on ? RAISED : RESTING)}
                >
                  <n.icon active={on} className={ICON} />
                  {/* the same count the dock badge carries: conversations that are waiting on you */}
                  {n.id === "messages" && waiting > 0 && <span className={COUNT}>{waiting}</span>}
                </button>
              </TooltipTrigger>
              <TooltipContent side="right">{t(`nav.${n.id}`)}</TooltipContent>
            </Tooltip>
          );
        })}
      </div>

      <div className="mt-auto flex flex-col items-center" style={NO_DRAG}>
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
