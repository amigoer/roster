import { Fragment, useEffect, useRef, useState, type CSSProperties } from "react";
import {
  Circle,
  CircleDot,
  ExternalLink,
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
import { FIELD } from "./list";
import { ICON_IN } from "./motion";
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
  useEffect(() => {
    if (!open) return;
    let live = true;
    setLocations(null);
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

/** A chat space, a directory used before, or any other: one choice, as a list that takes one. */
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
  // what was typed stays while another row is tried, so coming back does not start over
  const [typed, setTyped] = useState(value.kind === "repo" && !inRecent ? value.path : "");
  const picked = value.kind === "chat" ? CHAT : inRecent ? recentKey(value.path) : OTHER;
  // the field takes focus when its row is picked by hand, not when a dialog opens on it
  const field = useRef<HTMLInputElement>(null);
  const pick = (v: string) => {
    if (v === CHAT) onChange({ kind: "chat" });
    else if (v === OTHER) {
      onChange({ kind: "repo", path: typed });
      requestAnimationFrame(() => field.current?.focus());
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
    <div className="grid gap-2">
      {/* rows hang into the margin the way the sidebar's do, so their text lines up with the heading */}
      <div className="-mx-2.5">
        <RadioGroup value={picked} onValueChange={pick} className="gap-0.5">
          <PlaceRow value={CHAT} selected={picked === CHAT} icon={MessageSquareDashed} title={t("location.chat")} line={t("location.chatHint")} />
          {locations === null ? (
            <Skeleton className="mx-1 my-0.5 h-10 rounded-lg" />
          ) : (
            recent.length > 0 && (
              <>
                <span className="text-muted-foreground px-2.5 pt-1.5 pb-0.5 text-[11px] font-medium">{t("location.recent")}</span>
                {recent.map((path) => (
                  <PlaceRow key={path} value={recentKey(path)} selected={picked === recentKey(path)} icon={FolderOpen} title={repoName(path)} line={path} mono />
                ))}
              </>
            )
          )}
          <PlaceRow value={OTHER} selected={picked === OTHER} icon={FolderSearch} title={t("location.other")} />
        </RadioGroup>
        {/* the field stays in view under its row, so a path is never a click away; typing into it picks the row */}
        <div className="flex gap-2 pt-1 pr-2.5 pb-1 pl-9">
          <input
            ref={field}
            value={typed}
            spellCheck={false}
            onFocus={() => {
              if (picked !== OTHER) onChange({ kind: "repo", path: typed });
            }}
            onChange={(e) => {
              setTyped(e.target.value);
              onChange({ kind: "repo", path: e.target.value });
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing) onSubmit?.();
            }}
            placeholder="/path/to/repo"
            className={cn(FIELD, "h-8 w-full min-w-0 px-2.5 font-mono text-xs")}
          />
          {bridge && (
            <Button type="button" variant="secondary" size="sm" className="h-8 shrink-0" onClick={() => void browse()}>
              {t("location.browse")}
            </Button>
          )}
        </div>
      </div>
      {inUse.length > 0 && (
        <p className={cn("flex items-start gap-1.5 text-xs leading-relaxed", WARN_TEXT)}>
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
          <span>{t("location.inUse", { titles: list(inUse.map((c) => c.title)) })}</span>
        </p>
      )}
    </div>
  );
}

/** One place to work, as a row: picked, it wears the tint a chosen member does, and a dot says the list takes one. */
function PlaceRow({
  value,
  selected,
  icon: Icon,
  title,
  line,
  mono,
}: {
  value: string;
  selected: boolean;
  icon: typeof FolderOpen;
  title: string;
  /** the second line, when the place needs one */
  line?: string;
  /** the line is a path */
  mono?: boolean;
}) {
  return (
    <label
      className={cn(
        "has-[:focus-visible]:ring-ring/60 flex cursor-pointer items-center gap-2.5 rounded-[10px] px-2.5 py-1.5 transition-colors duration-120 has-[:focus-visible]:ring-2",
        selected ? "bg-selected" : "hover:bg-accent",
      )}
    >
      <RadioGroupItem value={value} className="sr-only" />
      <Icon className={cn("size-4 shrink-0", selected ? "text-primary" : "text-muted-foreground")} />
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
