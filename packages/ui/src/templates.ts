import type { BotInput, Tier } from "./api";
import type { Translate } from "./i18n";

const ROLES = [
  { id: "go", avatar: "whale", permission_tier: "write" },
  { id: "frontend", avatar: "rocket", permission_tier: "write" },
  { id: "reviewer", avatar: "frog", permission_tier: "read" },
  { id: "architect", avatar: "elephant", permission_tier: "read" },
  { id: "tester", avatar: "cactus", permission_tier: "execute" },
  { id: "debugger", avatar: "ninja", permission_tier: "execute" },
  { id: "rust", avatar: "fox", permission_tier: "write" },
  { id: "python", avatar: "honey-bear", permission_tier: "write" },
  { id: "devops", avatar: "robot", permission_tier: "execute" },
  { id: "writer", avatar: "ghost", permission_tier: "write" },
  { id: "pm", avatar: "rabbit", permission_tier: "read" },
] as const satisfies ReadonlyArray<{ id: string; avatar: string; permission_tier: Tier }>;

export type Template = Pick<BotInput, "name" | "title" | "permission_tier"> & {
  id: (typeof ROLES)[number]["id"];
  /** a logo id; picked for the role, used unless another bot already wears it */
  avatar: string;
  system_prompt: string;
};

/**
 * Suggested roles, written in the current language. A preset is a starting
 * point the user edits, so these stay short and concrete rather than trying to
 * cover everything. The name has no spaces, since @name has to reach it.
 */
export const templates = (t: Translate): Template[] =>
  ROLES.map((role) => ({
    ...role,
    name: t(`template.${role.id}.name`),
    title: t(`template.${role.id}.title`),
    system_prompt: t(`template.${role.id}.prompt`),
  }));
