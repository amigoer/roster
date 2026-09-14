import type { ProgramManifest } from "@roster/adapter-api";
import type { CatalogEntry } from "./catalog.js";
import type { DetectedProgram, Detector } from "./detect.js";
import type { Extension, Extensions } from "./extensions.js";
import type { InstalledProgram, Installer } from "./installer.js";

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
}

/**
 * Adapters ship with Roster; programs are found or fetched. This joins the
 * three sources of truth -- the catalog, what is loaded, what is on disk --
 * into one answer per type: can an executor of it run, and with which program.
 */
export class Harnesses {
  constructor(
    private catalog: readonly CatalogEntry[],
    private extensions: Extensions,
    private detector: Detector,
    private installer: Installer,
  ) {}

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
    const of = (entry: CatalogEntry, ext: Extension | undefined): HarnessView => ({
      ...entry,
      adapter: ext ? (ext.error ? "error" : ext.origin) : "missing",
      ...(ext?.error ? { adapterError: ext.error } : {}),
      state: ext && !ext.error ? this.state(entry.id) : { needed: Boolean(entry.program), usable: false },
    });
    const listed = this.catalog.map((entry) => of(entry, loaded.find((e) => e.type === entry.id)));
    // adapters that are not in the catalog, whatever brought them
    const extras = loaded
      .filter((e) => !this.catalog.some((c) => c.id === e.type))
      .map((e) => of({ id: e.type, label: e.label, description: e.name, ...(e.program ? { program: e.program } : {}) }, e));
    return [...listed, ...extras];
  }
}
