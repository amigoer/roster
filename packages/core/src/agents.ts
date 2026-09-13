import type { HarnessType, ProgramManifest } from "@roster/adapter-api";
import type { CatalogEntry } from "./catalog.js";
import type { DetectedProgram, Detector } from "./detect.js";
import type { Extension, Extensions } from "./extensions.js";
import type { InstalledProgram, Installer } from "./installer.js";

/** Where an agent's program is, if anywhere: on the machine already, or fetched by Roster. */
export interface ProgramState {
  /** the adapter drives a separate program; false for a library adapter such as pi */
  needed: boolean;
  detected?: DetectedProgram;
  installed?: InstalledProgram;
  /** what a session runs: the person's own pick is applied later, this is the fallback */
  path?: string;
  /** a bot on this agent can start */
  usable: boolean;
}

/** One agent as the settings page shows it: adapter and program, each with where it stands. */
export interface AgentView extends CatalogEntry {
  adapter: "bundled" | "installed" | "linked" | "missing" | "error";
  adapterError?: string;
  state: ProgramState;
}

/**
 * Adapters ship with Roster; programs are found or fetched. This joins the
 * three sources of truth -- the catalog, what is loaded, what is on disk --
 * into one answer per agent: can a bot on it run, and with which program.
 */
export class Agents {
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
    if (!manifest) return { needed: false, usable: true };
    const detected = this.detector.current()?.programs.find((p) => p.id === type);
    const installed = this.installer.program(type, manifest) ?? undefined;
    const path = detected?.path ?? installed?.path;
    return {
      needed: true,
      ...(detected ? { detected } : {}),
      ...(installed ? { installed } : {}),
      ...(path ? { path } : {}),
      usable: Boolean(path),
    };
  }

  /** What fills an executor's empty settings: the program this machine has. */
  defaults(type: HarnessType): Readonly<Record<string, string>> {
    const { path } = this.state(type.type);
    return path ? { executable: path } : {};
  }

  /** Types a bot could run on right now: adapter loaded, program at hand. */
  usable(): HarnessType[] {
    return this.extensions.types().filter((t) => this.state(t.type).usable);
  }

  view(): AgentView[] {
    const loaded = this.extensions.list();
    const of = (entry: CatalogEntry, ext: Extension | undefined): AgentView => ({
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
