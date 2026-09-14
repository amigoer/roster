import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionManifest, HarnessType, ProgramManifest } from "@roster/adapter-api";
import { acpHarness } from "./acp.js";

/** The contract major version this build speaks. An extension written for another is not loaded. */
export const CONTRACT_API = 2;

export interface Extension {
  /** the harness type it provides, which is also what the catalog calls it */
  type: string;
  label: string;
  /** the npm package name */
  name: string;
  version: string;
  dir: string;
  /** shipped with Roster, installed by Roster into its extensions directory, or linked in from a development checkout */
  origin: "bundled" | "installed" | "linked";
  kind: "harness" | "acp" | "both";
  harness?: HarnessType;
  /** the agent program the adapter drives, when its manifest says so */
  program?: ProgramManifest;
  error?: string;
}

export interface ExtensionRoot {
  dir: string;
  origin: Extension["origin"];
}

interface PackageJson {
  name?: string;
  version?: string;
  roster?: ExtensionManifest & { extension?: string };
}

function readPackage(dir: string): PackageJson | null {
  const file = join(dir, "package.json");
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as PackageJson;
  } catch {
    return null;
  }
}

const isDir = (p: string) => existsSync(p) && statSync(p).isDirectory();

/** The program an ACP manifest names, when it is not on disk: a half-installed extension says so up front. */
function missingProgram(dir: string, command: readonly string[]): string | null {
  const program = command[0] === "node" ? command[1] : command[0];
  // the agent program is found or fetched by the host, not carried by the extension
  if (!program || program === "node" || program === "@program") return null;
  if (program.startsWith("./") || program.startsWith("../")) return existsSync(resolve(dir, program)) ? null : program;
  if (/^(@[^/]+\/)?[^/@][^/]*\/.+/.test(program)) {
    try {
      createRequire(join(dir, "package.json")).resolve(program);
      return null;
    } catch {
      return program;
    }
  }
  return null;
}

/**
 * One type out of two halves: the code drives endpoints, the ACP block drives
 * the agent's own sign-in. An executor is built by the half its source needs,
 * once, so nothing downstream picks a channel again.
 */
function compose(code: HarnessType, acp: HarnessType): HarnessType {
  return {
    type: code.type,
    label: code.label,
    ...(code.version ? { version: code.version } : {}),
    sources: { own: acp.sources.own, apis: code.sources.apis },
    capabilities: (kind) => (kind === "own" ? acp.capabilities("own") : code.capabilities("endpoint")),
    ...(code.presets ? { presets: () => code.presets!() } : {}),
    create: (instance) => ({ ...(instance.source.kind === "own" ? acp : code).create(instance), type: code.type }),
    ...(acp.login ? { login: (program) => acp.login!(program) } : {}),
    ...(acp.authenticate ? { authenticate: (methodId, program) => acp.authenticate!(methodId, program) } : {}),
  };
}

/**
 * Extensions on disk, loaded once at startup and again after an install. Each
 * is an npm package whose package.json carries a "roster" manifest; a code
 * entry exports `harness`, an ACP block describes an agent, and both together
 * give one type two channels.
 */
export class Extensions {
  #loaded: Extension[] = [];

  constructor(private roots: readonly ExtensionRoot[]) {}

  list(): Extension[] {
    return this.#loaded;
  }

  types(): HarnessType[] {
    return this.#loaded.flatMap((e) => (e.harness ? [e.harness] : []));
  }

  async load(): Promise<Extension[]> {
    const found: Extension[] = [];
    const seen = new Set<string>();
    for (const root of this.roots) {
      if (!isDir(root.dir)) continue;
      for (const child of readdirSync(root.dir).sort()) {
        const dir = join(root.dir, child);
        if (!isDir(dir)) continue;
        const pkgDir = this.#packageDir(dir);
        if (!pkgDir) continue;
        const ext = await this.#build(pkgDir, root.origin);
        if (!ext) continue;
        if (seen.has(ext.type)) {
          found.push({ ...ext, harness: undefined, error: `「${ext.type}」已经由另一个扩展提供，这个没有加载` });
          continue;
        }
        seen.add(ext.type);
        found.push(ext);
      }
    }
    this.#loaded = found;
    return found;
  }

  /** A directory is either an extension package itself, or a wrapper the installer made around one. */
  #packageDir(dir: string): string | null {
    const pkg = readPackage(dir);
    if (!pkg?.roster) return null;
    if (pkg.roster.extension) {
      const inner = join(dir, "node_modules", ...pkg.roster.extension.split("/"));
      return readPackage(inner)?.roster ? inner : null;
    }
    return dir;
  }

  async #build(dir: string, origin: Extension["origin"]): Promise<Extension | null> {
    const pkg = readPackage(dir);
    const manifest = pkg?.roster;
    if (!pkg || !manifest) return null;
    const name = pkg.name ?? dir;
    const base = { name, version: pkg.version ?? "0.0.0", dir, origin, ...(manifest.program ? { program: manifest.program } : {}) };
    const kind: Extension["kind"] = manifest.entry && manifest.acp ? "both" : manifest.entry ? "harness" : "acp";
    const fallbackType = manifest.type ?? name;
    const label = manifest.label ?? fallbackType;
    if (manifest.api !== CONTRACT_API) {
      return { ...base, type: fallbackType, label, kind, error: `它是按契约 v${manifest.api} 写的，这个版本的 Roster 只认 v${CONTRACT_API}` };
    }
    let code: HarnessType | undefined;
    if (manifest.entry) {
      try {
        const mod = (await import(pathToFileURL(resolve(dir, manifest.entry)).href)) as { harness?: HarnessType; default?: HarnessType };
        code = mod.harness ?? mod.default;
        if (!code || typeof code.create !== "function") throw new Error("入口没有导出 harness");
      } catch (err) {
        return { ...base, type: fallbackType, label, kind, error: `加载失败：${err instanceof Error ? err.message : String(err)}` };
      }
    }
    const type = code?.type ?? fallbackType;
    let harness: HarnessType | undefined = code;
    if (manifest.acp) {
      const missing = missingProgram(dir, manifest.acp.command);
      if (missing) return { ...base, type, label, kind, error: `它的依赖没有装好（找不到 ${missing}）；重新安装一次` };
      const acp = acpHarness({ type, label: code?.label ?? label, dir, manifest: manifest.acp, own: true });
      harness = code ? compose(code, acp) : acp;
    }
    if (!harness) return { ...base, type, label, kind, error: "清单里既没有入口也没有 ACP 配置" };
    return { ...base, type, label: harness.label, kind, harness };
  }
}
