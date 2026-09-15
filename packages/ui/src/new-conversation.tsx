import { useEffect, useMemo, useState } from "react";
import { Check, Crown, Search } from "lucide-react";
import { api, type Bot, type Capabilities, type Conversation, type Mode } from "./api";
import { BotAvatar } from "./bot-avatar";
import { CapabilityNotes } from "./capabilities";
import { useExecutor } from "./executors";
import { useI18n } from "./i18n";
import { ModePicker } from "./members-panel";
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

const LAST_DIR = "roster.lastDir";

/** The last directory used is almost always the next one wanted. */
function lastDir(fallback: string): string {
  try {
    return localStorage.getItem(LAST_DIR) ?? fallback;
  } catch {
    return fallback;
  }
}

/** A 1:1 has nothing to choose, so it starts without the dialog. Core gives it a default title, which the first message replaces. */
export const startDirect = (bot: Bot, defaultDir: string) => api.createConversation({ repoPath: lastDir(defaultDir), botIds: [bot.id] });

export function NewConversation({
  open,
  onOpenChange,
  bots,
  capabilities,
  defaultDir,
  initialBotIds,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  bots: Bot[];
  capabilities: Record<string, Capabilities>;
  defaultDir: string;
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
  const [dir, setDir] = useState(defaultDir);
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
    setDir(lastDir(defaultDir));
    // only on opening; bots updating underneath must not reset a half-filled form
  }, [open]);

  const chosen = picked.flatMap((id) => bots.filter((b) => b.id === id));
  const group = chosen.length > 1;
  const leaderBot = chosen.find((b) => b.id === leader) ?? chosen[0];
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q
      ? bots.filter((b) => b.name.toLowerCase().includes(q) || (b.title ?? "").toLowerCase().includes(q))
      : bots;
  }, [bots, query]);

  const toggle = (id: string) =>
    setPicked((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const create = async () => {
    if (chosen.length === 0) return;
    setBusy(true);
    setError(null);
    const r = await api.createConversation({
      // left out, core names it in its own language, and the first message renames it
      ...(group && title.trim() ? { title: title.trim() } : {}),
      repoPath: dir.trim(),
      botIds: chosen.map((b) => b.id),
      ...(group ? { mode, ...(mode === "leader" && leaderBot ? { leaderBotId: leaderBot.id } : {}) } : {}),
    });
    setBusy(false);
    if (r.error || !r.conversation) {
      setError(r.error ?? t("common.createFailed"));
      return;
    }
    try {
      localStorage.setItem(LAST_DIR, dir.trim());
    } catch {
      // a directory that cannot be remembered still works this time
    }
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
                      "flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left",
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
                        "flex size-4 shrink-0 items-center justify-center rounded border",
                        on && "bg-primary border-primary text-primary-foreground",
                      )}
                    >
                      {on && <Check className="size-3" />}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {group && (
            <>
              <div className="grid gap-2">
                <Label htmlFor="group-title">{t("newConversation.groupName")}</Label>
                <Input
                  id="group-title"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder={t("newConversation.groupNamePlaceholder")}
                />
              </div>
              <div className="grid gap-2">
                <Label>{t("members.whoAnswers")}</Label>
                <ModePicker value={mode} onChange={setMode} compact />
                {mode === "leader" && (
                  <div className="flex flex-wrap items-center gap-1.5 pt-1">
                    <span className="text-muted-foreground mr-1 text-xs">{t("members.leader")}</span>
                    {chosen.map((b) => (
                      <button
                        key={b.id}
                        type="button"
                        onClick={() => setLeader(b.id)}
                        className={cn(
                          "inline-flex items-center gap-1.5 rounded-full border py-0.5 pr-2.5 pl-0.5 text-xs",
                          leaderBot?.id === b.id ? "border-foreground/40 bg-accent" : "hover:bg-accent/50",
                        )}
                      >
                        <BotAvatar bot={b} size="xs" />
                        {b.name}
                        {leaderBot?.id === b.id && <Crown className="size-3 text-amber-500" />}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}

          <div className="grid gap-2">
            <Label htmlFor="dir">{t("conversation.directory")}</Label>
            <Input
              id="dir"
              value={dir}
              spellCheck={false}
              onChange={(e) => setDir(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing) void create();
              }}
              className="font-mono text-xs"
              placeholder="/path/to/repo"
            />
            {error && <p className="text-destructive text-xs">{error}</p>}
          </div>

          {chosen.length === 1 && capabilities[chosen[0]!.executor_id] && (
            <div className="border-t pt-3">
              <CapabilityNotes caps={capabilities[chosen[0]!.executor_id]!} />
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button onClick={() => void create()} disabled={busy || chosen.length === 0 || !dir.trim()}>
            {group ? t("newConversation.createGroup") : t("newConversation.start")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
