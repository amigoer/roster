import { closeSync, openSync, readSync } from "node:fs";

const NODE_SHEBANG = /^#!.*\bnode\b/;

/** A script by its extension, or by a shebang naming node: npm launchers often ship without an extension. */
export function isScript(p: string): boolean {
  if (/\.(c|m)?js$/.test(p)) return true;
  let fd: number | undefined;
  try {
    fd = openSync(p, "r");
    const head = Buffer.alloc(128);
    return NODE_SHEBANG.test(head.toString("utf8", 0, readSync(fd, head, 0, head.length, 0)));
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * A program file and its arguments as a command. A script runs on the host's
 * own runtime, so a machine without node on PATH still runs it; env is what
 * that takes on top of the caller's own.
 */
export function commandOf(file: string, args: readonly string[]): { command: string; args: string[]; env: Record<string, string> } {
  if (!isScript(file)) return { command: file, args: [...args], env: {} };
  return { command: process.execPath, args: [file, ...args], env: process.versions["electron"] ? { ELECTRON_RUN_AS_NODE: "1" } : {} };
}
