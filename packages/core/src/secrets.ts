import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

/** The key provider secrets are sealed with, as the desktop shell hands it over. */
export interface Vault {
  /** 32 bytes, or null when nothing on this machine can protect a key */
  key: Buffer | null;
  /** what protects the key: keychain, dpapi, a Linux keyring, basic_text, or none */
  keystore: string;
}

export const NO_VAULT: Vault = { key: null, keystore: "none" };

/** Enough to tell two keys apart, never enough to use one. */
export function hintOf(value: string): string {
  return value.length <= 10 ? "•".repeat(Math.max(4, value.length)) : `${value.slice(0, 3)}…${value.slice(-4)}`;
}

interface Row {
  alg: "aes-256-gcm" | "plain";
  iv: Uint8Array | null;
  tag: Uint8Array | null;
  data: Uint8Array;
  hint: string;
}

/**
 * Provider keys at rest. With the desktop shell's key they are sealed with
 * AES-256-GCM; without one they are kept as they are, and `encrypted` says so
 * instead of pretending. basic_text is Electron obfuscating the key file where
 * Linux has no keyring, which is not protection either.
 */
export class Secrets {
  constructor(
    private db: DatabaseSync,
    private vault: Vault,
  ) {}

  get encrypted(): boolean {
    return this.vault.key !== null && this.vault.keystore !== "basic_text";
  }

  get keystore(): string {
    return this.vault.keystore;
  }

  put(value: string, ref: string = randomUUID()): string {
    const key = this.vault.key;
    let row: Omit<Row, "hint">;
    if (key) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const data = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
      row = { alg: "aes-256-gcm", iv, tag: cipher.getAuthTag(), data };
    } else {
      row = { alg: "plain", iv: null, tag: null, data: Buffer.from(value, "utf8") };
    }
    this.db
      .prepare(
        `INSERT INTO secrets (ref, alg, iv, tag, data, hint, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(ref) DO UPDATE SET alg = excluded.alg, iv = excluded.iv, tag = excluded.tag,
                                        data = excluded.data, hint = excluded.hint, updated_at = excluded.updated_at`,
      )
      .run(ref, row.alg, row.iv, row.tag, row.data, hintOf(value), Date.now());
    return ref;
  }

  /** undefined when there is no such secret, or it was sealed with a key this machine no longer has */
  get(ref: string): string | undefined {
    const row = this.#row(ref);
    if (!row) return undefined;
    if (row.alg === "plain") return Buffer.from(row.data).toString("utf8");
    const key = this.vault.key;
    if (!key || !row.iv || !row.tag) return undefined;
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(row.iv));
      decipher.setAuthTag(Buffer.from(row.tag));
      return Buffer.concat([decipher.update(Buffer.from(row.data)), decipher.final()]).toString("utf8");
    } catch {
      return undefined;
    }
  }

  hint(ref: string): string | undefined {
    return this.#row(ref)?.hint;
  }

  delete(ref: string): void {
    this.db.prepare(`DELETE FROM secrets WHERE ref = ?`).run(ref);
  }

  /** Keys saved while there was nothing to seal them with get sealed once there is. */
  sealPlain(): number {
    if (!this.vault.key) return 0;
    const refs = this.db.prepare(`SELECT ref FROM secrets WHERE alg = 'plain'`).all() as unknown as Array<{ ref: string }>;
    for (const { ref } of refs) {
      const value = this.get(ref);
      if (value !== undefined) this.put(value, ref);
    }
    return refs.length;
  }

  #row(ref: string): Row | undefined {
    return this.db.prepare(`SELECT alg, iv, tag, data, hint FROM secrets WHERE ref = ?`).get(ref) as unknown as
      | Row
      | undefined;
  }
}
