import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";

/** "claude-haiku-4-5-20251001" reads as "Haiku 4.5"; an id of any other shape is shown as it is. */
export function modelLabel(id: string): string {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2})(?!\d))?/.exec(id);
  if (!m?.[1]) return id;
  return `${m[1].charAt(0).toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ""}`;
}

/** The context size the CLI appends to pick a longer window, as in claude-opus-5[1m]. */
const CONTEXT = /\[(\d+)m\]$/i;

/** The model as the API names it, which is how a turn's init reports it. */
export const wireModel = (id: string) => id.replace(CONTEXT, "");

const idOf = (m: ModelInfo) => m.resolvedModel ?? m.value;

/**
 * The catalog as a picker lists it. The CLI names its rows by family, "Opus (1M
 * context)", while a session reports the model it runs, so rows go by the
 * model's own name too; only a model that also comes with a longer context
 * says which one a row is, as the CLI writes "Sonnet 4.6 (1M context)".
 * "default" is left out where the model it stands for has a row of its own.
 */
export function listModels(catalog: readonly ModelInfo[]): Array<{ row: ModelInfo; label: string }> {
  const rows = catalog.filter((m) => m.value !== "default" || !catalog.some((o) => o !== m && idOf(o) === idOf(m)));
  const nameOf = (m: ModelInfo) => {
    const name = modelLabel(idOf(m));
    return name === idOf(m) ? m.displayName : name;
  };
  return rows.map((row) => {
    const label = nameOf(row);
    const size = CONTEXT.exec(idOf(row))?.[1];
    const twin = rows.some((o) => o !== row && idOf(o) !== idOf(row) && nameOf(o) === label);
    return { row, label: size && twin ? `${label} (${size}M context)` : label };
  });
}
