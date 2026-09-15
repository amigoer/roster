import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { ProgramManifest } from "@roster/adapter-api";
import { t } from "./i18n/index.js";

export interface InstallJob {
  /** what is being installed: an agent program by its catalog id, or an adapter by its id */
  id: string;
  state: "running" | "done" | "failed";
  /** the last lines npm printed */
  log: string[];
  startedAt: number;
  endedAt?: number;
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
    return new Promise((resolve) => {
      const child = spawn(
        process.execPath,
        [this.npmCli, ...args, "--prefix", dir, "--no-audit", "--no-fund", "--loglevel=error", "--no-progress"],
        {
          cwd: dir,
          env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", NODE_ENV: "production" },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      const take = (chunk: Buffer) => {
        for (const line of chunk.toString("utf8").split("\n")) {
          if (!line.trim()) continue;
          job.log.push(line);
          if (job.log.length > LOG_LINES) job.log.shift();
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
        if (code !== 0 && job.log.length === 0) job.log.push(t("install.npmExit", { code: code ?? "signal" }));
        this.changed();
        resolve(job);
      });
    });
  }
}
