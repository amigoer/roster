import { randomUUID } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Attachment } from "@roster/adapter-api";
import { Rejection } from "./errors.js";
import { list, t } from "./i18n/index.js";

/** What a message keeps of a file: enough to show it and to find it again. */
export interface AttachmentRef {
  id: string;
  name: string;
  mime: string;
  size: number;
}

/** A file as a turn hands it over, with its text when it is short enough to read in place. */
export interface Delivered extends Attachment {
  content?: string;
}

export const MAX_BYTES = 32 * 1024 * 1024;
export const MAX_PER_MESSAGE = 10;
/** Past this a text file is pointed at instead: the agent reads a long one in parts with its own tools. */
const INLINE_BYTES = 64 * 1024;
const META = ".meta.json";
const ID = /^[0-9a-f-]{36}$/;

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".json": "application/json",
  ".md": "text/markdown",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".html": "text/html",
  ".zip": "application/zip",
};

/** Source and config files browsers upload as octet-stream or nothing at all. */
const TEXT_EXT = new Set(
  (
    ".txt .md .markdown .json .jsonl .yaml .yml .toml .ini .cfg .conf .env .csv .tsv .xml .html .htm .css .scss .less " +
    ".js .mjs .cjs .ts .tsx .jsx .vue .svelte .py .rb .php .go .rs .java .kt .kts .swift .c .h .cc .cpp .hpp .cs .m .mm " +
    ".sh .bash .zsh .fish .ps1 .sql .graphql .proto .lua .r .dart .scala .ex .exs .erl .hs .clj .gradle .log .diff .patch"
  ).split(" "),
);

const isText = (name: string, mime: string) =>
  mime.startsWith("text/") || /^application\/(json|xml|javascript|x-yaml|x-sh|toml)/.test(mime) || TEXT_EXT.has(extname(name).toLowerCase());

/** Only the last path segment survives, and never as something that could climb out of its directory. */
function safeName(raw: string): string {
  const base = raw.replace(/\\/g, "/").split("/").pop() ?? "";
  let name = base.replace(/[\x00-\x1f\x7f]/g, "").trim();
  if (!name || name === "." || name === "..") name = "file";
  if (name === META) name = "_meta.json";
  if (name.length > 120) {
    const ext = extname(name).slice(0, 16);
    name = name.slice(0, 120 - ext.length) + ext;
  }
  return name;
}

function mimeOf(name: string, declared: string): string {
  const m = declared.split(";")[0]!.trim().toLowerCase();
  if (/^[\w.+-]+\/[\w.+-]+$/.test(m) && m !== "application/octet-stream") return m;
  return MIME_BY_EXT[extname(name).toLowerCase()] ?? (TEXT_EXT.has(extname(name).toLowerCase()) ? "text/plain" : "application/octet-stream");
}

/**
 * Files people attach, under the data directory: core writes nothing into a
 * worktree. One directory per file, so its own name is the one an agent sees.
 */
export class AttachmentStore {
  constructor(private root: string) {}

  async save(conversationId: string, name: string, mime: string, body: Readable): Promise<AttachmentRef> {
    const id = randomUUID();
    const dir = join(this.root, conversationId, id);
    const file = safeName(name);
    mkdirSync(dir, { recursive: true });
    let size = 0;
    const limit = new Transform({
      transform(chunk: Buffer, _enc, done) {
        size += chunk.length;
        if (size > MAX_BYTES) done(new Rejection(t("error.attachment.tooLarge", { size: MAX_BYTES / 1024 / 1024 }), 413));
        else done(null, chunk);
      },
    });
    try {
      await pipeline(body, limit, createWriteStream(join(dir, file)));
    } catch (err) {
      rmSync(dir, { recursive: true, force: true });
      throw err;
    }
    const ref: AttachmentRef = { id, name: file, mime: mimeOf(file, mime), size };
    writeFileSync(join(dir, META), JSON.stringify(ref));
    return ref;
  }

  get(conversationId: string, id: string): AttachmentRef | null {
    if (!ID.test(id) || !ID.test(conversationId)) return null;
    const meta = join(this.root, conversationId, id, META);
    if (!existsSync(meta)) return null;
    try {
      return JSON.parse(readFileSync(meta, "utf8")) as AttachmentRef;
    } catch {
      return null;
    }
  }

  path(conversationId: string, ref: AttachmentRef): string {
    return join(this.root, conversationId, ref.id, ref.name);
  }

  remove(conversationId: string, id: string): void {
    if (ID.test(id) && ID.test(conversationId)) rmSync(join(this.root, conversationId, id), { recursive: true, force: true });
  }

  removeConversation(conversationId: string): void {
    if (ID.test(conversationId)) rmSync(join(this.root, conversationId), { recursive: true, force: true });
  }

  /** What a turn hands over. A file deleted from disk since is left out rather than failing the turn. */
  deliver(conversationId: string, refs: readonly AttachmentRef[]): Delivered[] {
    return refs.flatMap((ref) => {
      const path = this.path(conversationId, ref);
      if (!existsSync(path)) return [];
      const file: Delivered = { name: ref.name, mime: ref.mime, size: ref.size, path };
      if (ref.size > INLINE_BYTES || !isText(ref.name, ref.mime)) return [file];
      try {
        // fatal, so a binary file with a text-looking name is pointed at instead of pasted as noise
        return [{ ...file, content: new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(path)) }];
      } catch {
        return [file];
      }
    });
  }
}

/** One line for the list, the way a chat app says a message was a picture or a file. */
export function attachmentsPreview(refs: readonly AttachmentRef[]): string {
  const images = refs.filter((r) => r.mime.startsWith("image/")).length;
  const files = refs.filter((r) => !r.mime.startsWith("image/")).map((r) => r.name);
  return [
    images > 1 ? t("preview.images", { count: images }) : images ? t("preview.image") : "",
    files.length ? t("preview.files", { count: files.length, names: list(files) }) : "",
  ]
    .filter(Boolean)
    .join(" ");
}
