import { useEffect, useRef, useState, type RefObject } from "react";
import {
  AtSign,
  Gauge,
  Layers,
  Paperclip,
  PencilLine,
  SendHorizonal,
  ShieldCheck,
  Shrink,
  Slash,
  Sparkles,
  Square,
  UserPlus,
  Users,
  type LucideIcon,
} from "lucide-react";
import {
  activeMembers,
  api,
  type Bot,
  type Conversation,
  type Message,
  type Quota,
  type SessionInfo,
  type SessionOptions,
  type SlashCommand,
} from "./api";
import { fitImage, isImage, MAX_BYTES, MAX_FILES, PendingTray, type Pending } from "./attachments";
import { BotAvatar } from "./bot-avatar";
import { useExecutor } from "./executors";
import { useI18n } from "./i18n";
import { ALL_ALIASES, recipientLabel } from "./mentions";
import { SessionBar, type Picker, type PickerRequest } from "./session-bar";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

type Action = { kind: "action"; name: string; label: string; icon: LucideIcon; run: () => void };

type Suggestion =
  | { kind: "member"; bot: Bot }
  | { kind: "all" }
  | { kind: "invite"; bot: Bot }
  | Action
  | { kind: "command"; command: SlashCommand };

/** What is being typed right before the caret that a list can finish. */
type Trigger = { type: "@" | "/"; query: string; start: number };

/** Roster's own commands; a backend's command of the same name is left out, so one name does one thing. */
const OWN = new Set(["attach", "model", "effort", "mode", "compact", "context", "rename", "stop"]);

/** The @ being typed right before the caret, if any. */
function mentionAt(value: string, caret: number): Trigger | null {
  const m = /(^|[^A-Za-z0-9_])@([^\s@]{0,24})$/.exec(value.slice(0, caret));
  return m ? { type: "@", query: m[2]!, start: caret - m[2]!.length - 1 } : null;
}

/** A command only counts at the very start of a message, which is where a backend looks for one. */
function slashAt(value: string, caret: number): Trigger | null {
  const m = /^\/([^\s/]{0,40})$/.exec(value.slice(0, caret));
  return m ? { type: "/", query: m[1]!, start: 0 } : null;
}

/** A pasted screenshot arrives as image.png every time; the time in its name tells them apart. */
function named(file: File): File {
  if (file.name && !/^image\.(png|jpe?g|gif|webp)$/i.test(file.name)) return file;
  const d = new Date();
  const stamp = [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, "0")).join("");
  const ext = (file.type.split("/")[1] ?? "png").replace("jpeg", "jpg");
  return new File([file], `pasted-${stamp}.${ext}`, { type: file.type });
}

export interface ComposerHandle {
  addFiles(files: File[]): void;
}

export function Composer({
  conv,
  bots,
  sessions,
  sessionOptions,
  quota,
  messages,
  draft,
  setDraft,
  inputRef,
  handle,
  onContext,
  onRename,
}: {
  conv: Conversation;
  bots: Bot[];
  sessions: Record<string, SessionInfo>;
  sessionOptions: Record<string, SessionOptions>;
  quota: Record<string, Quota | null>;
  messages: Message[];
  draft: string;
  setDraft: (v: string) => void;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  /** how files dropped anywhere on the conversation reach this composer */
  handle?: RefObject<ComposerHandle | null>;
  onContext: (memberId: string) => void;
  onRename: () => void;
}) {
  const [menu, setMenu] = useState<(Trigger & { index: number }) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending[]>([]);
  const [picker, setPicker] = useState<PickerRequest | null>(null);
  const [sending, setSending] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  const draftRef = useRef(draft);
  draftRef.current = draft;
  /** removed before its upload finished: the file that lands anyway is thrown away */
  const dropped = useRef(new Set<string>());
  const executor = useExecutor();
  const i18n = useI18n();
  const { t } = i18n;

  const members = activeMembers(conv);
  const group = conv.shape === "group";
  const running = conv.run_state === "running";
  const solo = group ? undefined : members[0];
  const info = solo ? sessions[solo.id] : undefined;
  const choices = solo ? sessionOptions[solo.id] : undefined;

  // an upload belongs to the conversation it went to; one never sent goes when the composer does
  useEffect(
    () => () => {
      for (const p of pendingRef.current) {
        if (p.preview) URL.revokeObjectURL(p.preview);
        if (p.ref) void api.removeAttachment(conv.id, p.ref.id);
        else dropped.current.add(p.key);
      }
    },
    [conv.id],
  );

  const update = (key: string, patch: Partial<Pending>) =>
    setPending((list) => list.map((p) => (p.key === key ? { ...p, ...patch } : p)));

  const addFiles = (files: File[]) => {
    if (files.length === 0) return;
    const room = MAX_FILES - pendingRef.current.length;
    setError(
      files.length <= room
        ? null
        : room > 0
          ? t("composer.tooManyFilesDropped", { count: MAX_FILES })
          : t("composer.tooManyFiles", { count: MAX_FILES }),
    );
    for (const raw of files.slice(0, Math.max(0, room))) {
      const file = named(raw);
      const key = crypto.randomUUID();
      const item: Pending = {
        key,
        name: file.name,
        mime: file.type,
        size: file.size,
        progress: 0,
        ...(isImage(file.type) ? { preview: URL.createObjectURL(file) } : {}),
        ...(file.size > MAX_BYTES ? { error: t("composer.fileTooLarge", { size: MAX_BYTES / 1024 / 1024 }) } : {}),
      };
      setPending((list) => [...list, item]);
      if (item.error) continue;
      void (async () => {
        const fitted = await fitImage(file);
        if (fitted !== file) update(key, { name: fitted.name, size: fitted.size, mime: fitted.type });
        const r = await api.upload(conv.id, fitted, fitted.name, (progress) => update(key, { progress }));
        if (dropped.current.has(key)) {
          if (r.attachment) void api.removeAttachment(conv.id, r.attachment.id);
          return;
        }
        update(key, r.attachment ? { ref: r.attachment, mime: r.attachment.mime, progress: 1 } : { error: r.error ?? t("composer.uploadFailed") });
      })();
    }
  };

  useEffect(() => {
    if (!handle) return;
    handle.current = { addFiles };
    return () => {
      handle.current = null;
    };
  });

  const remove = (key: string) => {
    const p = pendingRef.current.find((x) => x.key === key);
    if (!p) return;
    if (p.preview) URL.revokeObjectURL(p.preview);
    if (p.ref) void api.removeAttachment(conv.id, p.ref.id);
    else dropped.current.add(key);
    setPending((list) => list.filter((x) => x.key !== key));
    inputRef.current?.focus();
  };

  const uploading = pending.some((p) => !p.ref && !p.error);
  const ready = pending.filter((p) => p.ref);
  const canSend = !sending && !uploading && (draft.trim().length > 0 || ready.length > 0);

  const submit = async (raw: string) => {
    const text = raw.trim();
    if (uploading) return setError(t("composer.stillUploading"));
    const batch = pendingRef.current.filter((p) => p.ref);
    if (!text && batch.length === 0) return;
    const keys = new Set(batch.map((p) => p.key));
    setSending(true);
    setError(null);
    setDraft("");
    setPending((list) => list.filter((p) => !keys.has(p.key)));
    const r = await api.send(conv.id, text, batch.map((p) => p.ref!.id)).catch((e: unknown) => ({ error: String(e) }));
    setSending(false);
    if (r.error) {
      setError(r.error);
      // nothing typed since: put it all back to try again
      if (!draftRef.current) setDraft(raw);
      setPending((list) => [...batch, ...list]);
      return;
    }
    for (const p of batch) if (p.preview) URL.revokeObjectURL(p.preview);
  };

  const detect = (el: HTMLTextAreaElement) => {
    const caret = el.selectionStart ?? el.value.length;
    const at = slashAt(el.value, caret) ?? mentionAt(el.value, caret);
    setMenu((prev) => (at ? { ...at, index: prev?.type === at.type && prev.query === at.query ? prev.index : 0 } : null));
  };

  /** Sets the text and puts the caret where the edit ended, then looks again for something to finish. */
  const place = (value: string, caret: number) => {
    setDraft(value);
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(caret, caret);
      detect(el);
    });
  };

  const openPicker = (p: Picker) => setPicker((r) => ({ picker: p, nonce: (r?.nonce ?? 0) + 1 }));
  const run = async (call: () => Promise<{ error?: string }>) => {
    const r = await call().catch((e: unknown) => ({ error: String(e) }));
    setError(r.error ?? null);
  };
  const action = (name: string, label: string, icon: LucideIcon, fn: () => void): Action => ({ kind: "action", name, label, icon, run: fn });

  const actions: Action[] = [
    action("attach", t("composer.action.attach"), Paperclip, () => fileInput.current?.click()),
    ...(solo && info?.model && choices?.models.length ? [action("model", t("composer.action.model"), Sparkles, () => openPicker("model"))] : []),
    ...(solo && info?.effort && choices?.efforts.length ? [action("effort", t("composer.action.effort"), Gauge, () => openPicker("effort"))] : []),
    ...(solo && info?.mode && choices?.modes.length ? [action("mode", t("composer.action.mode"), ShieldCheck, () => openPicker("mode"))] : []),
    ...(solo && choices?.compact && !running
      ? [action("compact", t("composer.action.compact"), Shrink, () => void run(() => api.compact(conv.id, solo.id)))]
      : []),
    ...(solo && info?.context ? [action("context", t("composer.action.context"), Layers, () => onContext(solo.id))] : []),
    action("rename", t("composer.action.rename"), PencilLine, onRename),
    ...(running ? [action("stop", t("composer.action.stop"), Square, () => void api.abort(conv.id))] : []),
  ];
  // a group wraps what you type in its transcript, where no backend would see the slash
  const commands = solo ? (info?.commands ?? choices?.commands ?? []).filter((c) => !OWN.has(c.name)) : [];

  const suggestions: Suggestion[] = (() => {
    if (!menu) return [];
    const q = menu.query.toLowerCase();
    if (menu.type === "/") {
      const hit = (...fields: Array<string | undefined>) => fields.some((f) => f?.toLowerCase().includes(q));
      const first = (name: string) => (name.toLowerCase().startsWith(q) ? 0 : 1);
      return [
        ...actions.filter((a) => hit(a.name, a.label)).sort((a, b) => first(a.name) - first(b.name)),
        ...commands
          .filter((c) => hit(c.name, c.description))
          .sort((a, b) => first(a.name) - first(b.name))
          .map((command) => ({ kind: "command" as const, command })),
      ];
    }
    const hit = (b: Bot) => b.name.toLowerCase().includes(q) || (b.title ?? "").toLowerCase().includes(q);
    const inGroup = new Set(members.map((m) => m.bot.id));
    return [
      ...members.filter((m) => hit(m.bot)).map((m): Suggestion => ({ kind: "member", bot: m.bot })),
      ...(members.length > 1 && (t("composer.everyone").includes(q) || ALL_ALIASES.some((a) => a.startsWith(q)))
        ? [{ kind: "all" } as Suggestion]
        : []),
      // Grok-style: @ someone who is not here yet and they join
      ...bots.filter((b) => !inGroup.has(b.id) && hit(b)).map((b): Suggestion => ({ kind: "invite", bot: b })),
    ];
  })();
  const index = menu ? Math.min(menu.index, suggestions.length - 1) : 0;

  /** Enter runs what it can run as it is; Tab only fills it in. */
  const pick = async (s: Suggestion, go: boolean) => {
    if (!menu) return;
    const caret = inputRef.current?.selectionStart ?? draft.length;
    const rest = draft.slice(caret).replace(/^\s+/, "");
    setMenu(null);
    if (s.kind === "action") {
      // the typed "/…" was only the way to the action; focus stays with whatever the action opens
      setDraft(rest);
      s.run();
      return;
    }
    if (s.kind === "command") {
      const text = `/${s.command.name}`;
      if (go && !s.command.hint && !rest) return void submit(text);
      return place(`${text} ${rest}`, text.length + 1);
    }
    const name = s.kind === "all" ? t("composer.everyone") : s.bot.name;
    place(`${draft.slice(0, menu.start)}@${name} ${draft.slice(caret)}`, menu.start + name.length + 2);
    if (s.kind === "invite") {
      const r = await api.addMember(conv.id, s.bot.id);
      setError(r.error ?? null);
    }
  };

  const insert = (trigger: "@" | "/") => {
    const el = inputRef.current;
    if (trigger === "/") return place(draft.startsWith("/") ? draft : `/${draft}`, 1);
    const start = el?.selectionStart ?? draft.length;
    const end = el?.selectionEnd ?? start;
    // an @ glued to a word reads as an email, not a mention
    const pad = start > 0 && !/\s/.test(draft[start - 1]!) ? " " : "";
    place(`${draft.slice(0, start)}${pad}@${draft.slice(end)}`, start + pad.length + 1);
  };

  const typed = (() => {
    const m = /^\/(\S+) $/.exec(draft);
    return m ? commands.find((c) => c.name === m[1]) : undefined;
  })();
  const hint = typed?.hint
    ? `/${typed.name} ${typed.hint}${typed.description ? ` · ${typed.description}` : ""}`
    : group
      ? t("composer.hintGroup", { recipients: recipientLabel(i18n, conv, draft, messages) })
      : t("composer.hintDirect");

  return (
    <footer className="shrink-0 px-5 pt-2.5 pb-4">
      <div className="relative">
        {menu && suggestions.length > 0 && (
          <SuggestionList
            items={suggestions}
            index={index}
            wide={menu.type === "/"}
            commandsLabel={solo ? t("composer.commandsOf", { name: executor(solo.executor_id).label }) : t("composer.commands")}
            memberCount={members.length}
            onPick={(s) => void pick(s, true)}
            onHover={(i) => setMenu({ ...menu, index: i })}
          />
        )}
        <div className="bg-background focus-within:border-ring/60 rounded-2xl border shadow-[0_4px_20px_-8px_rgb(0_0_0/0.12)] transition-colors">
          {pending.length > 0 && <PendingTray items={pending} onRemove={remove} />}
          <textarea
            ref={inputRef}
            value={draft}
            rows={1}
            onChange={(e) => {
              setDraft(e.target.value);
              detect(e.target);
            }}
            onSelect={(e) => detect(e.currentTarget)}
            onBlur={() => setMenu(null)}
            onPaste={(e) => {
              const files = [...e.clipboardData.files];
              if (files.length === 0) return;
              // a copied spreadsheet cell brings a picture of itself along; the text is what was meant
              const generic = files.every((f) => /^image\.(png|jpe?g|gif|webp|tiff?)$/i.test(f.name));
              if (generic && e.clipboardData.getData("text/plain")) return;
              e.preventDefault();
              addFiles(files);
            }}
            onKeyDown={(e) => {
              if (menu && suggestions.length > 0 && !e.nativeEvent.isComposing) {
                const step = e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : 0;
                if (step !== 0) {
                  e.preventDefault();
                  setMenu({ ...menu, index: (index + step + suggestions.length) % suggestions.length });
                  return;
                }
                if (e.key === "Enter" || e.key === "Tab") {
                  e.preventDefault();
                  void pick(suggestions[index]!, e.key === "Enter");
                  return;
                }
                if (e.key === "Escape") {
                  e.preventDefault();
                  setMenu(null);
                  return;
                }
              }
              // Enter also confirms an IME candidate; that must not send half-typed Chinese
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                if (canSend) void submit(draft);
                else if (uploading) setError(t("composer.stillUploading"));
              }
            }}
            placeholder={
              running
                ? t("composer.placeholderRunning")
                : group
                  ? t("composer.placeholderGroup")
                  : t("composer.placeholderDirect", { name: members[0]?.bot.name ?? "" })
            }
            className="placeholder:text-muted-foreground block max-h-60 min-h-12 w-full resize-none bg-transparent px-3.5 pt-3 pb-1 text-message leading-relaxed outline-none field-sizing-content"
          />
          <div className="flex items-center gap-0.5 px-2 pb-2">
            <Tool label={t("composer.action.attach")} onClick={() => fileInput.current?.click()}>
              <Paperclip />
            </Tool>
            <Tool label={group ? t("composer.mention") : t("composer.mentionInvite")} onClick={() => insert("@")}>
              <AtSign />
            </Tool>
            <Tool label={t("composer.commands")} onClick={() => insert("/")}>
              <Slash />
            </Tool>
            <span className={cn("min-w-0 flex-1 truncate px-1.5 text-[11px]", error ? "text-destructive" : "text-muted-foreground")}>
              {error ?? hint}
            </span>
            {running && !draft.trim() && ready.length === 0 ? (
              <Button size="icon" variant="secondary" className="size-8 rounded-lg" title={t("composer.action.stop")} onClick={() => void api.abort(conv.id)}>
                <Square className="size-3 fill-current" />
              </Button>
            ) : (
              <Button
                size="icon"
                className="size-8 rounded-lg"
                title={uploading ? t("composer.uploading") : t("composer.send")}
                onClick={() => void submit(draft)}
                disabled={!canSend}
              >
                <SendHorizonal className="size-4" />
              </Button>
            )}
          </div>
        </div>
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            addFiles([...(e.target.files ?? [])]);
            // the same file picked again is a change too
            e.target.value = "";
            inputRef.current?.focus();
          }}
        />
      </div>
      <SessionBar conv={conv} sessions={sessions} options={sessionOptions} quota={quota} onContext={onContext} request={picker} />
    </footer>
  );
}

function Tool({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={label}
          className="text-muted-foreground hover:text-foreground size-8 rounded-lg [&_svg]:size-4"
          // mousedown, so the textarea keeps its caret for what the button inserts
          onMouseDown={(e) => e.preventDefault()}
          onClick={onClick}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top">{label}</TooltipContent>
    </Tooltip>
  );
}

const keyOf = (s: Suggestion) =>
  s.kind === "all" ? "all" : s.kind === "action" ? `action-${s.name}` : s.kind === "command" ? `command-${s.command.name}` : `${s.kind}-${s.bot.id}`;

function SuggestionList({
  items,
  index,
  wide,
  commandsLabel,
  memberCount,
  onPick,
  onHover,
}: {
  items: Suggestion[];
  index: number;
  wide: boolean;
  commandsLabel: string;
  memberCount: number;
  onPick: (s: Suggestion) => void;
  onHover: (i: number) => void;
}) {
  const list = useRef<HTMLDivElement>(null);
  const { t } = useI18n();
  useEffect(() => {
    list.current?.querySelector(`[data-index="${index}"]`)?.scrollIntoView({ block: "nearest" });
  }, [index]);

  const headerOf = (s: Suggestion, prev: Suggestion | undefined) => {
    if (s.kind === prev?.kind) return null;
    if (s.kind === "invite") return t("composer.invite");
    if (s.kind === "action") return t("composer.conversation");
    if (s.kind === "command") return commandsLabel;
    return null;
  };

  return (
    <div
      ref={list}
      className={cn(
        "bg-popover text-popover-foreground absolute bottom-full left-0 z-30 mb-2 max-h-80 overflow-y-auto rounded-xl border p-1 shadow-lg",
        wide ? "w-[26rem] max-w-full" : "w-72",
      )}
    >
      {items.map((s, i) => {
        const header = headerOf(s, items[i - 1]);
        return (
          <div key={keyOf(s)}>
            {header && <div className="text-muted-foreground px-2 pt-2 pb-1 text-[11px]">{header}</div>}
            <button
              type="button"
              data-index={i}
              // mousedown, so the textarea keeps focus and the caret
              onMouseDown={(e) => {
                e.preventDefault();
                onPick(s);
              }}
              onMouseEnter={() => onHover(i)}
              className={cn("flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm", i === index && "bg-accent")}
            >
              {s.kind === "action" || s.kind === "command" ? (
                <>
                  <span className="bg-muted text-muted-foreground inline-flex size-6 shrink-0 items-center justify-center rounded-md">
                    {s.kind === "action" ? <s.icon className="size-3.5" /> : <Slash className="size-3.5" />}
                  </span>
                  <span className="shrink-0 font-mono text-[13px]">/{s.kind === "action" ? s.name : s.command.name}</span>
                  {s.kind === "command" && s.command.hint && (
                    <span className="text-muted-foreground shrink-0 font-mono text-xs">{s.command.hint}</span>
                  )}
                  <span className="text-muted-foreground min-w-0 flex-1 truncate text-xs">
                    {s.kind === "action" ? s.label : s.command.description}
                  </span>
                </>
              ) : (
                <>
                  {s.kind === "all" ? (
                    <span className="bg-muted inline-flex size-5 items-center justify-center rounded-[30%]">
                      <Users className="size-3" />
                    </span>
                  ) : (
                    <BotAvatar bot={s.bot} size="xs" />
                  )}
                  <span className="font-medium">{s.kind === "all" ? t("composer.everyone") : s.bot.name}</span>
                  <span className="text-muted-foreground min-w-0 flex-1 truncate text-xs">
                    {/* a head count here would read as the member count, which now counts you too */}
                    {s.kind === "all" ? t("composer.everyoneReplies", { count: memberCount }) : s.bot.title}
                  </span>
                  {s.kind === "invite" && <UserPlus className="text-muted-foreground size-3.5" />}
                </>
              )}
            </button>
          </div>
        );
      })}
    </div>
  );
}
