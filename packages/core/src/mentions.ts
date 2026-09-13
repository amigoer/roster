/** Aliases that address every member at once. */
export const ALL_ALIASES = ["所有人", "全体成员", "all", "everyone"] as const;

const WORD = /[A-Za-z0-9_]/;

/**
 * Finds @name addresses by matching against the members actually present,
 * longest name first: CJK text has no spaces to end a name on, so a generic
 * "@\S+" pattern would swallow the words that follow a CJK name.
 */
export function findMentions(
  text: string,
  members: ReadonlyArray<{ id: string; name: string }>,
): { ids: string[]; all: boolean } {
  // an @ inside code is a decorator or an email, not an address
  const plain = text.replace(/```[\s\S]*?```/g, " ").replace(/`[^`\n]*`/g, " ");
  const lower = plain.toLowerCase();
  const byLength = [...members].sort((a, b) => b.name.length - a.name.length);
  const ids: string[] = [];
  let all = false;

  for (let at = lower.indexOf("@"); at !== -1; at = lower.indexOf("@", at + 1)) {
    // foo@bar is an email address
    if (at > 0 && WORD.test(plain[at - 1]!)) continue;
    const rest = lower.slice(at + 1);
    const hit = byLength.find((m) => startsWithName(rest, m.name.toLowerCase()));
    if (hit) {
      if (!ids.includes(hit.id)) ids.push(hit.id);
      continue;
    }
    if (ALL_ALIASES.some((a) => startsWithName(rest, a))) all = true;
  }
  return { ids, all };
}

/** "@Bob" must not match inside "@Bobby", but a CJK name may run straight into the next word. */
function startsWithName(rest: string, name: string): boolean {
  if (!name || !rest.startsWith(name)) return false;
  const next = rest[name.length];
  return !(next !== undefined && WORD.test(next) && WORD.test(name[name.length - 1]!));
}
