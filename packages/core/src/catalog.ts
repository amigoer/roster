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
    program: { npm: "@agentclientprotocol/codex-acp", version: "1.12.0", bin: "codex-acp", versionArgs: ["--version"] },
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
  {
    id: "grok-build",
    label: "Grok Build",
    get description() {
      return t("catalog.grok-build");
    },
    brand: "grok",
    // a launcher for the platform binary it brings, which its install script also links into ~/.grok/bin
    program: {
      npm: "@xai-official/grok",
      version: "1.0.33",
      bin: "grok",
      paths: ["~/.grok/bin/grok"],
      versionArgs: ["--version"],
      update: { args: ["update"], check: ["update", "--check", "--json"] },
    },
  },
  {
    id: "opencode",
    label: "OpenCode",
    get description() {
      return t("catalog.opencode");
    },
    brand: "opencode",
    // npm's copy is the platform binary its postinstall puts in place; the install script puts one in ~/.opencode/bin
    program: {
      npm: "opencode-ai",
      version: "1.18.31",
      bin: "opencode",
      paths: ["~/.opencode/bin/opencode"],
      versionArgs: ["--version"],
    },
  },
  {
    id: "deepseek-harness",
    label: "DeepSeek Harness",
    get description() {
      return t("catalog.deepseek-harness");
    },
    brand: "deepseek",
    // a developer preview that warns of breaking changes, so the version stays pinned
    program: { npm: "@deepseek-ai/dsh", version: "0.1.5-rc.2", bin: "dsh", versionArgs: ["--version"] },
  },
  {
    id: "kimi-code",
    label: "Kimi Code",
    get description() {
      return t("catalog.kimi-code");
    },
    brand: "kimi",
    // a script on the host's own runtime, which has to be node 22.19 or later; the install script puts one in ~/.local/bin
    program: { npm: "@moonshot-ai/kimi-code", version: "2.0.2", bin: "kimi", paths: ["~/.local/bin/kimi"], versionArgs: ["--version"] },
  },
  {
    id: "qwen-code",
    label: "Qwen Code",
    get description() {
      return t("catalog.qwen-code");
    },
    brand: "qwen",
    // a script on the host's own runtime, which has to be node 22 or later; the install script brings its own node and puts a wrapper in ~/.local/bin
    program: { npm: "@qwen-code/qwen-code", version: "0.24.2", bin: "qwen", paths: ["~/.local/bin/qwen"], versionArgs: ["--version"] },
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
