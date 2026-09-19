import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ProgramManifest } from "@roster/adapter-api";
import { t } from "./i18n/index.js";
import { commandOf } from "./scripts.js";

export interface InstallJob {
  /** what is being installed: an agent program by its catalog id, or an adapter by its id */
  id: string;
  state: "running" | "done" | "failed";
  /** the last lines npm, or the program's own updater, printed */
  log: string[];
  startedAt: number;
  endedAt?: number;
  /** the program's own updater ran, not an install: when it fails, the old version still works */
  update?: boolean;
}

/** What a program's own update check said. */
export interface UpdateCheck {
  /** the version the program reports for itself */
  current?: string;
  latest: string;
  available: boolean;
}

export interface InstallOptions {
  version?: string;
  /** leave optional dependencies out: the platform binary a program already on this machine stands in for */
  omitOptional?: boolean;
  /** pinned versions for the package's own dependencies, as npm's overrides field takes them */
  overrides?: Record<string, string>;
}

/** A program Roster fetched itself. */
export interface InstalledProgram {
  path: string;
  version: string | null;
}

const LOG_LINES = 40;
const LOG_PUSH_MS = 500;
/** a check goes out to the network, but must not hold a settings page open for long */
const CHECK_TIMEOUT_MS = 20_000;
const ANSI_ESCAPE = /\x1b\[[0-?]*[ -/]*[@-~]/g;

const parsed = (s: string): unknown => {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
};

/** The JSON object a program printed: all of its output, or else its last line that is one. */
function jsonOf(text: string): Record<string, unknown> | null {
  for (const candidate of [text, ...text.split("\n").reverse()]) {
    const s = candidate.trim();
    const value = s.startsWith("{") ? parsed(s) : null;
    if (value && typeof value === "object") return value as Record<string, unknown>;
  }
  return null;
}

/** npm's package exports hide its bin, so the CLI is found next to the entry the exports do expose. */
export function npmCliPath(): string {
  const require = createRequire(import.meta.url);
  let dir = dirname(require.resolve("npm"));
  for (let i = 0; i < 4; i++) {
    const cli = join(dir, "bin", "npm-cli.js");
    if (existsSync(cli)) return cli;
    dir = dirname(dir);
  }
  throw new Error("core's own npm is missing its bin/npm-cli.js");
}

/** The npm package name for this machine, for programs published per platform. */
export const programPackage = (program: ProgramManifest): string =>
  program.npm.replace("{platform}", `${process.platform}-${process.arch}`);

/**
 * Puts things on disk with npm: agent programs under agents/<id>, adapters
 * that are not bundled under extensions/<id>. One directory each, so removing
 * one is deleting a directory. The npm that ships with core runs on the host's
 * own runtime, so a machine with neither node nor npm installed still works.
 */
export class Installer {
  #jobs = new Map<string, InstallJob>();
  readonly npmCli: string;

  constructor(
    /** where adapters go */
    readonly root: string,
    /** where agent programs go */
    readonly programsRoot: string,
    private changed: () => void,
  ) {
    this.npmCli = npmCliPath();
  }

  dirOf(id: string): string {
    return join(this.root, id);
  }

  programDirOf(id: string): string {
    return join(this.programsRoot, id);
  }

  job(id: string): InstallJob | undefined {
    return this.#jobs.get(id);
  }

  jobs(): InstallJob[] {
    return [...this.#jobs.values()];
  }

  /** Adapter ids with a directory here, installed or half-installed. */
  present(): string[] {
    if (!existsSync(this.root)) return [];
    return readdirSync(this.root).filter((d) => existsSync(join(this.root, d, "package.json")));
  }

  /** The program Roster installed for this catalog id, if it is there and runnable. */
  program(id: string, manifest: ProgramManifest): InstalledProgram | null {
    const pkg = programPackage(manifest);
    const pkgDir = join(this.programDirOf(id), "node_modules", ...pkg.split("/"));
    const file = join(pkgDir, "package.json");
    if (!existsSync(file)) return null;
    let version: string | null = null;
    let bin: string | undefined = manifest.binPath;
    try {
      const json = JSON.parse(readFileSync(file, "utf8")) as { version?: string; bin?: string | Record<string, string> };
      version = json.version ?? null;
      if (!bin) bin = typeof json.bin === "string" ? json.bin : json.bin?.[manifest.bin];
    } catch {
      return null;
    }
    if (!bin) return null;
    const path = join(pkgDir, bin);
    return existsSync(path) ? { path, version } : null;
  }

  /** Fetches an agent program; resolves when npm finishes, and the job records how it went either way. */
  installProgram(id: string, manifest: ProgramManifest): Promise<InstallJob> {
    return this.#install(id, this.programDirOf(id), programPackage(manifest), { ...(manifest.version ? { version: manifest.version } : {}) }, "program");
  }

  removeProgram(id: string): void {
    this.#remove(id, this.programDirOf(id));
  }

  /** Asks a program whether a newer version is out, by its own check; nothing is installed. */
  checkUpdate(program: string, args: readonly string[]): Promise<UpdateCheck> {
    const cmd = commandOf(program, args);
    return new Promise((resolve, reject) => {
      execFile(cmd.command, cmd.args, { timeout: CHECK_TIMEOUT_MS, maxBuffer: 1024 * 1024, env: { ...process.env, ...cmd.env } }, (err, stdout, stderr) => {
        const status = jsonOf(String(stdout));
        const error = status?.["error"];
        if (typeof error === "string" && error) return reject(new Error(error));
        if (!status && err) return reject(new Error(String(stderr).replace(ANSI_ESCAPE, "").trim() || err.message));
        const latest = status?.["latestVersion"];
        const current = status?.["currentVersion"];
        if (typeof latest !== "string" || !latest) return reject(new Error(t("error.update.unreadable")));
        resolve({ latest, available: status?.["updateAvailable"] === true, ...(typeof current === "string" ? { current } : {}) });
      });
    });
  }

  /** Runs a program's own updater on the copy at this path; resolves when it exits, and the job records how it went either way. */
  updateProgram(id: string, program: string, args: readonly string[]): Promise<InstallJob> {
    if (this.#jobs.get(id)?.state === "running") throw new Error(t("error.install.running", { id }));
    const job: InstallJob = { id, state: "running", log: [], startedAt: Date.now(), update: true };
    this.#jobs.set(id, job);
    this.changed();
    const cmd = commandOf(program, args);
    return this.#run(job, cmd.command, cmd.args, { cwd: homedir(), env: { ...process.env, ...cmd.env } }, (code) =>
      t("install.updaterExit", { code }),
    );
  }

  /** Fetches an adapter that is not bundled with Roster. */
  install(id: string, pkg: string, opts: InstallOptions = {}): Promise<InstallJob> {
    return this.#install(id, this.dirOf(id), pkg, opts, "extension");
  }

  /** Re-resolves an adapter at its latest version, in place. */
  update(id: string): Promise<InstallJob> {
    const dir = this.dirOf(id);
    if (!existsSync(join(dir, "package.json"))) throw new Error(t("error.install.notInstalled", { id }));
    const job: InstallJob = { id, state: "running", log: [], startedAt: Date.now() };
    this.#jobs.set(id, job);
    this.changed();
    return this.#npm(job, dir, ["update", "--omit=dev"]);
  }

  remove(id: string): void {
    this.#remove(id, this.dirOf(id));
  }

  #install(id: string, dir: string, pkg: string, opts: InstallOptions, kind: "program" | "extension"): Promise<InstallJob> {
    const running = this.#jobs.get(id);
    if (running?.state === "running") throw new Error(t("error.install.running", { id }));
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "package.json"),
      `${JSON.stringify(
        {
          name: `roster-${kind}-${id}`,
          private: true,
          ...(kind === "extension" ? { roster: { extension: pkg } } : {}),
          ...(opts.overrides ? { overrides: opts.overrides } : {}),
        },
        null,
        2,
      )}\n`,
    );
    const job: InstallJob = { id, state: "running", log: [], startedAt: Date.now() };
    this.#jobs.set(id, job);
    this.changed();
    const spec = opts.version ? `${pkg}@${opts.version}` : pkg;
    return this.#npm(job, dir, ["install", "--omit=dev", ...(opts.omitOptional ? ["--omit=optional"] : []), spec]);
  }

  #remove(id: string, dir: string): void {
    if (this.#jobs.get(id)?.state === "running") throw new Error(t("error.install.runningWait", { id }));
    rmSync(dir, { recursive: true, force: true });
    this.#jobs.delete(id);
    this.changed();
  }

  #npm(job: InstallJob, dir: string, args: string[]): Promise<InstallJob> {
    return this.#run(
      job,
      process.execPath,
      [this.npmCli, ...args, "--prefix", dir, "--no-audit", "--no-fund", "--loglevel=error", "--no-progress"],
      { cwd: dir, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", NODE_ENV: "production" } },
      (code) => t("install.npmExit", { code }),
    );
  }

  /** Runs a job's process to the end, keeping the last lines it printed; silent says why a failure left none. */
  #run(
    job: InstallJob,
    command: string,
    args: string[],
    options: { cwd: string; env: NodeJS.ProcessEnv },
    silent: (code: number | string) => string,
  ): Promise<InstallJob> {
    return new Promise((resolve) => {
      const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
      let told = 0;
      const take = (chunk: Buffer) => {
        // a progress bar redraws its line with \r, and each redraw is the newest line
        for (const raw of chunk.toString("utf8").split(/\r\n|\r|\n/)) {
          const line = raw.replace(ANSI_ESCAPE, "");
          if (!line.trim()) continue;
          job.log.push(line);
          if (job.log.length > LOG_LINES) job.log.shift();
        }
        // the page follows the newest line, but a bar redrawn many times a second must not flood it
        if (Date.now() - told >= LOG_PUSH_MS) {
          told = Date.now();
          this.changed();
        }
      };
      child.stdout.on("data", take);
      child.stderr.on("data", take);
      child.on("error", (err) => {
        job.log.push(err.message);
        job.state = "failed";
        job.endedAt = Date.now();
        this.changed();
        resolve(job);
      });
      child.on("exit", (code) => {
        job.state = code === 0 ? "done" : "failed";
        job.endedAt = Date.now();
        if (code !== 0 && job.log.length === 0) job.log.push(silent(code ?? "signal"));
        this.changed();
        resolve(job);
      });
    });
  }
}
