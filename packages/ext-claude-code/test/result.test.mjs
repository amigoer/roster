import { test } from "node:test";
import assert from "node:assert/strict";
import { resultText } from "../dist/result.js";

test("a string result stays as it is", () => {
  assert.equal(resultText("line 1\nline 2"), "line 1\nline 2");
});

test("block results read as their text, one block per line", () => {
  const blocks = [
    { type: "text", text: "found 2 tools" },
    { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
    { type: "tool_reference", tool_name: "WebFetch" },
  ];
  assert.equal(resultText(blocks), 'found 2 tools\n[image]\n{"type":"tool_reference","tool_name":"WebFetch"}');
});

test("a result with no content has no text", () => {
  assert.equal(resultText(undefined), "");
});
