import type { ProgramManifest } from "@roster/adapter-api";
import type { CatalogEntry } from "./catalog.js";
import type { DetectedProgram, Detector } from "./detect.js";
import type { Extension, Extensions } from "./extensions.js";
import type { InstalledProgram, Installer, UpdateCheck } from "./installer.js";

/** asking goes out to the network, and programs release far less often than pages open */
const UPDATE_REUSE_MS = 30 * 60_000;

/** Where a type's program is, if anywhere: on the machine already, or fetched by Roster. */
export interface ProgramState {
  /** the adapter drives a separate program; false for a library adapter such as pi */
  needed: boolean;
  detected?: DetectedProgram;
  installed?: InstalledProgram;
  /** what a session runs when nobody picked a program: the one found, else Roster's own */
  path?: string;
  /** of that program, or of the library a program-less adapter carries */
  version?: string;
  /** an executor of this type can start */
  usable: boolean;
}

/** One harness type as the settings page shows it: adapter and program, each with where it stands. */
export interface HarnessView extends CatalogEntry {
  adapter: "bundled" | "installed" | "linked" | "missing" | "error";
  adapterError?: string;
  state: ProgramState;
  /** the program found on this machine updates itself, so Roster can run its updater */
  updatable?: boolean;
  /** what that program's own check last said */
  update?: UpdateCheck;
}

/** A program found on this machine and the updater it brings. */
export interface Updater {
  path: string;
  args: readonly string[];
  check?: readonly string[];
}

/**
 * Adapters ship with Roster; programs are found or fetched. This joins the
 * three sources of truth -- the catalog, what is loaded, what is on disk --
 * into one answer per type: can an executor of it run, and with which program.
 */
export class Harnesses {
  /** by type, with the copy it was asked of: another copy is another answer */
  #updates = new Map<string, { at: number; path: string; value: UpdateCheck }>();

  constructor(
    private catalog: readonly CatalogEntry[],
    private extensions: Extensions,
    private detector: Detector,
    private installer: Installer,
  ) {}

  /**
   * The program found on this machine, when it updates itself. The copy Roster
   * fetched is fetched again instead, at the version the catalog names.
   */
  updater(type: string): Updater | null {
    const update = this.program(type)?.update;
    const detected = this.detector.current()?.programs.find((p) => p.id === type);
    return update && detected ? { path: detected.path, ...update } : null;
  }

  /** Whether a newer version is out, by the program's own check; null when it has none. */
  async checkUpdate(type: string, fresh = false): Promise<UpdateCheck | null> {
    const updater = this.updater(type);
    if (!updater?.check) return null;
    const cached = this.#updates.get(type);
    if (!fresh && cached?.path === updater.path && Date.now() - cached.at < UPDATE_REUSE_MS) return cached.value;
    const value = await this.installer.checkUpdate(updater.path, updater.check);
    this.#updates.set(type, { at: Date.now(), path: updater.path, value });
    return value;
  }

  /** The program an adapter drives: the catalog's word first, then the extension's own manifest. */
  program(type: string): ProgramManifest | undefined {
    return this.catalog.find((c) => c.id === type)?.program ?? this.extensions.list().find((e) => e.type === type)?.program;
  }

  state(type: string): ProgramState {
    const manifest = this.program(type);
    if (!manifest) {
      const version = this.extensions.list().find((e) => e.type === type)?.harness?.version;
      return { needed: false, ...(version ? { version } : {}), usable: true };
    }
    const detected = this.detector.current()?.programs.find((p) => p.id === type);
    const installed = this.installer.program(type, manifest) ?? undefined;
    const runs = detected ?? installed;
    return {
      needed: true,
      ...(detected ? { detected } : {}),
      ...(installed ? { installed } : {}),
      ...(runs ? { path: runs.path } : {}),
      ...(runs?.version ? { version: runs.version } : {}),
      usable: Boolean(runs),
    };
  }

  view(): HarnessView[] {
    const loaded = this.extensions.list();
    const of = (entry: CatalogEntry, ext: Extension | undefined): HarnessView => {
      const updater = ext && !ext.error ? this.updater(entry.id) : null;
      const checked = this.#updates.get(entry.id);
      return {
        ...entry,
        adapter: ext ? (ext.error ? "error" : ext.origin) : "missing",
        ...(ext?.error ? { adapterError: ext.error } : {}),
        state: ext && !ext.error ? this.state(entry.id) : { needed: Boolean(entry.program), usable: false },
        ...(updater ? { updatable: true } : {}),
        ...(updater && checked?.path === updater.path ? { update: checked.value } : {}),
      };
    };
    const listed = this.catalog.map((entry) => of(entry, loaded.find((e) => e.type === entry.id)));
    // adapters that are not in the catalog, whatever brought them
    const extras = loaded
      .filter((e) => !this.catalog.some((c) => c.id === e.type))
      .map((e) => of({ id: e.type, label: e.label, description: e.name, ...(e.program ? { program: e.program } : {}) }, e));
    return [...listed, ...extras];
  }
}
