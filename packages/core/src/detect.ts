import { execFile } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { KEY_ENVS, type CatalogEntry } from "./catalog.js";
import { commandOf } from "./scripts.js";

export interface DetectedProgram {
  /** the catalog entry it belongs to */
  id: string;
  path: string;
  version: string | null;
  found: "path" | "npm-global" | "known-path";
}

/** A credential that already exists on this machine; only its name, never its value. */
export interface CredentialHint {
  kind: "env" | "pi-auth";
  name: string;
  /** the preset it most likely opens */
  preset: string;
}

export interface Environment {
  at: number;
  programs: DetectedProgram[];
  hints: CredentialHint[];
  /** whether the login shell answered; without it PATH and keys are the process's own */
  shell: { name: string; ok: boolean };
}

const SHELL_TIMEOUT_MS = 6_000;
const VERSION_TIMEOUT_MS = 6_000;
const NPM_TIMEOUT_MS = 10_000;

const expand = (p: string) => (p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);

const isFile = (p: string): boolean => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

function run(file: string, args: string[], timeout: number, env?: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout, maxBuffer: 4 * 1024 * 1024, env: env ?? process.env }, (err, stdout) => {
      if (err) reject(err);
      else resolve(String(stdout));
    });
  });
}

/** "2.1.233 (Claude Code)" reads as 2.1.233; anything without a number is kept as it is. */
const versionOf = (out: string): string | null => {
  const line = out.split("\n").map((l) => l.trim()).find(Boolean);
  if (!line) return null;
  return /\d+\.\d+/.exec(line)?.[0] ? (/\d+(?:\.\d+)+[\w.-]*/.exec(line)?.[0] ?? line) : line;
};

/**
 * What is already on this machine: agent programs, and where keys live. The
 * login shell is asked once, because an app opened from the dock inherits
 * none of what .zshrc exports, and that is where both PATH and keys are.
 */
export class Detector {
  #shellEnv: Record<string, string> | null = null;
  #shellOk = false;
  #env: Environment | null = null;
  #running: Promise<Environment> | null = null;

  constructor(
    private catalog: readonly CatalogEntry[],
    private npmCli: string,
  ) {}

  /** Read once per process; the shell does not change while the app runs. */
  async shellEnv(): Promise<Record<string, string>> {
    if (this.#shellEnv) return this.#shellEnv;
    const out: Record<string, string> = {};
    const shell = process.env["SHELL"];
    if (shell && process.platform !== "win32") {
      try {
        const text = await run(shell, ["-ilc", "env"], SHELL_TIMEOUT_MS, { ...process.env, TERM: "dumb" });
        for (const line of text.split("\n")) {
          const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
          if (m) out[m[1]!] = m[2]!;
        }
        this.#shellOk = Object.keys(out).length > 0;
      } catch {
        this.#shellOk = false;
      }
    }
    this.#shellEnv = out;
    return out;
  }

  current(): Environment | null {
    return this.#env;
  }

  detect(fresh = false): Promise<Environment> {
    if (!fresh && this.#env) return Promise.resolve(this.#env);
    this.#running ??= this.#detect().finally(() => {
      this.#running = null;
    });
    return this.#running;
  }

  async #detect(): Promise<Environment> {
    const shell = await this.shellEnv();
    const dirs = [...new Set([...(shell["PATH"] ?? "").split(delimiter), ...(process.env["PATH"] ?? "").split(delimiter)].filter(Boolean))];
    const globalRoot = await this.#npmRoot();
    const programs: DetectedProgram[] = [];
    await Promise.all(
      this.catalog.map(async (entry) => {
        const rule = entry.program;
        if (!rule) return;
        let hit: Omit<DetectedProgram, "version"> | undefined;
        if (rule.bin) {
          const dir = dirs.find((d) => isFile(join(d, rule.bin!)));
          if (dir) hit = { id: entry.id, path: join(dir, rule.bin), found: "path" };
        }
        if (!hit && rule.paths) {
          const p = rule.paths.map(expand).find(isFile);
          if (p) hit = { id: entry.id, path: p, found: "known-path" };
        }
        // a global npm install of the program's own package, or of the launcher package that wraps it
        if (!hit && globalRoot) {
          const bin = join(dirname(globalRoot), "bin", rule.bin);
          if (isFile(bin)) hit = { id: entry.id, path: bin, found: "npm-global" };
        }
        if (!hit) return;
        const cmd = rule.versionArgs ? commandOf(hit.path, rule.versionArgs) : null;
        const version = cmd
          ? await run(cmd.command, cmd.args, VERSION_TIMEOUT_MS, { ...process.env, ...cmd.env })
              .then(versionOf)
              .catch(() => null)
          : null;
        programs.push({ ...hit, version });
      }),
    );
    programs.sort((a, b) => a.id.localeCompare(b.id));

    const hints: CredentialHint[] = [];
    for (const [name, preset] of Object.entries(KEY_ENVS)) {
      if (process.env[name] || shell[name]) hints.push({ kind: "env", name, preset });
    }
    for (const provider of piProviders()) hints.push({ kind: "pi-auth", name: provider, preset: provider });

    this.#env = { at: Date.now(), programs, hints, shell: { name: process.env["SHELL"] ?? "", ok: this.#shellOk } };
    return this.#env;
  }

  async #npmRoot(): Promise<string | null> {
    try {
      const out = await run(process.execPath, [this.npmCli, "root", "-g"], NPM_TIMEOUT_MS, {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
      });
      const root = out.trim().split("\n").at(-1)?.trim();
      return root && existsSync(root) ? root : null;
    } catch {
      return null;
    }
  }
}

/** Providers pi is signed in to, by id only: the file holds the credentials and is not read further. */
function piProviders(): string[] {
  const file = join(homedir(), ".pi", "agent", "auth.json");
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
    return parsed && typeof parsed === "object" ? Object.keys(parsed as object) : [];
  } catch {
    return [];
  }
}
