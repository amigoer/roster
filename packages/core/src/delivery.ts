import type { Attachment } from "@roster/adapter-api";
import type { Delivered } from "./attachments.js";
import type { Mode, TranscriptItem } from "./store.js";

/** Why a member is being asked to take a turn. Several can merge into one turn. */
export type Ask = "reply" | "mention" | "lead" | "reports" | "dispatch" | "discuss";

export const MODE_LABEL: Record<Mode, string> = {
  human_led: "人主导",
  leader: "群主分发",
  discussion: "讨论",
};

/** Oldest lines drop past this: a member joining late needs the gist, not every byte. */
const BACKLOG_CHARS = 32_000;

const INSTRUCTIONS: Record<Ask, string> = {
  reply: "以上是你上次发言之后群里的新消息，轮到你回复用户。你的回复群里所有人都能看到。",
  mention:
    "用户在群里 @ 了你，请回复。你的回复群里所有人都能看到；需要其他成员配合时直接说明，由用户决定是否 @ 他们。",
  lead:
    "你是这个群的群主。先判断任务要不要拆：需要时，用「@成员名 + 具体任务」分派给最合适的成员，每人单独一段，写清要做什么、交付什么；成员完成后你会收到他们的回复。不需要分派时直接回复用户，不要 @ 任何成员。",
  reports:
    "你分派的成员已经回复（见上）。汇总结果回复用户；还需要下一步时，继续用「@成员名 + 具体任务」分派。",
  dispatch: "群主给你分派了任务（见上）。完成你负责的部分，然后简要汇报结果，不要 @ 其他成员。",
  discuss:
    "现在是讨论模式：每位成员各自对用户最新的消息发表看法，最后由用户裁决。给出你的观点和理由；这一阶段只读，不要修改文件。",
};

/** When asks merge, the most specific instruction wins; the transcript carries the rest. */
const PRIORITY: Ask[] = ["reports", "lead", "dispatch", "discuss", "mention", "reply"];

/** Only the newest files ride along natively; older ones are still named in the text. */
const ATTACHMENTS_PER_TURN = 10;

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
  const lines = ["以下是这个会话此前的记录，供你接上上下文：", open("history", omitted)];
  for (const i of history) lines.push(...render(d, i));
  lines.push("</history>", "");
  lines.push(latest.length ? latest.map(said).join("\n\n") : "请接着之前的内容继续。");
  return lines.join("\n");
}

function group(d: DeliveryInput, items: DeliveryItem[], omitted: number): string {
  const lines = [`<group_chat title="${attr(d.title)}" mode="${MODE_LABEL[d.mode]}">`, "<members>"];
  for (const m of d.members) {
    const tags = [
      m.id === d.selfId ? "你" : null,
      d.mode === "leader" && m.id === d.leaderId ? "群主" : null,
    ].filter(Boolean);
    lines.push(`- ${m.name}${tags.length ? `（${tags.join("，")}）` : ""}${m.title ? `：${m.title}` : ""}`);
  }
  lines.push("- 用户：提出任务、做最终决定的人", "</members>", open("messages", omitted));
  for (const i of items) lines.push(...render(d, i));
  lines.push("</messages>", "</group_chat>", "");
  const ask = PRIORITY.find((a) => d.asks.has(a)) ?? "reply";
  lines.push(INSTRUCTIONS[ask]);
  return lines.join("\n");
}

function render(d: DeliveryInput, i: DeliveryItem): string[] {
  const time = hhmm(i.at);
  if (i.kind === "notice") return [`<notice time="${time}">${i.text}</notice>`];
  const name = i.memberId ? (d.names.get(i.memberId) ?? "已离开的成员") : "";
  const from = i.kind === "human" ? "用户" : i.memberId === d.selfId ? `${name}（你）` : name;
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
