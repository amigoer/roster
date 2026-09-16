import { useEffect, useRef, useState, type RefObject } from "react";
import {
  ArrowUp,
  AtSign,
  CircleAlert,
  Gauge,
  Layers,
  Paperclip,
  PencilLine,
  Plus,
  ShieldCheck,
  Shrink,
  Slash,
  Sparkles,
  Square,
  Users,
  X,
  type LucideIcon,
} from "lucide-react";
import {
  activeMembers,
  api,
  type Bot,
  type Conversation,
  type Member,
  type Message,
  type Quota,
  type Quote,
  type SessionInfo,
  type SessionOptions,
  type SlashCommand,
} from "./api";
import { fitImage, isImage, MAX_BYTES, MAX_FILES, PendingTray, type Pending } from "./attachments";
import { BotAvatar, LogoImage, logoOf, useLogos } from "./bot-avatar";
import { useExecutor } from "./executors";
import { useI18n } from "./i18n";
import { MentionTextarea } from "./mention-textarea";
import { ALL_ALIASES, recipients } from "./mentions";
import { PILL, SessionPickers, SessionUsage, type Picker, type PickerRequest } from "./session-controls";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

type Action = { kind: "action"; name: string; label: string; icon: LucideIcon; run: () => void };

type Suggestion = { kind: "member"; bot: Bot } | { kind: "all" } | Action | { kind: "command"; command: SlashCommand };

/** What is being typed right before the caret that a list can finish. */
type Trigger = { type: "@" | "/"; query: string; start: number };

/** Roster's own commands; a backend's command of the same name is left out, so one name does one thing. */
const OWN = new Set(["attach", "model", "effort", "mode", "compact", "context", "rename", "stop"]);

/** The send and stop buttons: round, so the one thing that fires stands apart from the pills beside it. */
const ROUND =
  "inline-flex size-8 shrink-0 items-center justify-center rounded-full outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50";

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
  sessions,
  sessionOptions,
  quota,
  messages,
  draft,
  setDraft,
  quote,
  setQuote,
  inputRef,
  handle,
  onRename,
}: {
  conv: Conversation;
  sessions: Record<string, SessionInfo>;
  sessionOptions: Record<string, SessionOptions>;
  quota: Record<string, Quota | null>;
  messages: Message[];
  draft: string;
  setDraft: (v: string) => void;
  /** the message being replied to, until it is sent or dropped */
  quote: Quote | null;
  setQuote: (q: Quote | null) => void;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  /** how files dropped anywhere on the conversation reach this composer */
  handle?: RefObject<ComposerHandle | null>;
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
  const to = group ? recipients(i18n, conv, draft, messages) : null;
  // the session the toolbar switches is the one the message goes to, so a group sending to one member reads like a direct conversation
  const solo = to ? (to.members.length === 1 ? to.members[0] : undefined) : members[0];
  const info = solo ? sessions[solo.id] : undefined;
  const choices = solo ? sessionOptions[solo.id] : undefined;
  // sent to several, the ring shows whichever is nearest its limit, the way it shows a plan's tightest window
  const percentOf = (m: Member) => sessions[m.id]?.context?.percent ?? -1;
  const gauge = solo ?? to?.members.filter((m) => percentOf(m) >= 0).sort((a, b) => percentOf(b) - percentOf(a))[0];

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
    const replyTo = quote;
    setSending(true);
    setError(null);
    setDraft("");
    setQuote(null);
    setPending((list) => list.filter((p) => !keys.has(p.key)));
    const r = await api
      .send(conv.id, text, batch.map((p) => p.ref!.id), replyTo ?? undefined)
      .catch((e: unknown) => ({ error: String(e) }));
    setSending(false);
    if (r.error) {
      setError(r.error);
      // nothing typed since: put it all back to try again
      if (!draftRef.current) setDraft(raw);
      if (replyTo) setQuote(replyTo);
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

  const focusInput = () => inputRef.current?.focus();
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
    ...(gauge && sessions[gauge.id]?.context ? [action("context", t("composer.action.context"), Layers, () => openPicker("context"))] : []),
    action("rename", t("composer.action.rename"), PencilLine, onRename),
    ...(running ? [action("stop", t("composer.action.stop"), Square, () => void api.abort(conv.id))] : []),
  ];
  // a group wraps what you type in its transcript, where no backend would see the slash
  const commands = group ? [] : (info?.commands ?? choices?.commands ?? []).filter((c) => !OWN.has(c.name));

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
    // only who is here: bringing someone in is the members panel's job
    return [
      ...members.filter((m) => hit(m.bot)).map((m): Suggestion => ({ kind: "member", bot: m.bot })),
      ...(members.length > 1 && (t("composer.everyone").includes(q) || ALL_ALIASES.some((a) => a.startsWith(q)))
        ? [{ kind: "all" } as Suggestion]
        : []),
    ];
  })();
  const index = menu ? Math.min(menu.index, suggestions.length - 1) : 0;

  /** Enter runs what it can run as it is; Tab only fills it in. */
  const pick = (s: Suggestion, go: boolean) => {
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
  // with nothing new to send, the button stops the turn instead
  const stoppable = running && !draft.trim() && ready.length === 0;

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
            onPick={(s) => pick(s, true)}
            onHover={(i) => setMenu({ ...menu, index: i })}
          />
        )}
        {/* a container, so the toolbar can drop labels before it runs out of room */}
        <div className="bg-background has-[textarea:focus]:border-ring/50 @container rounded-2xl border shadow-[0_4px_20px_-8px_rgb(0_0_0/0.12)] transition-colors">
          {quote && (
            <div className="flex items-start gap-2.5 border-b px-3.5 py-2">
              <span className="bg-border mt-0.5 w-0.5 shrink-0 self-stretch rounded-full" />
              <div className="min-w-0 flex-1">
                <p className="text-muted-foreground text-[11px]">
                  {t("composer.replyingTo", { name: quote.name ?? t("members.you") })}
                </p>
                {/* one line: the whole passage is already above, in the message being answered */}
                <p className="text-muted-foreground/90 truncate text-xs">{quote.text.replace(/\s+/g, " ").trim()}</p>
              </div>
              <button
                type="button"
                title={t("composer.cancelReply")}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  setQuote(null);
                  inputRef.current?.focus();
                }}
                className="text-muted-foreground hover:text-foreground rounded p-0.5"
              >
                <X className="size-3.5" />
              </button>
            </div>
          )}
          {pending.length > 0 && <PendingTray items={pending} onRemove={remove} />}
          <MentionTextarea
            // the names the transcript marks, so a mention looks the same before it is sent as after
            names={conv.members.map((m) => m.bot.name)}
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
                  pick(suggestions[index]!, e.key === "Enter");
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
            className="placeholder:text-muted-foreground block max-h-60 min-h-13 w-full resize-none bg-transparent px-4 pt-3 pb-1.5 text-message leading-relaxed outline-none field-sizing-content"
          />
          {/* only while there is something to say: a failure, or how the command just typed is used */}
          {(error || typed?.hint) && (
            <div className={cn("flex min-w-0 items-center gap-1.5 px-4 pb-1 text-xs", error ? "text-destructive" : "text-muted-foreground")}>
              {error ? (
                <>
                  <CircleAlert className="size-3.5 shrink-0" />
                  <span className="min-w-0 flex-1 truncate" title={error}>
                    {error}
                  </span>
                  <button
                    type="button"
                    aria-label={t("composer.dismiss")}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => setError(null)}
                    className="hover:bg-destructive/10 -mr-1 shrink-0 rounded p-0.5"
                  >
                    <X className="size-3.5" />
                  </button>
                </>
              ) : (
                typed && (
                  <span className="min-w-0 truncate">
                    <span className="text-foreground/80 font-mono">
                      /{typed.name} {typed.hint}
                    </span>
                    {typed.description && ` · ${typed.description}`}
                  </span>
                )
              )}
            </div>
          )}
          <div className="flex items-center gap-2 px-2 pb-2">
            <div className="flex min-w-0 flex-1 items-center gap-0.5">
              <AddMenu group={group} onAttach={() => fileInput.current?.click()} onInsert={insert} onClosed={focusInput} />
              {to && (
                <Recipients
                  members={to.members}
                  label={to.label}
                  hint={`${t(`mode.${conv.mode}`)} · ${t(`mode.${conv.mode}.hint`)}`}
                  onClick={() => insert("@")}
                />
              )}
              <SessionPickers
                // a level shown as picked before the session reports it belongs to that member alone
                key={solo?.id}
                conversationId={conv.id}
                member={solo}
                info={info}
                choices={choices}
                request={picker}
                onError={setError}
                onClosed={focusInput}
              />
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <SessionUsage
                conv={conv}
                member={gauge}
                info={gauge && sessions[gauge.id]}
                choices={gauge && sessionOptions[gauge.id]}
                quota={quota}
                request={picker}
                onError={setError}
              />
              {stoppable ? (
                <Tooltip delayDuration={700}>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      aria-label={t("composer.action.stop")}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => void api.abort(conv.id)}
                      className={cn(ROUND, "bg-primary text-primary-foreground hover:bg-primary/90")}
                    >
                      <Square className="size-3 fill-current" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="top" sideOffset={6}>
                    {t("composer.action.stop")}
                  </TooltipContent>
                </Tooltip>
              ) : (
                <Tooltip delayDuration={700}>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      aria-label={uploading ? t("composer.uploading") : t("composer.send")}
                      disabled={!canSend}
                      // mousedown, so the caret stays in the textarea for the next message
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => void submit(draft)}
                      className={cn(
                        ROUND,
                        "bg-primary text-primary-foreground hover:bg-primary/90",
                        "disabled:bg-muted-foreground/30 disabled:text-background disabled:pointer-events-none",
                      )}
                    >
                      <ArrowUp className="size-4" strokeWidth={2.5} />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="top" sideOffset={6}>
                    {t("composer.sendHint")}
                  </TooltipContent>
                </Tooltip>
              )}
            </div>
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
    </footer>
  );
}

/** What can go into a message besides text, behind one button; each also has a key of its own. */
function AddMenu({
  group,
  onAttach,
  onInsert,
  onClosed,
}: {
  group: boolean;
  onAttach: () => void;
  onInsert: (trigger: "@" | "/") => void;
  onClosed: () => void;
}) {
  const { t } = useI18n();
  const rows: Array<{ icon: LucideIcon; label: string; key?: string; run: () => void }> = [
    { icon: Paperclip, label: t("composer.action.attach"), run: onAttach },
    // a direct conversation has no one else to @
    ...(group ? [{ icon: AtSign, label: t("composer.mention"), key: "@", run: () => onInsert("@") }] : []),
    { icon: Slash, label: t("composer.commands"), key: "/", run: () => onInsert("/") },
  ];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className={cn(PILL, "w-8 justify-center px-0")} aria-label={t("composer.add")}>
        <Plus className="size-[18px]" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="top"
        align="start"
        sideOffset={8}
        collisionPadding={12}
        className="min-w-52 rounded-xl p-1.5"
        onCloseAutoFocus={(e) => {
          e.preventDefault();
          onClosed();
        }}
      >
        {rows.map((r) => (
          <DropdownMenuItem key={r.label} onSelect={r.run} className="gap-2.5 rounded-lg px-2.5 py-2">
            <r.icon />
            <span className="flex-1">{r.label}</span>
            {r.key && (
              <kbd className="bg-muted text-muted-foreground min-w-5 rounded-md px-1 py-px text-center font-mono text-xs">{r.key}</kbd>
            )}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Who a group message goes to if sent now; clicking starts an @ to pick someone else. */
function Recipients({ members, label, hint, onClick }: { members: Member[]; label: string; hint: string; onClick: () => void }) {
  const { t } = useI18n();
  const logos = useLogos();
  return (
    <Tooltip delayDuration={700}>
      <TooltipTrigger asChild>
        <button
          type="button"
          // who it goes to keeps its name when the toolbar runs short; the model beside it gives way instead
          className={cn(PILL, "max-w-60 shrink-0")}
          // mousedown, so the @ lands where the caret was
          onMouseDown={(e) => e.preventDefault()}
          onClick={onClick}
        >
          <span className="shrink-0">{t("composer.to")}</span>
          {members.length > 0 && (
            <span className="flex shrink-0 -space-x-1">
              {members.slice(0, 3).map((m) => (
                <LogoImage key={m.id} logo={logoOf(m.bot, logos)} className="ring-background size-4 ring-2" />
              ))}
            </span>
          )}
          <span className="text-foreground truncate">{label}</span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={6} className="max-w-72">
        {hint}
      </TooltipContent>
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
                </>
              )}
            </button>
          </div>
        );
      })}
    </div>
  );
}
