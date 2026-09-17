import { useEffect, useMemo, useState } from "react";
import { Circle, CircleCheck, Crown, Loader, Users } from "lucide-react";
import { RadioGroup as RadioGroupPrimitive } from "radix-ui";
import { api, type Bot, type Capabilities, type Conversation, type Location, type Mode } from "./api";
import { BotAvatar, GroupAvatar } from "./bot-avatar";
import { CapabilityNotes } from "./capabilities";
import { useExecutor } from "./executors";
import { useI18n } from "./i18n";
import { ListSearch, ROW, rowState } from "./list";
import { LocationPicker, recallLocation, rememberLocation, repoName, useLocations } from "./location";
import { MODES } from "./members-panel";
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
import { cn } from "@/lib/utils";

/** A direct chat is one bot in a chat space of its own, so there is nothing to choose: it starts without the dialog. */
export const startDirect = (bot: Bot) => api.createConversation({ chat: true, botIds: [bot.id] });

/** The label over one part of the setup, the way the members panel heads its sections. */
const HEADING = "text-muted-foreground text-xs font-medium";

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

  /** the line under a bot's name: its role, or what it runs on */
  const line = (b: Bot) => b.title ?? `${executor(b.executor_id).label}${b.model ? ` · ${b.model}` : ""}`;

  const path = location.kind === "repo" ? location.path.trim() : "";
  const ready = chosen.length > 0 && (location.kind === "chat" || path.length > 0);
  const caps = chosen.length === 1 ? capabilities[chosen[0]!.executor_id] : undefined;

  // what the button will make, spelled out: its shape and its place
  const status =
    chosen.length === 0
      ? null
      : [
          group ? t("newConversation.group", { count: chosen.length }) : t("newConversation.direct"),
          location.kind === "chat" ? t("location.chat") : repoName(path),
        ]
          .filter(Boolean)
          .join(" · ");

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
      <DialogContent className="flex max-h-[calc(100vh-2rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-[800px]">
        <DialogHeader className="shrink-0 px-6 pt-6 pb-4">
          <DialogTitle>{t("newConversation.title")}</DialogTitle>
          <DialogDescription>{t("newConversation.description")}</DialogDescription>
        </DialogHeader>

        {/* the contacts on the left, the room they make on the right; one column where there is no width for two */}
        <div className="flex min-h-0 flex-col overflow-y-auto border-y md:grid md:h-[min(530px,calc(100vh-12rem))] md:grid-cols-[296px_minmax(0,1fr)] md:overflow-hidden">
          <div className="bg-muted/50 flex min-h-0 shrink-0 flex-col md:shrink">
            <div className="px-1 pt-3">
              <ListSearch
                value={query}
                onChange={setQuery}
                placeholder={t("newConversation.search")}
                onEnter={() => {
                  const first = shown[0];
                  if (!first) return;
                  toggle(first.id);
                  setQuery("");
                }}
              />
            </div>
            <div className={cn("flex items-center justify-between px-5 pt-1 pb-1", HEADING)}>
              <span>{t("members.title")}</span>
              {chosen.length > 0 && (
                <span className="text-primary tabular-nums">{t("newConversation.picked", { count: chosen.length })}</span>
              )}
            </div>
            <div className="max-h-56 min-h-0 flex-1 overflow-y-auto px-2 pb-2 md:max-h-none">
              {shown.length === 0 && (
                <p className="text-muted-foreground px-3 py-8 text-center text-sm">
                  {bots.length === 0 ? t("newConversation.noContacts") : t("newConversation.noMatches")}
                </p>
              )}
              {shown.map((b) => {
                const on = picked.includes(b.id);
                return (
                  <button
                    key={b.id}
                    type="button"
                    aria-pressed={on}
                    onClick={() => toggle(b.id)}
                    className={cn(ROW, rowState(on), "gap-2.5 py-1.5")}
                  >
                    <BotAvatar bot={b} size="sm" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{b.name}</span>
                      <span className="text-muted-foreground block truncate text-xs">{line(b)}</span>
                    </span>
                    {/* a round tick, the way a messenger's people picker ticks: this list takes any number */}
                    {on ? (
                      <CircleCheck className={cn("fill-primary text-primary-foreground size-[18px] shrink-0", ICON_IN)} />
                    ) : (
                      <Circle className="text-foreground/30 size-[18px] shrink-0" strokeWidth={1.5} />
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="min-h-0 md:overflow-y-auto">
            <div className="grid gap-5 px-6 pt-4 pb-3">
              <RoomCard chosen={chosen} group={group} title={title} onTitle={setTitle} onSubmit={() => void create()} line={line} />

              <section className="grid gap-2">
                <h3 className={HEADING}>{t("conversation.directory")}</h3>
                <LocationPicker value={location} onChange={setLocation} locations={locations} convs={convs} onSubmit={() => void create()} />
              </section>

              {/* who answers is only a question once there is more than one who could */}
              {/* folded, it must not leave the grid's gap behind: the margin takes the gap back and the padding restores it open; */}
              {/* self-start, or the grid stretches the folded box by the margin it took */}
              <Collapse open={chosen.length > 1} className="-mt-5 self-start">
                {chosen.length > 1 && (
                  <section className="grid gap-2 pt-5">
                    <h3 className={HEADING}>{t("members.whoAnswers")}</h3>
                    <ModeSegments value={mode} onChange={setMode} />
                    <p className="text-muted-foreground text-xs leading-relaxed">{t(`mode.${mode}.hint`)}</p>
                    <Collapse open={mode === "leader"}>
                      {mode === "leader" && (
                        <div className="flex flex-wrap items-center gap-1.5 pt-1">
                          <span className="text-muted-foreground mr-1 text-xs">{t("members.leader")}</span>
                          {chosen.map((b) => (
                            <button
                              key={b.id}
                              type="button"
                              onClick={() => setLeader(b.id)}
                              className={cn(
                                "inline-flex items-center gap-1.5 rounded-full py-0.5 pr-2.5 pl-0.5 text-xs transition-colors duration-120",
                                leaderBot?.id === b.id ? "bg-selected text-primary" : "bg-foreground/[0.045] hover:bg-accent",
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
                  </section>
                )}
              </Collapse>

              <Collapse open={Boolean(caps)} className="-mt-5 self-start">
                {caps && (
                  <div className="pt-5">
                    <div className="border-t pt-3">
                      <CapabilityNotes caps={caps} />
                    </div>
                  </div>
                )}
              </Collapse>
            </div>
          </div>
        </div>

        <DialogFooter className="shrink-0 items-center gap-3 px-6 py-4 sm:justify-between">
          <p className={cn("min-w-0 flex-1 truncate text-xs", error ? "text-destructive" : "text-muted-foreground")}>
            {error ?? status}
          </p>
          <div className="flex shrink-0 gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              {t("common.cancel")}
            </Button>
            <Button onClick={() => void create()} disabled={busy || !ready}>
              {busy && <Loader className="animate-spin" />}
              {group ? t("newConversation.createGroup") : t("newConversation.start")}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The conversation as its row in the list will show it: the faces of who is
 * in it, its name, and who they are. For a group the name is typed right
 * here, the way a group's profile renames it in place.
 */
function RoomCard({
  chosen,
  group,
  title,
  onTitle,
  onSubmit,
  line,
}: {
  chosen: Bot[];
  group: boolean;
  title: string;
  onTitle: (title: string) => void;
  onSubmit: () => void;
  line: (b: Bot) => string;
}) {
  const { t, list } = useI18n();
  const one = chosen[0];
  return (
    <div className="flex items-center gap-4">
      {!one ? (
        <span className="bg-muted text-muted-foreground flex size-14 shrink-0 items-center justify-center rounded-[23%]">
          <Users className="size-6" />
        </span>
      ) : group ? (
        <GroupAvatar bots={chosen} size="lg" />
      ) : (
        <BotAvatar bot={one} size="lg" />
      )}
      <div className="min-w-0 flex-1">
        {!one ? (
          <>
            <p className="text-muted-foreground text-base font-semibold">{t("newConversation.none")}</p>
            <p className="text-muted-foreground text-xs">{t("newConversation.noneHint")}</p>
          </>
        ) : group ? (
          <>
            <input
              value={title}
              onChange={(e) => onTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing) onSubmit();
              }}
              placeholder={t("newConversation.groupNamePlaceholder")}
              aria-label={t("newConversation.groupName")}
              spellCheck={false}
              className="placeholder:text-muted-foreground/70 hover:bg-accent focus-visible:bg-background focus-visible:ring-ring/40 -mx-1.5 block w-[calc(100%+0.75rem)] rounded-md px-1.5 py-0.5 text-base font-semibold transition-[background-color,box-shadow] outline-none focus-visible:ring-2"
            />
            <p className="text-muted-foreground truncate text-xs">{list(chosen.map((b) => b.name))}</p>
          </>
        ) : (
          <>
            <p className="truncate text-base font-semibold">{one.name}</p>
            <p className="text-muted-foreground truncate text-xs">{line(one)}</p>
          </>
        )}
      </div>
    </div>
  );
}

/** The three modes as one segmented control; what the chosen one means is said underneath, not in every segment. */
function ModeSegments({ value, onChange }: { value: Mode; onChange: (m: Mode) => void }) {
  const { t } = useI18n();
  return (
    <RadioGroupPrimitive.Root
      value={value}
      onValueChange={(v) => onChange(v as Mode)}
      className="bg-foreground/[0.045] grid grid-cols-3 gap-0.5 rounded-lg p-0.5"
    >
      {MODES.map((m) => (
        <RadioGroupPrimitive.Item
          key={m.id}
          value={m.id}
          className={cn(
            "text-muted-foreground flex h-8 items-center justify-center gap-1.5 rounded-[7px] text-[13px] font-medium transition-[background-color,color,box-shadow] duration-120 outline-none",
            "hover:text-foreground focus-visible:ring-ring/60 focus-visible:ring-2",
            "data-[state=checked]:bg-background data-[state=checked]:text-foreground dark:data-[state=checked]:bg-foreground/10",
          )}
        >
          <m.icon className="size-3.5" />
          {t(`mode.${m.id}`)}
        </RadioGroupPrimitive.Item>
      ))}
    </RadioGroupPrimitive.Root>
  );
}
