import { useContext, useState } from "react";
import {
  Bird,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  Loader,
  Quote,
  ShieldAlert,
  User,
  X,
} from "lucide-react";
import { api, type AttachmentRef, type Member, type Message } from "./api";
import { MessageAttachments } from "./attachments";
import { BotAvatar } from "./bot-avatar";
import { useI18n, type I18n } from "./i18n";
import { Markdown, MentionChip, MentionNames } from "./markdown";
import { segments } from "./mentions";
import { ProviderIcon, type Provider } from "./provider-icon";
import { CopyIcon, useCopy } from "./copy";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

const FACES = { app: Bird, bot: Bot, human: User } as const;

export function Who({ kind, provider }: { kind: keyof typeof FACES; provider?: Provider }) {
  const Icon = FACES[kind];
  return (
    <Avatar className="size-8 rounded-md">
      <AvatarFallback className="text-muted-foreground rounded-md">
        {/* the model's brand is what a person recognises at a glance */}
        {kind === "bot" && provider && provider !== "unknown" ? (
          <ProviderIcon provider={provider} className="size-4" />
        ) : (
          <Icon className="size-4" />
        )}
      </AvatarFallback>
    </Avatar>
  );
}

function when({ t, clock, day }: Pick<I18n, "t" | "clock" | "day">, ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return t("time.justNow");
  if (s < 3600) return t("time.minutesAgo", { count: Math.floor(s / 60) });
  return s < 86400 ? clock(ts) : `${day(ts)} ${clock(ts)}`;
}

/**
 * Quoting a whole eighty-line answer is rarely what is wanted; if the reader has
 * highlighted a passage inside this message, that passage is the quote.
 */
function selectionWithin(el: HTMLElement): string | null {
  const sel = window.getSelection();
  const text = sel?.toString().trim();
  if (!sel || !text || sel.rangeCount === 0) return null;
  const msg = el.closest(".group\\/msg");
  return msg && msg.contains(sel.getRangeAt(0).commonAncestorContainer) ? text : null;
}

/** Hidden until hover: a row of controls under every message is visual noise. */
function Actions({
  text,
  at,
  align,
  onQuote,
}: {
  text: string;
  at: number;
  align: "start" | "end";
  onQuote?: (t: string) => void;
}) {
  const { copied, copy } = useCopy();
  const i18n = useI18n();
  const { t } = i18n;
  return (
    <div
      className={cn(
        "text-muted-foreground flex items-center gap-0.5 opacity-0 transition-opacity group-hover/msg:opacity-100 focus-within:opacity-100",
        // cancels the buttons' padding so the icons line up with the message edge
        align === "end" ? "-mr-1 flex-row-reverse" : "-ml-1",
      )}
    >
      {text && (
        <button
          onClick={() => void copy(text)}
          title={t("common.copy")}
          className="hover:bg-accent hover:text-foreground rounded p-1"
        >
          <CopyIcon copied={copied} />
        </button>
      )}
      {onQuote && text && (
        <button
          onClick={(e) => onQuote(selectionWithin(e.currentTarget) ?? text)}
          title={t("cards.quote")}
          className="hover:bg-accent hover:text-foreground rounded p-1"
        >
          <Quote className="size-3.5" />
        </button>
      )}
      <span className="px-1 text-[11px]">{when(i18n, at)}</span>
    </div>
  );
}

/** A group chat says who is speaking, the way a person's name sits above their bubble. */
function Byline({ author }: { author: Member }) {
  const { t } = useI18n();
  return (
    <div className="flex items-baseline gap-1.5 px-0.5">
      <span className="text-xs font-medium">{author.bot.name}</span>
      {author.bot.title && <span className="text-muted-foreground truncate text-[11px]">{author.bot.title}</span>}
      {author.left_at !== null && <span className="text-muted-foreground text-[11px]">{t("cards.left")}</span>}
    </div>
  );
}

function Bubble({
  who,
  author,
  group,
  raw,
  at,
  onQuote,
  attachments,
  children,
}: {
  who: "human" | "bot";
  author?: Member;
  group: boolean;
  /** the source text, so copy yields Markdown rather than rendered HTML */
  raw: string;
  at: number;
  onQuote?: (t: string) => void;
  /** above the text, the way a chat app sends a picture with a caption */
  attachments?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("group/msg flex gap-3", who === "human" && "flex-row-reverse")}>
      {group && (who === "bot" && author ? <BotAvatar bot={author.bot} /> : <Who kind={who} />)}
      <div className={cn("flex max-w-[min(680px,78%)] min-w-0 flex-col gap-1", who === "human" && "items-end")}>
        {group && who === "bot" && author && <Byline author={author} />}
        {attachments}
        {/* files alone are a whole message; an empty bubble under them would read as a blank reply */}
        {raw && (
          <div
            className={cn(
              // a bot's answer reads as a page rather than a box; only what the human said is a bubble
              who === "human" &&
                "bg-muted rounded-xl px-3.5 py-2.5 text-message leading-relaxed break-words whitespace-pre-wrap",
            )}
          >
            {children}
          </div>
        )}
        <Actions text={raw} at={at} align={who === "human" ? "end" : "start"} onQuote={onQuote} />
      </div>
    </div>
  );
}

/** What the human typed stays verbatim; only the addresses in it are marked. */
function HumanText({ text }: { text: string }) {
  const names = useContext(MentionNames);
  return (
    <>
      {segments(text, names).map((s, i) =>
        s.mention ? (
          <MentionChip key={i}>{s.text}</MentionChip>
        ) : (
          s.text
        ),
      )}
    </>
  );
}

/** In a group the card has to say whose tool calls these were. */
function CardAuthor({ author }: { author?: Member }) {
  if (!author) return null;
  return (
    <>
      <BotAvatar bot={author.bot} size="xs" />
      <span className="text-foreground text-sm font-medium">{author.bot.name}</span>
    </>
  );
}

/** Tool calls never get their own bubbles; they fold into one card per turn. */
function StepsCard({
  body,
  author,
  indent,
}: {
  body: { steps: Array<{ id: string; name: string; effect: string; ok?: boolean }> };
  author?: Member;
  indent: boolean;
}) {
  const [open, setOpen] = useState(false);
  const { t } = useI18n();
  const { steps } = body;
  if (steps.length === 0) return null;
  return (
    <div className={cn("max-w-[min(680px,78%)]", indent && "ml-12")}>
      <button
        onClick={() => setOpen(!open)}
        className="text-muted-foreground hover:text-foreground flex items-center gap-1.5 py-0.5 text-left text-sm transition-colors"
      >
        {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        <CardAuthor author={author} />
        <span>{t("cards.steps", { count: steps.length })}</span>
        <span className="flex items-center gap-0.5">
          {steps.map((s) =>
            s.ok === undefined ? (
              <Loader key={s.id} className="text-muted-foreground/50 size-3 animate-spin" />
            ) : s.ok ? (
              <Check key={s.id} className="text-muted-foreground size-3" />
            ) : (
              <X key={s.id} className="text-destructive size-3" />
            ),
          )}
        </span>
      </button>
      {open && (
        <div className="space-y-1 py-1 pl-5">
          {steps.map((s) => (
            <div key={s.id} className="flex items-center gap-2">
              <span className="font-mono text-xs">{s.name}</span>
              <Badge variant="secondary" className="px-1 py-0 text-[10px]">
                {s.effect}
              </Badge>
              {s.ok === false && <X className="text-destructive size-3" />}
              {s.ok === true && <Check className="text-muted-foreground size-3" />}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const DECIDED = ["allowed", "denied", "expired"] as const;

const isDecided = (status: string | null): status is (typeof DECIDED)[number] => DECIDED.includes(status as never);

/**
 * In the stream, never a modal: five running conversations would mean five
 * stacked dialogs, and a modal blocks the one thing the design says must never
 * block -- going to look at something else.
 */
function PermissionCard({
  conversationId,
  message,
  body,
  author,
  indent,
}: {
  conversationId: string;
  message: Message;
  body: {
    requestId: string;
    call: { name: string; effect: string; input: Record<string, unknown> };
  };
  author?: Member;
  indent: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const { t } = useI18n();
  const decided = message.status && message.status !== "pending";
  const act = async (allow: boolean) => {
    setBusy(true);
    await api.resolvePermission(conversationId, body.requestId, allow);
  };
  return (
    <div className={cn("max-w-[min(680px,78%)]", indent && "ml-12")}>
      <Card className="gap-0 overflow-hidden py-0">
        <div className="bg-muted flex items-center gap-2 px-3.5 py-2">
          {author ? <CardAuthor author={author} /> : <ShieldAlert className="size-3.5" />}
          <span className="text-sm font-medium">{t("cards.permission")}</span>
          <span className="font-mono text-sm">{body.call.name}</span>
          <Badge variant="outline" className="bg-background ml-auto px-1.5 py-0 text-[10px]">
            {body.call.effect}
          </Badge>
        </div>
        <Separator />
        <pre className="text-muted-foreground max-h-40 overflow-auto px-3.5 py-2.5 font-mono text-xs leading-relaxed">
          {JSON.stringify(body.call.input, null, 2)}
        </pre>
        <Separator />
        {decided ? (
          <div className="text-muted-foreground px-3.5 py-2 text-sm">
            {isDecided(message.status) ? t(`cards.decided.${message.status}`) : message.status}
          </div>
        ) : (
          <div className="flex gap-2 px-3.5 py-2.5">
            <Button size="sm" disabled={busy} onClick={() => act(true)}>
              {t("cards.allow")}
            </Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => act(false)}>
              {t("cards.deny")}
            </Button>
          </div>
        )}
      </Card>
    </div>
  );
}

export function MessageCard({
  conversationId,
  message,
  group = false,
  author,
  onQuote,
}: {
  conversationId: string;
  message: Message;
  /** Only a group needs to say who is speaking. */
  group?: boolean;
  author?: Member;
  onQuote?: (text: string) => void;
}) {
  const { t } = useI18n();
  const body = JSON.parse(message.body_json) as Record<string, never>;
  const shownAuthor = group ? author : undefined;
  switch (message.card_kind) {
    case "text": {
      const human = message.author_kind === "human";
      const raw = String(body["text"] ?? "");
      const files = (body["attachments"] ?? []) as AttachmentRef[];
      return (
        <Bubble
          who={human ? "human" : "bot"}
          author={author}
          group={group}
          raw={raw}
          at={message.created_at}
          onQuote={onQuote}
          attachments={
            files.length > 0 ? (
              <MessageAttachments conversationId={conversationId} items={files} align={human ? "end" : "start"} />
            ) : undefined
          }
        >
          {/* what the human typed is shown verbatim; the bot answers in Markdown */}
          {human ? <HumanText text={raw} /> : <Markdown>{raw}</Markdown>}
        </Bubble>
      );
    }
    case "steps":
      return <StepsCard body={body as never} author={shownAuthor} indent={group} />;
    case "permission":
      return (
        <PermissionCard
          conversationId={conversationId}
          message={message}
          body={body as never}
          author={shownAuthor}
          indent={group}
        />
      );
    case "error":
      return (
        <div className="mx-auto max-w-[680px]">
          <Card className="border-destructive/40 px-3 py-2">
            <span className="text-destructive text-xs">
              {shownAuthor ? t("common.labelDetail", { label: shownAuthor.bot.name, detail: String(body["text"]) }) : body["text"]}
            </span>
          </Card>
        </div>
      );
    default:
      // joins, leaves, rule changes: a thin centered line, not a message
      return (
        <div className="flex justify-center py-0.5">
          <span className="bg-muted text-muted-foreground rounded-full px-2.5 py-0.5 text-[11px]">
            {body["text"] ?? message.card_kind}
          </span>
        </div>
      );
  }
}

/** A reply still being written: plain text, since half-written Markdown renders as garbage. */
export function StreamingBubble({ text, author, group }: { text: string; author?: Member; group: boolean }) {
  return (
    <div className="flex gap-3">
      {group && author && <BotAvatar bot={author.bot} />}
      <div className="flex max-w-[min(680px,78%)] min-w-0 flex-col gap-1">
        {group && author && <Byline author={author} />}
        <div className="text-message leading-relaxed break-words whitespace-pre-wrap">
          {text}
        </div>
      </div>
    </div>
  );
}
