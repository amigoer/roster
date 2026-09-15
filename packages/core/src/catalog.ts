import type { ProgramManifest } from "@roster/adapter-api";
import { t } from "./i18n/index.js";

/**
 * The harnesses Roster knows how to drive. The adapter for each ships with Roster;
 * what varies per machine is the agent program, which is used where it is
 * found and fetched only where it is not. The program rules live here rather
 * than in the extensions so a program is recognised even before its adapter
 * has loaded.
 */
export interface CatalogEntry {
  /** the harness type id the adapter provides */
  id: string;
  label: string;
  description: string;
  /** a brand mark the UI knows */
  brand?: string;
  /** the agent program; absent when the adapter carries its agent as a library */
  program?: ProgramManifest;
  /** an adapter that is not bundled with Roster: the npm package to install it from */
  extension?: { npm: string; version?: string; overrides?: Record<string, string> };
}

/** Descriptions are getters, so each read is in the language Roster is in by then. */
export const CATALOG: readonly CatalogEntry[] = [
  {
    id: "claude-code",
    label: "Claude Code",
    get description() {
      return t("catalog.claude-code");
    },
    brand: "claude",
    program: {
      // the same binary the Agent SDK ships as its platform package, pinned to the SDK the adapter uses
      npm: "@anthropic-ai/claude-agent-sdk-{platform}",
      version: "0.3.269",
      bin: "claude",
      binPath: "claude",
      paths: ["~/.local/bin/claude", "~/.claude/local/claude"],
      versionArgs: ["--version"],
    },
  },
  {
    id: "pi-agent",
    label: "pi-agent",
    get description() {
      return t("catalog.pi-agent");
    },
    brand: "pi",
  },
  {
    id: "codex",
    label: "Codex",
    get description() {
      return t("catalog.codex");
    },
    brand: "openai",
    program: { npm: "@zed-industries/codex-acp", version: "0.16.0", bin: "codex-acp", versionArgs: ["--version"] },
  },
  {
    id: "gemini-cli",
    label: "Gemini CLI",
    get description() {
      return t("catalog.gemini-cli");
    },
    brand: "google",
    program: { npm: "@google/gemini-cli", version: "0.59.0", bin: "gemini", versionArgs: ["--version"] },
  },
];

/** Environment variables people keep keys in, and the preset each one opens. */
export const KEY_ENVS: Readonly<Record<string, string>> = {
  ANTHROPIC_API_KEY: "anthropic",
  OPENAI_API_KEY: "openai",
  DEEPSEEK_API_KEY: "deepseek",
  GEMINI_API_KEY: "google",
  GOOGLE_API_KEY: "google",
  MISTRAL_API_KEY: "mistral",
  OPENROUTER_API_KEY: "openrouter",
  GROQ_API_KEY: "groq",
  XAI_API_KEY: "xai",
  MOONSHOT_API_KEY: "moonshot",
  DASHSCOPE_API_KEY: "alibaba",
  ZHIPU_API_KEY: "zai",
};
