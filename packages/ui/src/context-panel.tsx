import { useEffect, useState } from "react";
import { ChevronRight, RefreshCw, X } from "lucide-react";
import { api, type ContextDetail, type ContextUse } from "./api";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

export function tokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${Number((n / 1000).toFixed(1))}k`;
  return `${Number((n / 1_000_000).toFixed(1))}M`;
}

/**
 * Colour by position, not by name: every backend names its own categories, and
 * the adapter hands them over largest first, so the biggest slice keeps its
 * colour while an unknown name still gets one.
 */
const PALETTE = [
  "bg-blue-500",
  "bg-emerald-500",
  "bg-orange-500",
  "bg-violet-500",
  "bg-yellow-400",
  "bg-pink-500",
  "bg-cyan-500",
  "bg-lime-500",
  "bg-rose-500",
  "bg-stone-400",
];

export const partColor = (i: number) => PALETTE[i % PALETTE.length];

/** One segment per category, drawn against the whole window so the empty track is the room left. */
export function ContextBar({ context, className }: { context: ContextUse; className?: string }) {
  const parts = context.parts?.length ? context.parts : [{ name: "已用", tokens: context.used }];
  return (
    <div className={cn("bg-muted flex h-1.5 w-full gap-px overflow-hidden rounded-full", className)}>
      {parts.map((p, i) => (
        <div
          key={p.name}
          className={cn("h-full shrink-0 first:rounded-l-full", partColor(i))}
          style={{ width: `${Math.max(0.5, (p.tokens / context.max) * 100)}%` }}
        />
      ))}
    </div>
  );
}

const share = (n: number, max: number) => `${((n / max) * 100).toFixed(1)}%`;

/** A path is only recognisable by its end, and the whole of it is one hover away. */
function rowLabel(name: string): { text: string; title?: string } {
  const parts = name.split("/");
  if (parts.length < 3) return { text: name };
  return { text: `…/${parts.slice(-2).join("/")}`, title: name };
}

function Row({ name, value, right }: { name: string; value: string; right?: string }) {
  const { text, title } = rowLabel(name);
  return (
    <div className="flex items-baseline gap-2 text-sm">
      <span className="min-w-0 flex-1 truncate" title={title}>
        {text}
      </span>
      <span className="text-muted-foreground shrink-0 tabular-nums">{value}</span>
      {right !== undefined && (
        <span className="text-muted-foreground/70 w-11 shrink-0 text-right text-xs tabular-nums">{right}</span>
      )}
    </div>
  );
}

/**
 * What is inside one category. Deliberately without a total: a backend counts
 * these its own way -- Claude's message rows are the raw content, not the room
 * it takes in the window -- so only the rows themselves are its own claim.
 */
function Section({ title, rows }: { title: string; rows: Array<{ name: string; tokens: number }> }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="hover:bg-accent/50 -mx-2 flex w-[calc(100%+1rem)] items-center gap-2 rounded-md px-2 py-1.5 text-sm"
      >
        <ChevronRight className={cn("text-muted-foreground size-3.5 shrink-0 transition-transform", open && "rotate-90")} />
        <span className="min-w-0 flex-1 truncate text-left">{title}</span>
        <span className="text-muted-foreground shrink-0 text-xs tabular-nums">{rows.length} 项</span>
      </button>
      {open && (
        <div className="space-y-1 py-1 pl-5.5">
          {rows.map((r) => (
            <Row key={r.name} name={r.name} value={tokens(r.tokens)} />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Where a session's context window went, in Roster's own terms. Every name in
 * here comes from the backend, so a backend that counts differently still shows
 * up the same way.
 */
export function ContextPanel({
  conversationId,
  memberId,
  title,
  used,
  onClose,
}: {
  conversationId: string;
  memberId: string;
  /** who the window belongs to */
  title: string;
  /** the session's own count, so a finished turn reloads the breakdown */
  used: number | undefined;
  onClose: () => void;
}) {
  const [detail, setDetail] = useState<ContextDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(null);
    api
      .contextDetail(conversationId, memberId)
      .then((d) => live && (d.error ? setError(d.error) : (setDetail(d), setError(null))))
      .catch((e: unknown) => live && setError(String(e)))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [conversationId, memberId, used, nonce]);

  return (
    // a column when there is room; over the chat when a column would crush it
    <aside className="bg-background ring-border absolute inset-y-0 right-0 z-20 flex w-80 shrink-0 flex-col overflow-hidden rounded-xl shadow-xl ring-1 @3xl:static @3xl:shadow-panel @3xl:ring-0">
      <header className="flex h-13 shrink-0 items-center justify-between px-4">
        <span className="text-sm font-semibold">上下文</span>
        <div className="flex items-center gap-0.5">
          <Button variant="ghost" size="icon-sm" onClick={() => setNonce((n) => n + 1)} title="重新统计">
            <RefreshCw className={cn("size-4", loading && "animate-spin")} />
          </Button>
          <Button variant="ghost" size="icon-sm" onClick={onClose} title="收起">
            <X className="size-4" />
          </Button>
        </div>
      </header>
      <Separator />
      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-5 p-4">
          <section className="space-y-2">
            <div className="text-muted-foreground truncate text-xs">
              {title}
              {detail ? ` · ${detail.model}` : ""}
            </div>
            {detail ? (
              <>
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-lg font-semibold tabular-nums">{tokens(detail.used)}</span>
                  <span className="text-muted-foreground text-xs tabular-nums">
                    上限 {tokens(detail.max)} · 已用 {detail.percent}%
                  </span>
                </div>
                <ContextBar context={detail} className="h-2" />
              </>
            ) : (
              <p className="text-muted-foreground text-sm">{error ?? "统计中…"}</p>
            )}
          </section>

          {detail && (
            <>
              <section className="space-y-1.5">
                {detail.parts?.map((p, i) => (
                  <div key={p.name} className="flex items-center gap-2 text-sm">
                    <span className={cn("size-2.5 shrink-0 rounded-sm", partColor(i))} />
                    <span className="min-w-0 flex-1 truncate">{p.name}</span>
                    <span className="text-muted-foreground shrink-0 tabular-nums">{tokens(p.tokens)}</span>
                    <span className="text-muted-foreground/70 w-11 shrink-0 text-right text-xs tabular-nums">
                      {share(p.tokens, detail.max)}
                    </span>
                  </div>
                ))}
                <div className="text-muted-foreground flex items-center gap-2 text-sm">
                  <span className="bg-muted size-2.5 shrink-0 rounded-sm" />
                  <span className="min-w-0 flex-1 truncate">剩余</span>
                  <span className="shrink-0 tabular-nums">{tokens(Math.max(0, detail.max - detail.used))}</span>
                  <span className="text-muted-foreground/70 w-11 shrink-0 text-right text-xs tabular-nums">
                    {share(Math.max(0, detail.max - detail.used), detail.max)}
                  </span>
                </div>
              </section>

              {detail.sections.length > 0 && (
                <section>
                  <h3 className="text-muted-foreground pb-1 text-xs font-medium">明细</h3>
                  {detail.sections.map((s) => (
                    <Section key={s.title} title={s.title} rows={s.rows} />
                  ))}
                </section>
              )}

              {error && <p className="text-destructive text-xs">{error}</p>}
            </>
          )}
        </div>
      </ScrollArea>
    </aside>
  );
}
