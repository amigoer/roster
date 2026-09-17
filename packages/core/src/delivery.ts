import type { Attachment } from "@roster/adapter-api";
import type { Delivered } from "./attachments.js";
import { t } from "./i18n/index.js";
import type { Mode, TranscriptItem } from "./store.js";

/** Why a member is being asked to take a turn. Several can merge into one turn. */
export type Ask = "reply" | "mention" | "lead" | "reports" | "dispatch" | "discuss";

/** Oldest lines drop past this: a member joining late needs the gist, not every byte. */
const BACKLOG_CHARS = 32_000;

/** When asks merge, the most specific instruction wins; the transcript carries the rest. */
const PRIORITY: Ask[] = ["reports", "lead", "dispatch", "discuss", "mention", "reply"];

/** Only the newest files ride along natively; older ones are still named in the text. */
const ATTACHMENTS_PER_TURN = 10;

/**
 * A notice after which the roster has to be restated: who is in the group, or
 * how it runs, changed. A directory change is not here: it resets every
 * member's delivery, so each reads the roster again as a fresh one.
 */
const ROSTER_NOTICE = /^notice\.(joined|removed|leader|mode\.)/;

/** A transcript line with its attachments found on disk. */
export type DeliveryItem = TranscriptItem & { files?: readonly Delivered[] };

export interface Delivery {
  text: string;
  /** every file the text names, newest last, for a backend that can take them as they are */
  attachments: Attachment[];
}

export interface DeliveryInput {
  shape: "direct" | "group";
  title: string;
  mode: Mode;
  selfId: string;
  leaderId: string | null;
  /** current members, in join order */
  members: ReadonlyArray<{ id: string; name: string; title: string | null }>;
  /** every member id that may appear in the transcript, departed ones included */
  names: ReadonlyMap<string, string>;
  items: DeliveryItem[];
  asks: ReadonlySet<Ask>;
  /** the backend session has read nothing yet: joined, or restarted after a sync */
  fresh: boolean;
}

/** What one member reads at the start of its turn, or null when nothing is owed. */
export function composeDelivery(d: DeliveryInput): Delivery | null {
  const { items, omitted } = trim(d.items);
  if (items.length === 0) return null;
  const text = d.shape === "direct" ? direct(d, items, omitted) : group(d, items, omitted);
  const attachments = items
    .flatMap((i) => i.files ?? [])
    .slice(-ATTACHMENTS_PER_TURN)
    .map(({ name, mime, size, path }) => ({ name, mime, size, path }));
  return { text, attachments };
}

/** What the human typed, then what they attached: a short text file in full, anything else by where it is. */
function said(i: DeliveryItem): string {
  const files = (i.files ?? []).map((f) =>
    f.content !== undefined
      ? `<attachment name="${attr(f.name)}" path="${attr(f.path)}">\n${f.content}\n</attachment>`
      : `<attachment name="${attr(f.name)}" path="${attr(f.path)}" type="${f.mime}" size="${sizeLabel(f.size)}" />`,
  );
  return [i.text, ...files].filter(Boolean).join("\n\n");
}

function direct(d: DeliveryInput, items: DeliveryItem[], omitted: number): string {
  // the everyday case is exactly what the human typed, untouched
  if (omitted === 0 && items.every((i) => i.kind === "human")) {
    return items.map(said).join("\n\n");
  }
  // a fresh session (a synced preset) has to be told what came before
  let cut = items.length;
  while (cut > 0 && items[cut - 1]!.kind === "human") cut--;
  const history = items.slice(0, cut);
  const latest = items.slice(cut);
  const lines = [t("delivery.history"), open("history", omitted)];
  for (const i of history) lines.push(...render(d, i));
  lines.push("</history>", "");
  lines.push(latest.length ? latest.map(said).join("\n\n") : t("delivery.continue"));
  return lines.join("\n");
}

/**
 * Everything handed over stays in the backend's context for the rest of the
 * session, so the roster and the rules go over once, when the session is new or
 * they changed; an ordinary turn is the new lines and one line of instruction.
 */
function group(d: DeliveryInput, items: DeliveryItem[], omitted: number): string {
  const roster = d.fresh || items.some((i) => i.kind === "notice" && i.notice !== undefined && ROSTER_NOTICE.test(i.notice));
  const lines: string[] = [];
  if (roster) {
    lines.push(`<group_chat title="${attr(d.title)}" mode="${t(`delivery.mode.${d.mode}`)}">`, "<members>");
    for (const m of d.members) {
      const tags = [
        m.id === d.selfId ? t("delivery.tag.self") : null,
        d.mode === "leader" && m.id === d.leaderId ? t("delivery.tag.leader") : null,
      ].filter((tag) => tag !== null);
      const tagged = tags.length ? t("delivery.tags", { tags: tags.join(t("delivery.tagSeparator")) }) : "";
      lines.push(`- ${m.name}${tagged}${m.title ? t("delivery.title", { title: m.title }) : ""}`);
    }
    lines.push(t("delivery.userLine"), "</members>");
  }
  lines.push(open("messages", omitted));
  for (const i of items) lines.push(...render(d, i));
  lines.push("</messages>");
  if (roster) lines.push("</group_chat>");
  lines.push("");
  const ask = PRIORITY.find((a) => d.asks.has(a)) ?? "reply";
  // the name comes every turn: a session that has run for hours must not have to find it in its first message
  const self = d.names.get(d.selfId) ?? d.members.find((m) => m.id === d.selfId)?.name;
  lines.push(`${self ? t("delivery.self", { name: self }) : ""}${t(`delivery.ask.${ask}`)}`);
  return lines.join("\n");
}

function render(d: DeliveryInput, i: DeliveryItem): string[] {
  const time = hhmm(i.at);
  if (i.kind === "notice") return [`<notice time="${time}">${i.text}</notice>`];
  const name = i.memberId ? (d.names.get(i.memberId) ?? t("delivery.departed")) : "";
  const from =
    i.kind === "human"
      ? t("delivery.user")
      : i.memberId === d.selfId
        ? `${name}${t("delivery.tags", { tags: t("delivery.tag.self") })}`
        : name;
  return [`<message from="${attr(from)}" time="${time}">`, said(i), "</message>"];
}

/**
 * Walks back from the newest line. Past the budget, older bot lines and notices
 * are dropped, but never what the human said: a request cannot be summarized away.
 */
function trim<T extends TranscriptItem>(all: T[]): { items: T[]; omitted: number } {
  let budget = BACKLOG_CHARS;
  let full = false;
  const keep = all.map(() => false);
  for (let i = all.length - 1; i >= 0; i--) {
    const item = all[i]!;
    // the newest line always goes through, however long
    if (!full && i < all.length - 1 && item.text.length > budget) full = true;
    if (!full || item.kind === "human") {
      keep[i] = true;
      budget -= item.text.length;
    }
  }
  const items = all.filter((_, i) => keep[i]);
  return { items, omitted: all.length - items.length };
}

const open = (tag: string, omitted: number) =>
  omitted > 0 ? `<${tag} omitted_earlier="${omitted}">` : `<${tag}>`;

const attr = (s: string) => s.replace(/"/g, "'");

const sizeLabel = (bytes: number) =>
  bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

function hhmm(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
