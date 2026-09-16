import { test } from "node:test";
import assert from "node:assert/strict";
import { listModels, modelLabel, wireModel } from "../dist/models.js";

// as the CLI answered on a Max plan, descriptions shortened
const catalog = [
  { value: "default", resolvedModel: "claude-opus-5[1m]", displayName: "Default (recommended)", description: "Opus 5 with 1M context" },
  { value: "opus[1m]", resolvedModel: "claude-opus-5[1m]", displayName: "Opus (1M context)", description: "Opus 5 with 1M context" },
  { value: "claude-fable-5[1m]", resolvedModel: "claude-fable-5", displayName: "Fable", description: "Fable 5" },
  { value: "sonnet", resolvedModel: "claude-sonnet-5", displayName: "Sonnet", description: "Sonnet 5" },
  { value: "haiku", resolvedModel: "claude-haiku-4-5-20251001", displayName: "Haiku", description: "Haiku 4.5" },
];

const listed = (rows) => listModels(rows).map(({ row, label }) => [row.value, label]);

test("rows go by the model they run, and default gives way to the row it stands for", () => {
  assert.deepEqual(listed(catalog), [
    ["opus[1m]", "Opus 5"],
    ["claude-fable-5[1m]", "Fable 5"],
    ["sonnet", "Sonnet 5"],
    ["haiku", "Haiku 4.5"],
  ]);
});

test("only a model offered in two context sizes says which one a row is", () => {
  const both = [
    { value: "claude-sonnet-4-6", resolvedModel: "claude-sonnet-4-6", displayName: "Sonnet 4.6", description: "" },
    { value: "claude-sonnet-4-6[1m]", resolvedModel: "claude-sonnet-4-6[1m]", displayName: "Sonnet 4.6 (1M context)", description: "" },
  ];
  assert.deepEqual(listed(both), [
    ["claude-sonnet-4-6", "Sonnet 4.6"],
    ["claude-sonnet-4-6[1m]", "Sonnet 4.6 (1M context)"],
  ]);
});

test("a row the name cannot be read from keeps the CLI's own, and a lone default stays", () => {
  const rows = [
    { value: "default", displayName: "Default (recommended)", description: "" },
    { value: "my-proxy-model", displayName: "Proxy model", description: "" },
  ];
  assert.deepEqual(listed(rows), [
    ["default", "Default (recommended)"],
    ["my-proxy-model", "Proxy model"],
  ]);
});

test("a model id reads as its name, and its wire name drops the context size", () => {
  assert.equal(modelLabel("claude-opus-5[1m]"), "Opus 5");
  assert.equal(modelLabel("claude-fable-5-1"), "Fable 5.1");
  assert.equal(modelLabel("deepseek/deepseek-chat"), "deepseek/deepseek-chat");
  assert.equal(wireModel("claude-opus-5[1m]"), "claude-opus-5");
  assert.equal(wireModel("claude-sonnet-5"), "claude-sonnet-5");
});
