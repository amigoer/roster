import { useState } from "react";
import { CircleAlert, File, FileArchive, FileCode, FileImage, FileText, X } from "lucide-react";
import { attachmentUrl, type AttachmentRef } from "./api";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

/** Kept in step with core/src/attachments.ts, which is what enforces them. */
export const MAX_FILES = 10;
export const MAX_BYTES = 32 * 1024 * 1024;

/** The formats a model reads as a picture; anything else is shown and handed over as a file. */
export const isImage = (mime: string) => /^image\/(png|jpeg|gif|webp)$/.test(mime);

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const CODE = /\.(c|cc|cpp|cs|css|dart|go|h|hpp|html|java|js|json|jsx|kt|lua|mjs|php|py|rb|rs|scala|sh|sql|svelte|swift|toml|ts|tsx|vue|xml|ya?ml|zsh)$/i;

function Glyph({ name, mime, className }: { name: string; mime: string; className?: string }) {
  const Icon = mime.startsWith("image/")
    ? FileImage
    : /zip|tar|gzip|compress|rar|7z/.test(mime)
      ? FileArchive
      : CODE.test(name)
        ? FileCode
        : mime.startsWith("text/") || mime === "application/pdf"
          ? FileText
          : File;
  return <Icon className={className} />;
}

/** Past what model APIs take in one image; the core side names the same limit. */
const IMAGE_BYTES = 3_500_000;
const IMAGE_EDGE = 2000;

/**
 * A Retina screenshot runs past what a model takes in one piece. Scaled to a
 * 2000px long edge it still reads, and stays under the size an API refuses.
 */
export async function fitImage(file: File): Promise<File> {
  if (!/^image\/(png|jpeg|webp)$/.test(file.type)) return file;
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) return file;
  const scale = Math.min(1, IMAGE_EDGE / Math.max(bitmap.width, bitmap.height));
  if (scale === 1 && file.size <= IMAGE_BYTES) {
    bitmap.close();
    return file;
  }
  const canvas = new OffscreenCanvas(Math.round(bitmap.width * scale), Math.round(bitmap.height * scale));
  canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  let blob = await canvas.convertToBlob({ type: file.type, quality: 0.9 });
  if (blob.size > IMAGE_BYTES) {
    // JPEG has no transparency; a white ground reads the way the image was meant to
    const flat = new OffscreenCanvas(canvas.width, canvas.height);
    const ctx = flat.getContext("2d");
    if (ctx) {
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, flat.width, flat.height);
      ctx.drawImage(canvas, 0, 0);
    }
    blob = await flat.convertToBlob({ type: "image/jpeg", quality: 0.86 });
  }
  const ext = blob.type === "image/jpeg" ? "jpg" : (blob.type.split("/")[1] ?? "png");
  return new window.File([blob], `${file.name.replace(/\.[^.]+$/, "") || "image"}.${ext}`, { type: blob.type });
}

/** A file in the composer: on its way up, ready to go with the message, or refused. */
export interface Pending {
  key: string;
  name: string;
  mime: string;
  size: number;
  /** an object URL, for a picture */
  preview?: string;
  /** 0-1 */
  progress: number;
  ref?: AttachmentRef;
  error?: string;
}

/** What goes out with the message. A picture shows itself; anything else says what it is. */
export function PendingTray({ items, onRemove }: { items: Pending[]; onRemove: (key: string) => void }) {
  return (
    <div className="flex flex-wrap gap-2 px-3 pt-3">
      {items.map((p) => {
        const uploading = !p.ref && !p.error;
        return (
          <div key={p.key} className="group/att relative" title={p.error ?? `${p.name} · ${formatSize(p.size)}`}>
            {p.preview && !p.error ? (
              <img src={p.preview} alt={p.name} className="size-14 rounded-lg border object-cover" />
            ) : (
              <div
                className={cn(
                  "flex h-14 w-52 items-center gap-2.5 rounded-lg border px-2.5",
                  p.error ? "border-destructive/40 bg-destructive/5" : "bg-muted/50",
                )}
              >
                <span className="bg-background flex size-9 shrink-0 items-center justify-center rounded-md border">
                  {p.error ? (
                    <CircleAlert className="text-destructive size-4" />
                  ) : (
                    <Glyph name={p.name} mime={p.mime} className="text-muted-foreground size-4" />
                  )}
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-xs font-medium">{p.name}</span>
                  <span className={cn("block truncate text-[11px]", p.error ? "text-destructive" : "text-muted-foreground")}>
                    {p.error ?? formatSize(p.size)}
                  </span>
                </span>
              </div>
            )}
            {uploading && (
              // a bar rather than a spinner: a large file takes long enough that how far along it is matters
              <span className="bg-foreground/15 absolute inset-x-1.5 bottom-1.5 h-1 overflow-hidden rounded-full">
                <span className="bg-primary block h-full transition-[width]" style={{ width: `${Math.max(6, p.progress * 100)}%` }} />
              </span>
            )}
            <button
              type="button"
              aria-label={`移除 ${p.name}`}
              onClick={() => onRemove(p.key)}
              className={cn(
                "bg-foreground text-background absolute -top-1.5 -right-1.5 size-5 items-center justify-center rounded-full shadow-sm outline-none",
                "focus-visible:ring-ring/60 focus-visible:flex focus-visible:ring-2",
                p.error ? "flex" : "hidden group-hover/att:flex",
              )}
            >
              <X className="size-3" />
            </button>
          </div>
        );
      })}
    </div>
  );
}

/** Files on a sent message: pictures as pictures, the rest as cards that open them. */
export function MessageAttachments({
  conversationId,
  items,
  align,
}: {
  conversationId: string;
  items: AttachmentRef[];
  align: "start" | "end";
}) {
  const [open, setOpen] = useState<AttachmentRef | null>(null);
  const images = items.filter((a) => isImage(a.mime));
  const files = items.filter((a) => !isImage(a.mime));
  return (
    <>
      {images.length > 0 && (
        <div className={cn("flex flex-wrap gap-1.5", align === "end" && "justify-end")}>
          {images.map((a) => (
            <button
              key={a.id}
              type="button"
              title={a.name}
              onClick={() => setOpen(a)}
              className="bg-muted focus-visible:ring-ring/60 overflow-hidden rounded-xl border outline-none focus-visible:ring-2"
            >
              <img
                src={attachmentUrl(conversationId, a.id)}
                alt={a.name}
                loading="lazy"
                className={cn("block object-cover", images.length === 1 ? "max-h-64 max-w-72" : "size-28")}
              />
            </button>
          ))}
        </div>
      )}
      {files.map((a) => (
        // a new window: the desktop shell sends it to the default browser, which knows how to show a PDF or save a zip
        <a
          key={a.id}
          href={attachmentUrl(conversationId, a.id)}
          target="_blank"
          rel="noreferrer"
          title={a.name}
          className="bg-background hover:bg-accent flex w-64 max-w-full items-center gap-2.5 rounded-xl border px-3 py-2.5 transition-colors"
        >
          <span className="bg-muted flex size-9 shrink-0 items-center justify-center rounded-lg">
            <Glyph name={a.name} mime={a.mime} className="text-muted-foreground size-4" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">{a.name}</span>
            <span className="text-muted-foreground block text-xs">{formatSize(a.size)}</span>
          </span>
        </a>
      ))}
      <Dialog open={open !== null} onOpenChange={(o) => !o && setOpen(null)}>
        <DialogContent className="gap-3 p-3 sm:max-w-[min(90vw,1100px)]">
          <DialogTitle className="truncate pr-8 text-sm font-medium">{open?.name}</DialogTitle>
          {open && (
            <img
              src={attachmentUrl(conversationId, open.id)}
              alt={open.name}
              className="max-h-[80vh] w-full rounded-lg object-contain"
            />
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
