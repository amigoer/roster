import type { ToolCall } from "@roster/adapter-api";
import { t } from "./i18n/index.js";
import { titleOf } from "./steps.js";
import type { Attention, ConversationRow } from "./store.js";

/** Why a conversation wants a person. The kinds of attention are the reasons; "none" is not one. */
export type Reason = Exclude<Attention, "none">;

/** What a conversation has just started waiting for, with what it takes to say so. */
export type Waiting =
  | { reason: "waiting_permission"; name: string; call: ToolCall }
  /** name is absent when the failure came from the backend rather than a member's turn */
  | { reason: "error"; name?: string; message: string }
  | { reason: "waiting_input" };

/**
 * One conversation asking for a person, in the words every client shows. Core
 * decides this once -- what is worth interrupting someone for, and how it reads
 * -- so the desktop shell and, later, a phone cannot drift apart.
 */
export interface Notification {
  /** what opening it lands on */
  conversationId: string;
  reason: Reason;
  /** the conversation, as the list names it */
  title: string;
  /** why it waits: what was said, or what it wants decided */
  body: string;
  at: number;
}

/** A notification is read at a glance, and every platform cuts it somewhere past this anyway. */
const BODY_MAX = 160;

/** Who said it: a group has to name the speaker, a 1:1 never does. */
const said = (conv: ConversationRow, name: string, text: string): string =>
  conv.shape === "group" ? t("preview.speaker", { name, text }) : text;

export function notificationOf(conv: ConversationRow, waiting: Waiting): Notification {
  const body = lineOf(conv, waiting);
  return {
    conversationId: conv.id,
    reason: waiting.reason,
    title: conv.title,
    body: body.length > BODY_MAX ? `${body.slice(0, BODY_MAX - 1)}…` : body,
    at: Date.now(),
  };
}

function lineOf(conv: ConversationRow, waiting: Waiting): string {
  switch (waiting.reason) {
    case "waiting_permission":
      return said(conv, waiting.name, t("notify.permission", { what: titleOf(waiting.call.input) ?? waiting.call.name }));
    case "error":
      return waiting.name ? said(conv, waiting.name, waiting.message) : waiting.message;
    case "waiting_input":
      // the preview is the reply itself, already carrying the speaker in a group
      return conv.preview ?? t("notify.replied");
  }
}
