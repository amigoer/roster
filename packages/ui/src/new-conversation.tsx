import { useEffect, useMemo, useState } from "react";
import { Check, Crown, Loader, Search } from "lucide-react";
import { api, type Bot, type Capabilities, type Conversation, type Location, type Mode } from "./api";
import { BotAvatar } from "./bot-avatar";
import { CapabilityNotes } from "./capabilities";
import { useExecutor } from "./executors";
import { useI18n } from "./i18n";
import { LocationPicker, recallLocation, rememberLocation, useLocations } from "./location";
import { ModePicker } from "./members-panel";
import { Collapse, ICON_IN } from "./motion";
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
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

/** A direct chat is one bot in a chat space of its own, so there is nothing to choose: it starts without the dialog. */
export const startDirect = (bot: Bot) => api.createConversation({ chat: true, botIds: [bot.id] });

export function NewConversation({
  open,
  onOpenChange,
  bots,
  capabilities,
  convs,
  initialBotIds,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  bots: Bot[];
  capabilities: Record<string, Capabilities>;
  /** to say when the chosen directory already has a conversation in it */
  convs: Conversation[];
  /** preselected, e.g. from a contact's profile */
  initialBotIds: string[];
  onCreated: (c: Conversation) => void;
}) {
  const [picked, setPicked] = useState<string[]>([]);
  const executor = useExecutor();
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [title, setTitle] = useState("");
  const [mode, setMode] = useState<Mode>("human_led");
  const [leader, setLeader] = useState<string | null>(null);
  const [location, setLocation] = useState<Location>({ kind: "chat" });
  const locations = useLocations(open);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setPicked(initialBotIds.filter((id) => bots.some((b) => b.id === id)));
    setQuery("");
    setTitle("");
    setMode("human_led");
    setLeader(null);
    setError(null);
    // the place picked last time is almost always the one wanted next; the first time, a chat space asks nothing
    setLocation(recallLocation() ?? { kind: "chat" });
    // only on opening; bots updating underneath must not reset a half-filled form
  }, [open]);

  const chosen = picked.flatMap((id) => bots.filter((b) => b.id === id));
  // one bot in a chat space is a direct chat; a repository, or company, makes a group
  const group = chosen.length > 1 || location.kind === "repo";
  const leaderBot = chosen.find((b) => b.id === leader) ?? chosen[0];
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q
      ? bots.filter((b) => b.name.toLowerCase().includes(q) || (b.title ?? "").toLowerCase().includes(q))
      : bots;
  }, [bots, query]);

  const toggle = (id: string) =>
    setPicked((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const path = location.kind === "repo" ? location.path.trim() : "";
  const ready = chosen.length > 0 && (location.kind === "chat" || path.length > 0);

  const create = async () => {
    if (!ready) return;
    setBusy(true);
    setError(null);
    const where: Location = location.kind === "repo" ? { kind: "repo", path } : location;
    const r = await api.createConversation({
      // left out, core names it in its own language, and the first message renames it
      ...(group && title.trim() ? { title: title.trim() } : {}),
      ...(where.kind === "chat" ? { chat: true as const } : { repoPath: where.path }),
      botIds: chosen.map((b) => b.id),
      ...(chosen.length > 1 ? { mode, ...(mode === "leader" && leaderBot ? { leaderBotId: leaderBot.id } : {}) } : {}),
    });
    setBusy(false);
    if (r.error || !r.conversation) {
      setError(r.error ?? t("common.createFailed"));
      return;
    }
    rememberLocation(where);
    onCreated(r.conversation);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100vh-2rem)] overflow-y-auto sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>{t("newConversation.title")}</DialogTitle>
          <DialogDescription>{t("newConversation.description")}</DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-1">
          <div className="grid gap-2">
            <div className="flex items-center justify-between">
              <Label>{t("members.title")}</Label>
              <span className="text-muted-foreground text-xs">
                {chosen.length === 0
                  ? t("newConversation.none")
                  : group
                    ? t("newConversation.group", { count: chosen.length })
                    : t("newConversation.direct")}
              </span>
            </div>
            <div className="relative">
              <Search className="text-muted-foreground pointer-events-none absolute top-2.5 left-2.5 size-4" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t("newConversation.search")}
                className="h-9 pl-8"
              />
            </div>
            <div className="max-h-56 overflow-y-auto rounded-md border p-1">
              {shown.length === 0 && (
                <p className="text-muted-foreground px-2 py-6 text-center text-sm">
                  {bots.length === 0 ? t("newConversation.noContacts") : t("newConversation.noMatches")}
                </p>
              )}
              {shown.map((b) => {
                const on = picked.includes(b.id);
                return (
                  <button
                    key={b.id}
                    type="button"
                    onClick={() => toggle(b.id)}
                    className={cn(
                      "focus-visible:ring-ring/50 flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors duration-120 outline-none focus-visible:ring-2",
                      on ? "bg-accent" : "hover:bg-accent/50",
                    )}
                  >
                    <BotAvatar bot={b} size="sm" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{b.name}</span>
                      <span className="text-muted-foreground block truncate text-xs">
                        {b.title ?? `${executor(b.executor_id).label}${b.model ? ` · ${b.model}` : ""}`}
                      </span>
                    </span>
                    <span
                      className={cn(
                        "flex size-4 shrink-0 items-center justify-center rounded border transition-[background-color,border-color] duration-120",
                        on && "bg-primary border-primary text-primary-foreground",
                      )}
                    >
                      {on && <Check className={cn("size-3", ICON_IN)} />}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="grid gap-2">
            <Label>{t("conversation.directory")}</Label>
            <LocationPicker value={location} onChange={setLocation} locations={locations} convs={convs} onSubmit={() => void create()} />
          </div>

          {/* folded, it must not leave the grid's gap behind: the margin takes the gap back and the padding restores it open */}
          <Collapse open={group} className="-mt-4">
            {group && (
              <div className="grid gap-4 pt-4">
                <div className="grid gap-2">
                  <Label htmlFor="group-title">{t("newConversation.groupName")}</Label>
                  <Input
                    id="group-title"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.nativeEvent.isComposing) void create();
                    }}
                    placeholder={t("newConversation.groupNamePlaceholder")}
                  />
                </div>
                {/* who answers is only a question once there is more than one who could */}
                {chosen.length > 1 && (
                  <div className="grid gap-2">
                    <Label>{t("members.whoAnswers")}</Label>
                    <ModePicker value={mode} onChange={setMode} compact />
                    <Collapse open={mode === "leader"} className="-mt-2">
                      {mode === "leader" && (
                        <div className="flex flex-wrap items-center gap-1.5 pt-3">
                          <span className="text-muted-foreground mr-1 text-xs">{t("members.leader")}</span>
                          {chosen.map((b) => (
                            <button
                              key={b.id}
                              type="button"
                              onClick={() => setLeader(b.id)}
                              className={cn(
                                "inline-flex items-center gap-1.5 rounded-full border py-0.5 pr-2.5 pl-0.5 text-xs transition-colors duration-120",
                                leaderBot?.id === b.id ? "border-foreground/40 bg-accent" : "hover:bg-accent/50",
                              )}
                            >
                              <BotAvatar bot={b} size="xs" />
                              {b.name}
                              {leaderBot?.id === b.id && <Crown className={cn("size-3 text-amber-500", ICON_IN)} />}
                            </button>
                          ))}
                        </div>
                      )}
                    </Collapse>
                  </div>
                )}
              </div>
            )}
          </Collapse>

          {error && <p className="text-destructive text-xs">{error}</p>}

          <Collapse open={chosen.length === 1 && Boolean(capabilities[chosen[0]!.executor_id])} className="-mt-4">
            {chosen.length === 1 && capabilities[chosen[0]!.executor_id] && (
              <div className="pt-4">
                <div className="border-t pt-3">
                  <CapabilityNotes caps={capabilities[chosen[0]!.executor_id]!} />
                </div>
              </div>
            )}
          </Collapse>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button onClick={() => void create()} disabled={busy || !ready}>
            {busy && <Loader className="animate-spin" />}
            {group ? t("newConversation.createGroup") : t("newConversation.start")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
