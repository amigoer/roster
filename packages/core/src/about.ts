import { readdirSync, readFileSync, statSync } from "node:fs";
import { arch, homedir, platform, release } from "node:os";
import { join } from "node:path";

/** What the 关于 page shows: which build is running, on what, and where its data lives. */
export interface About {
  version: string;
  /** run from a checkout rather than a packaged app */
  fromSource: boolean;
  startedAt: number;
  /** code on disk changed after this process started, so what runs is no longer what was built */
  stale: boolean;
  runtime: { node: string; electron?: string; chrome?: string; platform: string; release: string; arch: string };
  paths: { data: string; agents: string; attachments: string; extensions: string };
  /** so paths under it can be shown as ~ */
  home: string;
}

/** The newest modification time among the JavaScript files directly inside these directories. */
function newestCode(dirs: readonly string[]): number {
  let newest = 0;
  for (const dir of dirs) {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".js")) continue;
      try {
        newest = Math.max(newest, statSync(join(dir, name)).mtimeMs);
      } catch {
        // removed while scanning
      }
    }
  }
  return newest;
}

/** Stamps the code as it is now; every read compares what is on disk then against that stamp. */
export function aboutReader(opts: {
  packageJson: string;
  fromSource: boolean;
  codeDirs: readonly string[];
  paths: About["paths"];
}): () => About {
  const startedAt = Date.now();
  const stamp = newestCode(opts.codeDirs);
  let version = "";
  try {
    version = String((JSON.parse(readFileSync(opts.packageJson, "utf8")) as { version?: unknown }).version ?? "");
  } catch {
    // a missing manifest leaves the version blank rather than failing the page
  }
  return () => ({
    version,
    fromSource: opts.fromSource,
    startedAt,
    stale: newestCode(opts.codeDirs) > stamp,
    runtime: {
      node: process.versions.node,
      // core runs on Electron's own Node inside the app, and on a plain node from a terminal
      ...(process.versions["electron"] ? { electron: process.versions["electron"] } : {}),
      ...(process.versions["chrome"] ? { chrome: process.versions["chrome"] } : {}),
      platform: platform(),
      release: release(),
      arch: arch(),
    },
    paths: opts.paths,
    home: homedir(),
  });
}
