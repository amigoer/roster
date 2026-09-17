import { Fragment, useEffect, useState } from "react";
import { ExternalLink, FolderInput, FolderOpen, FolderSearch, Loader, MessageSquareDashed } from "lucide-react";
import { api, type Conversation, type Location, type Locations } from "./api";
import { desktop } from "./desktop";
import { useI18n, type Translate } from "./i18n";
import { Choice } from "./settings/shared";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { RadioGroup } from "@/components/ui/radio-group";
import { Skeleton } from "@/components/ui/skeleton";
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

/** A chat space, a directory used before, or any other: one choice, drawn as tiles. */
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
  // what was typed stays while another tile is tried, so coming back does not start over
  const [typed, setTyped] = useState(value.kind === "repo" && !inRecent ? value.path : "");
  const picked = value.kind === "chat" ? CHAT : inRecent ? recentKey(value.path) : OTHER;
  const pick = (v: string) => {
    if (v === CHAT) onChange({ kind: "chat" });
    else if (v === OTHER) onChange({ kind: "repo", path: typed });
    else onChange({ kind: "repo", path: v.slice("recent:".length) });
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
      <RadioGroup value={picked} onValueChange={pick} className="grid gap-2">
        <Choice value={CHAT} selected={picked === CHAT}>
          <MessageSquareDashed className="text-muted-foreground size-4 shrink-0" />
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium">{t("location.chat")}</span>
            <span className="text-muted-foreground block text-xs">{t("location.chatHint")}</span>
          </span>
        </Choice>
        {locations === null ? (
          <Skeleton className="h-11 rounded-xl" />
        ) : (
          recent.length > 0 && (
            <>
              <span className="text-muted-foreground px-1 pt-1 text-xs">{t("location.recent")}</span>
              {recent.map((path) => (
                <Choice key={path} value={recentKey(path)} selected={picked === recentKey(path)} className="py-2">
                  <FolderOpen className="text-muted-foreground size-4 shrink-0" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{repoName(path)}</span>
                    <span className="text-muted-foreground block truncate font-mono text-[11px]">{path}</span>
                  </span>
                </Choice>
              ))}
            </>
          )
        )}
        <Choice value={OTHER} selected={picked === OTHER} className="items-start">
          <FolderSearch className="text-muted-foreground mt-0.5 size-4 shrink-0" />
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium">{t("location.other")}</span>
            <span className="mt-1.5 flex gap-2">
              <Input
                value={typed}
                spellCheck={false}
                onChange={(e) => {
                  setTyped(e.target.value);
                  onChange({ kind: "repo", path: e.target.value });
                }}
                onFocus={() => {
                  if (picked !== OTHER) onChange({ kind: "repo", path: typed });
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.nativeEvent.isComposing) onSubmit?.();
                }}
                placeholder="/path/to/repo"
                className="h-8 font-mono text-xs"
              />
              {bridge && (
                <Button type="button" variant="outline" size="sm" className="h-8" onClick={() => void browse()}>
                  {t("location.browse")}
                </Button>
              )}
            </span>
          </span>
        </Choice>
      </RadioGroup>
      {inUse.length > 0 && (
        <p className="text-xs text-amber-600 dark:text-amber-400">{t("location.inUse", { titles: list(inUse.map((c) => c.title)) })}</p>
      )}
    </div>
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
