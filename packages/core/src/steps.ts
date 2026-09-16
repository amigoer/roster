import type { ToolEffect } from "@roster/adapter-api";
import type { CoreEvent } from "./log.js";

/** One tool call as a steps card lists it. What it took and returned stays in the log. */
export interface Step {
  id: string;
  name: string;
  effect: ToolEffect;
  /** what the call is about, in one line */
  title?: string;
  /** how much of the turn's reply was written when the call was made; absent on turns from before it was kept */
  at?: number;
  startedAt?: number;
  endedAt?: number;
  ok?: boolean;
  /** the first line of what a failed call returned */
  error?: string;
}

export interface StepsBody {
  steps: Step[];
  /** the seq of the latest event folded in, so a turn that ends without a reply still sorts where it ended */
  last?: number;
}

/** Everything one call took and returned, read back from the log. */
export interface StepDetail {
  id: string;
  name: string;
  effect: ToolEffect;
  input: Record<string, unknown>;
  output?: string;
  /** the output's full length, when only its first OUTPUT_MAX characters are here */
  size?: number;
  isError?: boolean;
  startedAt: number;
  endedAt?: number;
}

export type StepEvent = Extract<CoreEvent, { type: "tool.start" | "tool.end" | "permission.request" }>;

const TITLE_MAX = 160;

/** A person reads output a screen at a time; a whole log dump past this is cut. */
export const OUTPUT_MAX = 200_000;

/** Input fields that say what a call is about, the most telling first. */
const TITLE_KEYS = ["description", "command", "pattern", "query", "url", "file_path", "notebook_path", "path", "prompt"];

function lineOf(value: unknown): string | undefined {
  // an ACP agent can hand a command over as argv
  const text = Array.isArray(value) && value.every((v) => typeof v === "string") ? value.join(" ") : value;
  if (typeof text !== "string") return undefined;
  const line = text
    .split("\n")
    .map((l) => l.trim())
    .find(Boolean);
  if (!line) return undefined;
  return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 1)}…` : line;
}

export function titleOf(input: Record<string, unknown>): string | undefined {
  for (const key of TITLE_KEYS) {
    const line = lineOf(input[key]);
    if (line) return line;
  }
  for (const value of Object.values(input)) {
    const line = typeof value === "string" && value.length <= TITLE_MAX ? lineOf(value) : undefined;
    if (line) return line;
  }
  return undefined;
}

/** What a call returned, as text. pi once passed its result object through whole, and those rows are still in the log. */
export function outputText(content: string): string {
  if (!content.startsWith('{"content":[')) return content;
  try {
    const blocks = (JSON.parse(content) as { content: unknown[] }).content;
    return blocks
      .map((b) => {
        const block = b as { type?: unknown; text?: unknown };
        return block.type === "text" && typeof block.text === "string" ? block.text : JSON.stringify(b);
      })
      .join("\n");
  } catch {
    return content;
  }
}

/** Why a call failed, in one line: a shell's exit status comes last, while an error message leads. */
function errorOf(content: string): string | undefined {
  const lines = outputText(content)
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const last = lines.at(-1);
  return lineOf(last && /\bexit(ed)?\b.*\bcode\b/i.test(last) ? last : lines[0]);
}

/** Folds one call event into a turn's steps; false when it changes nothing. */
export function foldStep(body: StepsBody, event: StepEvent, seq: number | null, time: number): boolean {
  if (event.type === "tool.end") {
    const step = body.steps.find((s) => s.id === event.id);
    if (!step) return false;
    step.ok = !event.isError;
    step.endedAt = time;
    const error = event.isError ? errorOf(event.content) : undefined;
    if (error) step.error = error;
  } else {
    // one call can come as both a start and a permission request, in either order
    if (body.steps.some((s) => s.id === event.call.id)) return false;
    const title = titleOf(event.call.input);
    body.steps.push({
      id: event.call.id,
      name: event.call.name,
      effect: event.call.effect,
      ...(title ? { title } : {}),
      ...(event.at !== undefined ? { at: event.at } : {}),
      startedAt: time,
    });
  }
  if (seq !== null) body.last = seq;
  return true;
}
