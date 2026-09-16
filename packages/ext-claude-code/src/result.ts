/** A tool_result's content as text. MCP tools and a few built-ins answer in blocks rather than a string. */
export function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block: unknown) => {
      const b = (block ?? {}) as Record<string, unknown>;
      if (b["type"] === "text" && typeof b["text"] === "string") return b["text"];
      // the bytes are for the model; a person only needs to know one was there
      if (b["type"] === "image") return "[image]";
      return JSON.stringify(block);
    })
    .join("\n");
}
