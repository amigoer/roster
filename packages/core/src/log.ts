import type { NormalizedEvent } from "@roster/adapter-api";
import type { AttachmentRef } from "./attachments.js";
import type { ParamValue } from "./i18n/translate.js";

/** A notice as a message key, so it reads in the language of whoever reads it; text is how it read when written. */
export interface Notice {
  key: string;
  params?: Record<string, ParamValue>;
}

/** The passage a message replies to, carried with it rather than pasted into it. */
export interface Quote {
  /** the message it came from, so a reply can point back at it */
  messageId?: string;
  /** who said it, as they were called then; absent when the person quoted themselves */
  name?: string;
  text: string;
}

/**
 * A call with where it fell in its turn's reply: how much of the reply was
 * written by then. Deltas are not kept, so this is the only record of it.
 */
type Placed<T extends NormalizedEvent["type"]> = Extract<NormalizedEvent, { type: T }> & { at?: number };

/**
 * A stretch of thinking as core keeps it. Its row goes in the steps card when
 * its first words arrive; the words stream on the wire and are written once,
 * whole, when something else happens in the turn.
 */
export interface Thinking {
  type: "assistant.thinking";
  display: "fold";
  id: string;
  /** how much of the turn's reply was written when it began */
  at: number;
  startedAt: number;
  /** everything it said, once final; empty when it has only begun */
  delta: string;
  final?: boolean;
}

/**
 * Backend events plus the kinds core writes itself. Human lines and
 * membership notices go through the same log as everything else, so a member's
 * catch-up is one range scan over broadcast events.
 */
export type CoreEvent =
  | Exclude<NormalizedEvent, { type: "tool.start" | "permission.request" | "assistant.thinking" }>
  | Placed<"tool.start" | "permission.request">
  | Thinking
  | {
      type: "human.text";
      display: "message";
      text: string;
      mentions: string[];
      attachments?: AttachmentRef[];
      quote?: Quote;
    }
  | { type: "system.notice"; display: "message"; text: string; notice?: Notice };

/**
 * Two independent questions per event, answered here rather than at read time:
 *   surface   - does it become a card in the transcript?
 *   broadcast - do other members of the group see it on their next turn?
 * Both are stored as columns so each query is one indexed range scan and a later
 * rule change cannot silently rewrite what already happened.
 *
 * persist=false is the third answer: text deltas arrive tens of times a second
 * and carry nothing the final message does not, so they live on the SSE wire only.
 */
export interface Routing {
  persist: boolean;
  surface: boolean;
  broadcast: boolean;
}

const ROUTES: Record<CoreEvent["type"], Routing> = {
  // only the finalized text is a shared external fact
  "assistant.text": { persist: true, surface: true, broadcast: true },
  // never broadcast: it doubles the noise and leaks one model's reasoning into another's context
  "assistant.thinking": { persist: true, surface: true, broadcast: false },
  "tool.start": { persist: true, surface: true, broadcast: false },
  "tool.update": { persist: false, surface: true, broadcast: false },
  "tool.end": { persist: true, surface: true, broadcast: false },
  "permission.request": { persist: true, surface: true, broadcast: false },
  "permission.decision": { persist: true, surface: true, broadcast: false },
  // running is not unread, so these drive state only
  "turn.start": { persist: true, surface: false, broadcast: false },
  "turn.end": { persist: true, surface: false, broadcast: false },
  "cost": { persist: true, surface: false, broadcast: false },
  // a readout of the backend, restated every turn; the orchestrator keeps the latest in memory
  "session.info": { persist: false, surface: false, broadcast: false },
  "error": { persist: true, surface: true, broadcast: false },
  "human.text": { persist: true, surface: true, broadcast: true },
  // bots need to know who joined, left, or what the rules became
  "system.notice": { persist: true, surface: true, broadcast: true },
};

export function routeOf(e: CoreEvent): Routing {
  if (e.type === "assistant.text" && e.final !== true) {
    return { persist: false, surface: true, broadcast: false };
  }
  // only a thought's start and its whole are appended; a start has no words to keep yet
  if (e.type === "assistant.thinking" && e.final !== true) {
    return { persist: false, surface: true, broadcast: false };
  }
  return ROUTES[e.type];
}
