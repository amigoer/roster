import type { Message, Presence, Step, StepsBody, Thought } from "./api";

/** One bot turn: its calls, its reply and what it asked the human, read as one piece. */
export interface Turn {
  id: string;
  memberId: string | null;
  /** its calls and thoughts, in the order they began */
  steps: Array<Step | Thought>;
  /** the reply, once the turn has ended; while it runs, the stream stands in for it */
  text?: Message;
  permissions: Message[];
  /** the turn's first row, which the transcript keys and jumps by */
  anchor?: Message;
}

export type Row =
  | { kind: "message"; key: string; message: Message }
  // floor: the one live turn whose words are shown as they come; another live row is only there for its pending ask
  | { kind: "turn"; key: string; turn: Turn; live: boolean; floor: boolean };

export type Part = { kind: "text"; text: string } | { kind: "steps"; steps: Array<Step | Thought> };

const IN_TURN = new Set<Message["card_kind"]>(["steps", "text", "permission"]);

/** A steps card is pushed again on every call; parsing it once per version keeps its steps the same objects. */
const parsed = new Map<string, { json: string; body: StepsBody }>();

function stepsOf(m: Message): StepsBody {
  const hit = parsed.get(m.id);
  if (hit?.json === m.body_json) return hit.body;
  if (parsed.size > 2000) parsed.clear();
  const body = JSON.parse(m.body_json) as StepsBody;
  parsed.set(m.id, { json: m.body_json, body });
  return body;
}

interface Running {
  turnId: string;
  memberId: string;
  since: number;
  /** where core listed it, which settles ties: members asked in the same instant were asked in this order */
  at: number;
}

/** The turns still being written, earliest begun first. */
function running(presence: Presence[]): Running[] {
  return presence
    .flatMap((p, at) => (p.turnId ? [{ turnId: p.turnId, memberId: p.memberId, since: p.since ?? 0, at }] : []))
    .sort((a, b) => a.since - b.since || a.at - b.at);
}

/**
 * Who has the floor: the one live turn shown as it is written. Several members
 * can be writing at once, but one stream is all a reader can follow, so the
 * others wait their turn in the presence strip. The earliest begun turn with
 * something to show takes it, and keeps it until its reply lands, even when
 * one that began earlier catches up; a row must not vanish mid-sentence.
 */
export function pickFloor(messages: Message[], presence: Presence[], streams: Record<string, string>, held: string | null): string | null {
  const rows = new Set<string>();
  const ended = new Set<string>();
  for (const m of messages) {
    if (!m.turn_id || m.author_kind !== "bot" || !IN_TURN.has(m.card_kind)) continue;
    rows.add(m.turn_id);
    if (m.card_kind === "text") ended.add(m.turn_id);
  }
  const candidates = running(presence).filter((r) => !ended.has(r.turnId) && (rows.has(r.turnId) || streams[r.memberId]?.trim()));
  return candidates.find((r) => r.turnId === held)?.turnId ?? candidates[0]?.turnId ?? null;
}

/**
 * The transcript as it reads. A turn's steps, reply and asks become one row, so
 * its calls can sit between the paragraphs they came between. A turn sorts where
 * it ended, which is where its reply always appeared; one still being written
 * stays at the bottom. Of the turns being written only the floor's is there,
 * plus any that is waiting on the human to approve a call: that card cannot wait.
 */
export function transcript(messages: Message[], presence: Presence[], streams: Record<string, string>, floor: string | null): Row[] {
  const turns = new Map<string, { turn: Turn; seq: number; order: number }>();
  const placed: Array<{ seq: number; order: number; row: Row }> = [];
  messages.forEach((m, order) => {
    if (!m.turn_id || m.author_kind !== "bot" || !IN_TURN.has(m.card_kind)) {
      placed.push({ seq: m.seq, order, row: { kind: "message", key: m.id, message: m } });
      return;
    }
    let entry = turns.get(m.turn_id);
    if (!entry) {
      entry = { turn: { id: m.turn_id, memberId: m.author_member_id, steps: [], permissions: [], anchor: m }, seq: m.seq, order };
      turns.set(m.turn_id, entry);
    }
    let end = m.seq;
    if (m.card_kind === "steps") {
      const body = stepsOf(m);
      entry.turn.steps = body.steps;
      end = Math.max(end, body.last ?? m.seq);
    } else if (m.card_kind === "text") {
      entry.turn.text = m;
    } else {
      entry.turn.permissions.push(m);
    }
    entry.seq = Math.max(entry.seq, end);
  });

  const live = running(presence);
  // the floor first, then the rest in the order they began: rows past the bottom never swap places
  const rank = (turnId: string) => (turnId === floor ? -1 : live.findIndex((r) => r.turnId === turnId));
  for (const { turn, seq, order } of turns.values()) {
    const writing = !turn.text && live.some((r) => r.turnId === turn.id);
    if (!writing) {
      placed.push({ seq, order, row: { kind: "turn", key: `turn-${turn.id}`, turn, live: false, floor: false } });
      continue;
    }
    const floored = turn.id === floor;
    if (!floored && !turn.permissions.some((p) => p.status === "pending")) continue;
    placed.push({ seq: Infinity, order: rank(turn.id), row: { kind: "turn", key: `turn-${turn.id}`, turn, live: true, floor: floored } });
  }
  // the floor may have only written text so far, which is no row yet
  const bare = live.find((r) => r.turnId === floor && !turns.has(r.turnId));
  if (bare && streams[bare.memberId]?.trim()) {
    const turn: Turn = { id: bare.turnId, memberId: bare.memberId, steps: [], permissions: [] };
    placed.push({ seq: Infinity, order: -1, row: { kind: "turn", key: `turn-${bare.turnId}`, turn, live: true, floor: true } });
  }
  return placed.sort((a, b) => (a.seq === b.seq ? a.order - b.order : a.seq - b.seq)).map((p) => p.row);
}

/**
 * Splits a reply at the calls made while it was being written. Calls from before
 * placements were kept have none, and come ahead of the reply as they used to.
 */
export function interleave(text: string, steps: Array<Step | Thought>): Part[] {
  const reply = text.trimStart();
  const parts: Part[] = [];
  let cursor = 0;
  let group: Array<Step | Thought> = [];
  for (const step of steps) {
    const at = Math.min(Math.max(step.at ?? 0, cursor), reply.length);
    const between = reply.slice(cursor, at).trim();
    if (between) {
      if (group.length > 0) parts.push({ kind: "steps", steps: group });
      parts.push({ kind: "text", text: between });
      group = [];
    }
    cursor = at;
    group.push(step);
  }
  if (group.length > 0) parts.push({ kind: "steps", steps: group });
  const rest = reply.slice(cursor).trim();
  if (rest) parts.push({ kind: "text", text: rest });
  return parts;
}
