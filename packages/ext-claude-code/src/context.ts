import type { SDKControlGetContextUsageResponse } from "@anthropic-ai/claude-agent-sdk";
import type { ContextDetail, ContextUse } from "@roster/adapter-api";
import type { Words } from "./words.js";

type Usage = SDKControlGetContextUsageResponse;
type Category = Usage["categories"][number];
type Row = { name: string; tokens: number };

/** A CLI older than the kind field names these rows the same way, so the names stand in for it. */
function kindOf(c: Category): Category["kind"] {
  if (c.kind) return c.kind;
  if (c.isDeferred) return "deferred";
  if (c.name === "Free space") return "free";
  if (c.name === "Autocompact buffer") return "buffer";
  return "used";
}

const DEFERRED = / \(deferred\)$/;

function nameOf(words: Words, name: string): string {
  const base = name.replace(DEFERRED, "");
  const local = words.categories[base] ?? base;
  return base === name ? local : words.deferred(local);
}

const largestFirst = (rows: Row[]): Row[] => rows.filter((r) => r.tokens > 0).sort((a, b) => b.tokens - a.tokens);

export function contextOf(c: Usage, words: Words): ContextUse {
  const max = c.rawMaxTokens || c.maxTokens;
  const of = (kind: Category["kind"]) =>
    largestFirst(c.categories.filter((p) => kindOf(p) === kind).map((p) => ({ name: nameOf(words, p.name), tokens: p.tokens })));
  const threshold = c.isAutoCompactEnabled && c.autoCompactThreshold && c.autoCompactThreshold < max ? c.autoCompactThreshold : undefined;
  // a CLI that lists no buffer row still holds the room past its threshold back
  const reserved = of("buffer").reduce((n, r) => n + r.tokens, 0) || (threshold ? max - threshold : 0);
  const deferred = of("deferred");
  return {
    used: c.totalTokens,
    max,
    percent: c.percentage,
    ...(threshold ? { autoCompactAt: Math.round((threshold / max) * 100) } : {}),
    parts: of("used"),
    ...(reserved > 0 ? { reserved: { name: words.reserved, tokens: reserved } } : {}),
    ...(deferred.length > 0 ? { deferred } : {}),
  };
}

/**
 * Everything contextOf carries, and what is inside each category. Message rows
 * are raw content rather than the room it takes in the window, so that section
 * alone goes without a total.
 */
export function detailOf(c: Usage, words: Words): ContextDetail {
  const s = words.sections;
  const section = (title: string, rows: Row[], total: boolean) => {
    const kept = largestFirst(rows);
    return { title, ...(total ? { tokens: kept.reduce((n, r) => n + r.tokens, 0) } : {}), rows: kept };
  };
  const m = c.messageBreakdown;
  return {
    ...contextOf(c, words),
    model: c.model,
    sections: [
      section(
        s.messages,
        m
          ? [
              { name: s.toolCalls, tokens: m.toolCallTokens },
              { name: s.toolResults, tokens: m.toolResultTokens },
              { name: s.attachments, tokens: m.attachmentTokens },
              { name: s.assistant, tokens: m.assistantMessageTokens },
              { name: s.user, tokens: m.userMessageTokens },
            ]
          : [],
        false,
      ),
      section(s.mcp, c.mcpTools.map((t) => ({ name: t.name, tokens: t.tokens })), true),
      // loaded and on-demand tools alike, the way the MCP section counts both
      section(s.tools, [...(c.systemTools ?? []), ...(c.deferredBuiltinTools ?? [])].map((t) => ({ name: t.name, tokens: t.tokens })), true),
      section(s.skills, (c.skills?.skillFrontmatter ?? []).map((k) => ({ name: k.name, tokens: k.tokens })), true),
      section(s.memory, c.memoryFiles.map((f) => ({ name: f.path, tokens: f.tokens })), true),
      section(s.agents, c.agents.map((a) => ({ name: a.agentType, tokens: a.tokens })), true),
      section(s.prompt, (c.systemPromptSections ?? []).map((p) => ({ name: p.name, tokens: p.tokens })), true),
    ].filter((x) => x.rows.length > 0),
  };
}
