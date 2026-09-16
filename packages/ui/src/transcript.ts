import type { Message, Presence, Step, StepsBody } from "./api";

/** One bot turn: its calls, its reply and what it asked the human, read as one piece. */
export interface Turn {
  id: string;
  memberId: string | null;
  steps: Step[];
  /** the reply, once the turn has ended; while it runs, the stream stands in for it */
  text?: Message;
  permissions: Message[];
  /** the turn's first row, which the transcript keys and jumps by */
  anchor?: Message;
}

export type Row =
  | { kind: "message"; key: string; message: Message }
  | { kind: "turn"; key: string; turn: Turn; live: boolean };

export type Part = { kind: "text"; text: string } | { kind: "steps"; steps: Step[] };

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

/**
 * The transcript as it reads. A turn's steps, reply and asks become one row, so
 * its calls can sit between the paragraphs they came between. A turn sorts where
 * it ended, which is where its reply always appeared; one still being written
 * stays at the bottom.
 */
export function transcript(messages: Message[], presence: Presence[], streams: Record<string, string>): Row[] {
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

  const running = new Map(presence.flatMap((p) => (p.turnId ? [[p.turnId, p.memberId] as const] : [])));
  for (const { turn, seq, order } of turns.values()) {
    const live = !turn.text && running.has(turn.id);
    placed.push({ seq: live ? Infinity : seq, order, row: { kind: "turn", key: `turn-${turn.id}`, turn, live } });
  }
  let order = messages.length;
  // a turn that has only written text so far has no rows yet
  for (const [turnId, memberId] of running) {
    if (turns.has(turnId) || !streams[memberId]?.trim()) continue;
    const turn: Turn = { id: turnId, memberId, steps: [], permissions: [] };
    placed.push({ seq: Infinity, order: order++, row: { kind: "turn", key: `turn-${turnId}`, turn, live: true } });
  }
  // text from a member whose presence has not arrived yet
  const writing = new Set(running.values());
  for (const [memberId, text] of Object.entries(streams)) {
    if (writing.has(memberId) || !text.trim()) continue;
    const turn: Turn = { id: "", memberId, steps: [], permissions: [] };
    placed.push({ seq: Infinity, order: order++, row: { kind: "turn", key: `stream-${memberId}`, turn, live: true } });
  }
  return placed.sort((a, b) => (a.seq === b.seq ? a.order - b.order : a.seq - b.seq)).map((p) => p.row);
}

/**
 * Splits a reply at the calls made while it was being written. Calls from before
 * placements were kept have none, and come ahead of the reply as they used to.
 */
export function interleave(text: string, steps: Step[]): Part[] {
  const reply = text.trimStart();
  const parts: Part[] = [];
  let cursor = 0;
  let group: Step[] = [];
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
