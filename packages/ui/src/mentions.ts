import { activeMembers, type Conversation, type Member, type Message } from "./api";

/** Kept in step with core/src/mentions.ts, which is what actually routes. */
export const ALL_ALIASES = ["所有人", "全体成员", "all", "everyone"];

const WORD = /[A-Za-z0-9_]/;

function startsWithName(rest: string, name: string): boolean {
  if (!name || !rest.startsWith(name)) return false;
  const next = rest[name.length];
  return !(next !== undefined && WORD.test(next) && WORD.test(name[name.length - 1]!));
}

/** Splits text into plain runs and @mentions of the given names, for highlighting. */
export function segments(text: string, names: readonly string[]): Array<{ text: string; mention: boolean }> {
  if (!text.includes("@") || names.length === 0) return [{ text, mention: false }];
  const candidates = [...names, ...ALL_ALIASES].sort((a, b) => b.length - a.length);
  const out: Array<{ text: string; mention: boolean }> = [];
  let last = 0;
  for (let at = text.indexOf("@"); at !== -1; at = text.indexOf("@", at + 1)) {
    if (at < last || (at > 0 && WORD.test(text[at - 1]!))) continue;
    const rest = text.slice(at + 1).toLowerCase();
    const hit = candidates.find((n) => startsWithName(rest, n.toLowerCase()));
    if (!hit) continue;
    if (at > last) out.push({ text: text.slice(last, at), mention: false });
    out.push({ text: text.slice(at, at + 1 + hit.length), mention: true });
    last = at + 1 + hit.length;
  }
  if (last < text.length) out.push({ text: text.slice(last), mention: false });
  return out;
}

function mentioned(text: string, members: Member[]): { members: Member[]; all: boolean } {
  const plain = text.replace(/```[\s\S]*?```/g, " ").replace(/`[^`\n]*`/g, " ");
  const found = new Set<string>();
  let all = false;
  for (const s of segments(plain, members.map((m) => m.bot.name))) {
    if (!s.mention) continue;
    const name = s.text.slice(1).toLowerCase();
    const m = members.find((x) => x.bot.name.toLowerCase() === name);
    if (m) found.add(m.id);
    else all = true;
  }
  return { members: members.filter((m) => found.has(m.id)), all };
}

export function leaderOf(conv: Conversation): Member | undefined {
  const members = activeMembers(conv);
  return members.find((m) => m.id === conv.leader_member_id) ?? members[0];
}

/**
 * Who will answer if this draft is sent now. Mirrors core's routing, so the
 * composer can say it before you press Enter rather than after.
 */
export function recipientLabel(conv: Conversation, draft: string, messages: Message[]): string {
  const members = activeMembers(conv);
  if (members.length === 0) return "群里还没有成员";
  const hit = mentioned(draft, members);
  if (hit.all) return "所有成员";
  if (hit.members.length > 0) return hit.members.map((m) => m.bot.name).join("、");
  if (conv.mode === "leader") return `群主 ${leaderOf(conv)?.bot.name ?? ""}`;
  if (conv.mode === "discussion") return "所有成员，各说一次";
  const last = [...messages]
    .reverse()
    .find((m) => m.author_kind === "bot" && m.card_kind === "text" && members.some((x) => x.id === m.author_member_id));
  return (members.find((m) => m.id === last?.author_member_id) ?? members[0]!).bot.name;
}
