import { test } from "node:test";
import assert from "node:assert/strict";
import { contextOf, detailOf } from "../dist/context.js";
import { WORDS } from "../dist/words.js";

const base = {
  totalTokens: 18_269,
  maxTokens: 1_000_000,
  rawMaxTokens: 1_000_000,
  percentage: 2,
  gridRows: [],
  model: "claude-opus-5[1m]",
  memoryFiles: [{ path: "/Users/me/.claude/CLAUDE.md", type: "User", tokens: 2_683 }],
  mcpTools: [],
  agents: [],
  isAutoCompactEnabled: true,
  autoCompactThreshold: 967_000,
};

// what Claude Code 2.1.233 answers: no kind on any row
const unkinded = {
  ...base,
  categories: [
    { name: "System tools", tokens: 9_962, color: "a" },
    { name: "System tools (deferred)", tokens: 12_595, color: "b", isDeferred: true },
    { name: "Memory files", tokens: 2_683, color: "c" },
    { name: "Skills", tokens: 5_616, color: "d" },
    { name: "Messages", tokens: 8, color: "e" },
    { name: "Free space", tokens: 981_731, color: "f" },
  ],
};

test("rows without a kind are classified by their names", () => {
  const c = contextOf(unkinded, WORDS.en);
  assert.deepEqual(
    c.parts.map((p) => p.name),
    ["System tools", "Skills", "Memory files", "Messages"],
  );
  assert.deepEqual(c.deferred, [{ name: "System tools (deferred)", tokens: 12_595 }]);
  assert.equal(c.used, 18_269);
  assert.equal(c.max, 1_000_000);
});

test("a threshold stands in for a buffer row the CLI does not list", () => {
  const c = contextOf(unkinded, WORDS.en);
  assert.equal(c.autoCompactAt, 97);
  assert.deepEqual(c.reserved, { name: "Autocompact buffer", tokens: 33_000 });
});

test("rows with a kind are taken at their word, buffer row included", () => {
  const c = contextOf(
    {
      ...base,
      categories: [
        { name: "Messages", tokens: 606_800, color: "a", kind: "used" },
        { name: "MCP tools", tokens: 13_400, color: "b", kind: "used" },
        { name: "Autocompact buffer", tokens: 33_000, color: "c", kind: "buffer" },
        { name: "Free space", tokens: 311_300, color: "d", kind: "free" },
        { name: "MCP tools (deferred)", tokens: 48_600, color: "e", kind: "deferred", isDeferred: true },
        { name: "Empty", tokens: 0, color: "f", kind: "used" },
      ],
    },
    WORDS.en,
  );
  assert.deepEqual(c.parts, [
    { name: "Messages", tokens: 606_800 },
    { name: "MCP tools", tokens: 13_400 },
  ]);
  assert.deepEqual(c.reserved, { name: "Autocompact buffer", tokens: 33_000 });
  assert.deepEqual(c.deferred, [{ name: "MCP tools (deferred)", tokens: 48_600 }]);
});

test("no auto-compact means no threshold and no reserve", () => {
  const c = contextOf({ ...unkinded, isAutoCompactEnabled: false }, WORDS.en);
  assert.equal(c.autoCompactAt, undefined);
  assert.equal(c.reserved, undefined);
});

test("names read in Chinese, deferred ones keep saying so", () => {
  const c = contextOf(unkinded, WORDS["zh-CN"]);
  assert.deepEqual(c.parts.map((p) => p.name), ["系统工具", "技能", "记忆文件", "消息"]);
  assert.equal(c.deferred[0].name, "系统工具（按需加载）");
  assert.equal(c.reserved.name, "自动压缩预留");
});

test("sections carry totals, except the raw message rows", () => {
  const d = detailOf(
    {
      ...unkinded,
      mcpTools: [
        { name: "mcp__a__read", serverName: "a", tokens: 400, isLoaded: true },
        { name: "mcp__a__write", serverName: "a", tokens: 600, isLoaded: false },
      ],
      skills: { totalSkills: 2, includedSkills: 2, tokens: 90, skillFrontmatter: [{ name: "x", source: "user", tokens: 50 }, { name: "y", source: "user", tokens: 40 }] },
      messageBreakdown: { toolCallTokens: 10, toolResultTokens: 0, attachmentTokens: 88, assistantMessageTokens: 0, userMessageTokens: 5 },
    },
    WORDS.en,
  );
  const byTitle = Object.fromEntries(d.sections.map((s) => [s.title, s]));
  assert.equal(byTitle["Messages"].tokens, undefined);
  assert.deepEqual(byTitle["Messages"].rows.map((r) => r.name), ["Attachments", "Tool calls", "User messages"]);
  assert.equal(byTitle["MCP tools"].tokens, 1_000);
  assert.deepEqual(byTitle["MCP tools"].rows.map((r) => r.name), ["mcp__a__write", "mcp__a__read"]);
  assert.equal(byTitle["Skills"].tokens, 90);
  assert.equal(byTitle["Memory files"].rows.length, 1);
  assert.equal(byTitle["Custom agents"], undefined);
  assert.equal(d.model, "claude-opus-5[1m]");
});
