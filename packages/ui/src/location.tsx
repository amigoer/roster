import { Fragment, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import {
  Circle,
  CircleDot,
  ExternalLink,
  Folder,
  FolderInput,
  FolderOpen,
  FolderSearch,
  Loader,
  MessageSquareDashed,
  TriangleAlert,
} from "lucide-react";
import { api, type Conversation, type Location, type Locations } from "./api";
import { desktop } from "./desktop";
import { useI18n, type Translate } from "./i18n";
import { Collapse, ICON_IN } from "./motion";
import { WARN_TEXT } from "./settings/shared";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

const LOCATION = "roster.location";
/** what the dialog remembered before it knew about chat spaces: a path alone */
const LEGACY_DIR = "roster.lastDir";

/** The last name in a path: what a repository is called. */
export const repoName = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;

/** What a conversation's place is called: a chat space by that name, a repository by its path. */
export const locationLabel = (t: Translate, conv: Pick<Conversation, "dir_kind" | "repo_path">) =>
  conv.dir_kind === "chat" ? t("location.chat") : conv.repo_path;

/** The place picked last time, which is almost always the place wanted next. */
export function recallLocation(): Location | null {
  try {
    const raw = localStorage.getItem(LOCATION);
    if (raw) {
      const v = JSON.parse(raw) as Partial<Location>;
      if (v.kind === "chat") return { kind: "chat" };
      if (v.kind === "repo" && typeof v.path === "string" && v.path) return { kind: "repo", path: v.path };
    }
    const legacy = localStorage.getItem(LEGACY_DIR);
    if (legacy) return { kind: "repo", path: legacy };
  } catch {
    // nothing remembered reads the same as never asked
  }
  return null;
}

export function rememberLocation(location: Location): void {
  try {
    localStorage.setItem(LOCATION, JSON.stringify(location));
    localStorage.removeItem(LEGACY_DIR);
  } catch {
    // a place that cannot be remembered still works this time
  }
}

/** Where a conversation can work, fetched each time a picker opens: directories come and go. */
export function useLocations(open: boolean): Locations | null {
  const [locations, setLocations] = useState<Locations | null>(null);
  // cleared in the render that opens the picker: last time's list must not light a row for a frame
  const [was, setWas] = useState(open);
  if (was !== open) {
    setWas(open);
    setLocations(null);
  }
  useEffect(() => {
    if (!open) return;
    let live = true;
    api
      .locations()
      .then((l) => live && setLocations({ chats: l.chats ?? "", recent: l.recent ?? [] }))
      .catch(() => live && setLocations({ chats: "", recent: [] }));
    return () => {
      live = false;
    };
  }, [open]);
  return locations;
}

const CHAT = "chat";
const OTHER = "other";
const recentKey = (path: string) => `recent:${path}`;

/** A field set into a tinted row: a slot in the surface, lit when it has focus. */
const SLOT =
  "bg-background placeholder:text-muted-foreground/70 rounded-lg border outline-none focus-visible:border-ring/60 focus-visible:ring-[3px] focus-visible:ring-ring/20 transition-[border-color,box-shadow]";

/** A chat space, a directory used before, or any other: one choice, as a framed list that takes one. */
export function LocationPicker({
  value,
  onChange,
  locations,
  convs,
  excludeId,
  onSubmit,
}: {
  value: Location;
  onChange: (location: Location) => void;
  /** null while loading */
  locations: Locations | null;
  /** to say when the chosen directory already has a conversation in it */
  convs: Conversation[];
  /** the conversation being moved, which is not its own neighbour */
  excludeId?: string;
  onSubmit?: () => void;
}) {
  const { t, list } = useI18n();
  const bridge = desktop();
  const recent = locations?.recent ?? [];
  const inRecent = value.kind === "repo" && recent.includes(value.path);
  // picked by hand, the other row keeps its field even when what is typed matches a row above
  const [other, setOther] = useState(false);
  // what was typed stays while another row is tried, so coming back does not start over
  const [typed, setTyped] = useState("");
  useEffect(() => {
    // the list arrives after the dialog opens: a remembered path that is not in it belongs in the field
    if (locations && value.kind === "repo" && !locations.recent.includes(value.path)) {
      setTyped(value.path);
      setOther(true);
    }
    // once, when the list arrives
  }, [locations]);
  // until the list is here, a remembered path has no row to light
  const picked = value.kind === "chat" ? CHAT : locations === null ? "" : other || !inRecent ? OTHER : recentKey(value.path);
  // the field takes focus when its row is picked by hand, not when a dialog opens on it
  const field = useRef<HTMLInputElement>(null);
  const pick = (v: string) => {
    setOther(v === OTHER);
    if (v === CHAT) onChange({ kind: "chat" });
    else if (v === OTHER) {
      onChange({ kind: "repo", path: typed });
      // the field unfolds inside a clipped box; scrolling it into view would leave that box cut off
      requestAnimationFrame(() => field.current?.focus({ preventScroll: true }));
    } else onChange({ kind: "repo", path: v.slice("recent:".length) });
  };
  const chosen = value.kind === "repo" ? value.path.trim() : "";
  const inUse = chosen ? convs.filter((c) => !c.archived && c.id !== excludeId && c.dir_kind === "repo" && c.repo_path === chosen) : [];
  const browse = async () => {
    const dir = await bridge?.pickDirectory(chosen || undefined);
    if (!dir) return;
    setTyped(dir);
    onChange({ kind: "repo", path: dir });
  };

  return (
    <div className="overflow-hidden rounded-xl border">
      <RadioGroup value={picked} onValueChange={pick} className="gap-0 divide-y">
        <PlaceRow value={CHAT} selected={picked === CHAT} icon={MessageSquareDashed} title={t("location.chat")} line={t("location.chatHint")} />
        {locations === null ? (
          <div className="px-3 py-2">
            <Skeleton className="h-9 rounded-lg" />
          </div>
        ) : (
          recent.length > 0 && (
            <>
              <div className="bg-muted/70 text-muted-foreground px-3 py-1 text-[11px] font-medium">{t("location.recent")}</div>
              {recent.map((path) => {
                const on = picked === recentKey(path);
                // the folder picked is the one standing open
                return <PlaceRow key={path} value={recentKey(path)} selected={on} icon={on ? FolderOpen : Folder} title={repoName(path)} line={path} mono />;
              })}
            </>
          )
        )}
        <PlaceRow value={OTHER} selected={picked === OTHER} icon={FolderSearch} title={t("location.other")}>
          {/* the path goes in a slot under its row, which unfolds only once the row is picked */}
          <Collapse open={picked === OTHER}>
            <div className="flex gap-2 pt-0.5 pr-3 pb-2.5 pl-[52px]">
              <input
                ref={field}
                value={typed}
                spellCheck={false}
                onChange={(e) => {
                  setTyped(e.target.value);
                  onChange({ kind: "repo", path: e.target.value });
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.nativeEvent.isComposing) onSubmit?.();
                }}
                placeholder="/path/to/repo"
                className={cn(SLOT, "h-8 w-full min-w-0 px-2.5 font-mono text-xs")}
              />
              {bridge && (
                <Button type="button" variant="outline" size="sm" className="h-8 shrink-0" onClick={() => void browse()}>
                  {t("location.browse")}
                </Button>
              )}
            </div>
          </Collapse>
        </PlaceRow>
      </RadioGroup>
      {/* the card carries its own caution at the foot: who else works in the place picked */}
      <Collapse open={inUse.length > 0}>
        <p className={cn("flex items-start gap-2 border-t bg-amber-500/[0.06] px-3 py-2 text-xs leading-relaxed", WARN_TEXT)}>
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
          <span>{t("location.inUse", { titles: list(inUse.map((c) => c.title)) })}</span>
        </p>
      </Collapse>
    </div>
  );
}

/**
 * One place to work, as a row: its mark on a tile, its name, and a dot that
 * says the list takes one. Picked, the tile lights and the row wears the
 * tint a chosen member does; whatever hangs under the row shares it.
 */
function PlaceRow({
  value,
  selected,
  icon: Icon,
  title,
  line,
  mono,
  children,
}: {
  value: string;
  selected: boolean;
  icon: typeof FolderOpen;
  title: string;
  /** the second line, when the place needs one */
  line?: string;
  /** the line is a path */
  mono?: boolean;
  /** what hangs under the row, inside its tint */
  children?: ReactNode;
}) {
  return (
    <div className={cn("transition-colors duration-120", selected && "bg-selected")}>
      <label
        className={cn(
          "has-[:focus-visible]:ring-ring/60 flex cursor-pointer items-center gap-3 px-3 py-2 transition-colors duration-120 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-inset",
          !selected && "hover:bg-accent",
        )}
      >
        <RadioGroupItem value={value} className="sr-only" />
        <span
          className={cn(
            "flex size-7 shrink-0 items-center justify-center rounded-[23%] transition-colors duration-120",
            selected ? "bg-primary text-primary-foreground" : "bg-foreground/[0.06] text-muted-foreground",
          )}
        >
          <Icon className="size-3.5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{title}</span>
          {line && (
            <span title={mono ? line : undefined} className={cn("text-muted-foreground block truncate", mono ? "font-mono text-[11px]" : "text-xs")}>
              {line}
            </span>
          )}
        </span>
        {selected ? (
          <CircleDot className={cn("text-primary size-[18px] shrink-0", ICON_IN)} aria-hidden />
        ) : (
          <Circle className="text-foreground/30 size-[18px] shrink-0" strokeWidth={1.5} aria-hidden />
        )}
      </label>
      {children}
    </div>
  );
}

/**
 * Where a conversation works, as a chip the width of its name; the path is
 * its tooltip. A click opens the folder on the desktop, or the panel that
 * spells the place out where there is no desktop to open it in.
 */
export function PlaceChip({
  conv,
  onOpen,
  style,
}: {
  conv: Pick<Conversation, "dir_kind" | "repo_path">;
  onOpen: () => void;
  style?: CSSProperties;
}) {
  const { t } = useI18n();
  const bridge = desktop();
  const repo = conv.dir_kind === "repo";
  const Icon = repo ? FolderOpen : MessageSquareDashed;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          style={style}
          onClick={() => {
            if (bridge) void bridge.revealDirectory(conv.repo_path);
            else onOpen();
          }}
          className="bg-foreground/[0.06] text-muted-foreground hover:bg-foreground/[0.1] hover:text-foreground focus-visible:ring-ring/60 inline-flex max-w-[50%] shrink-0 items-center gap-1 rounded px-1 text-[10px] leading-4 transition-colors duration-120 outline-none focus-visible:ring-2"
        >
          <Icon className="size-3 shrink-0" />
          <span className="truncate">{repo ? repoName(conv.repo_path) : t("location.chat")}</span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-md">
        <span className="font-mono">{conv.repo_path}</span>
        {bridge && <span className="opacity-70"> · {t("location.reveal")}</span>}
      </TooltipContent>
    </Tooltip>
  );
}

/** The conversation's place: a chat space or a repository, opened in Finder on the desktop, and changed from here for a group. */
export function DirectorySection({ conv, convs, className }: { conv: Conversation; convs: Conversation[]; className?: string }) {
  const { t } = useI18n();
  const bridge = desktop();
  const [changing, setChanging] = useState(false);
  const chat = conv.dir_kind === "chat";
  // a direct chat is one bot in its chat space, which is the only place it can be
  const movable = conv.shape === "group";
  return (
    <section className={className}>
      <h3 className="text-muted-foreground mb-2 text-xs font-medium">{t("conversation.directory")}</h3>
      {chat && <p className="text-sm">{t("location.chat")}</p>}
      <p className={cn("font-mono wrap-anywhere", chat ? "text-muted-foreground mt-0.5 text-[11px]" : "text-xs")}>
        {/* a narrow column breaks after a separator, not inside a directory name */}
        {conv.repo_path.split(/(?<=[\\/])/).map((part, i) => (
          <Fragment key={i}>
            {part}
            <wbr />
          </Fragment>
        ))}
      </p>
      {(movable || bridge) && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {movable && (
            <Button size="xs" variant="outline" onClick={() => setChanging(true)}>
              <FolderInput />
              {t("location.change")}
            </Button>
          )}
          {bridge && (
            <Button size="xs" variant="ghost" className="text-muted-foreground" onClick={() => void bridge.revealDirectory(conv.repo_path)}>
              <ExternalLink />
              {t("location.reveal")}
            </Button>
          )}
        </div>
      )}
      {movable && <ChangeLocationDialog conv={conv} convs={convs} open={changing} onOpenChange={setChanging} />}
    </section>
  );
}

const locationOf = (conv: Conversation): Location => (conv.dir_kind === "chat" ? { kind: "chat" } : { kind: "repo", path: conv.repo_path });

export function ChangeLocationDialog({
  conv,
  convs,
  open,
  onOpenChange,
}: {
  conv: Conversation;
  convs: Conversation[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useI18n();
  const locations = useLocations(open);
  const [location, setLocation] = useState<Location>(() => locationOf(conv));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    setLocation(locationOf(conv));
    setError(null);
    // only on opening: the conversation moving underneath is what this dialog is for
  }, [open]);

  const path = location.kind === "repo" ? location.path.trim() : "";
  const same = location.kind === "chat" ? conv.dir_kind === "chat" : conv.dir_kind === "repo" && path === conv.repo_path;
  const apply = async () => {
    if (same || (location.kind === "repo" && !path)) return;
    setBusy(true);
    setError(null);
    const next: Location = location.kind === "repo" ? { kind: "repo", path } : location;
    const r = await api.setDirectory(conv.id, next);
    setBusy(false);
    if (r.error) {
      setError(r.error);
      return;
    }
    rememberLocation(next);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100vh-2rem)] overflow-y-auto sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>{t("location.changeTitle")}</DialogTitle>
          <DialogDescription>{t("location.changeBody")}</DialogDescription>
        </DialogHeader>
        {open && (
          <LocationPicker value={location} onChange={setLocation} locations={locations} convs={convs} excludeId={conv.id} onSubmit={() => void apply()} />
        )}
        {error && <p className="text-destructive text-xs">{error}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button onClick={() => void apply()} disabled={busy || same || (location.kind === "repo" && !path)}>
            {busy && <Loader className="animate-spin" />}
            {t("location.apply")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
