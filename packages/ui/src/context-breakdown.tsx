import { useEffect, useRef, useState } from "react";
import { ChevronRight, Loader } from "lucide-react";
import { api, type ContextDetail, type ContextUse } from "./api";
import { useI18n } from "./i18n";
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
  "bg-primary",
  "bg-teal-500",
  "bg-violet-500",
  "bg-amber-400",
  "bg-pink-500",
  "bg-sky-400",
  "bg-lime-500",
  "bg-orange-500",
  "bg-fuchsia-500",
  "bg-stone-400",
];

export const partColor = (i: number) => PALETTE[i % PALETTE.length];

export type Slice = { name: string; tokens: number; color: string };

/** Held back, not in use: hatched, so it reads as part of the window without passing for a category. */
const RESERVED = "text-muted-foreground/50 [background-image:repeating-linear-gradient(135deg,currentColor_0_1.5px,transparent_1.5px_4px)]";

/**
 * One segment per slice, drawn against the whole window so the empty track is the room left.
 * The compaction reserve sits over the far end, where the window runs out.
 */
export function ContextBar({
  context,
  slices,
  marker,
  className,
}: {
  context: ContextUse;
  /** every category in its own colour unless the caller groups them */
  slices?: Slice[];
  /** a percent of the window to mark, such as where the backend compacts */
  marker?: number;
  className?: string;
}) {
  const { t } = useI18n();
  const shown =
    slices ??
    (context.parts?.length ? context.parts : [{ name: t("context.used"), tokens: context.used }]).map((p, i) => ({
      ...p,
      color: partColor(i),
    }));
  const reserved = context.reserved ? Math.min(100, (context.reserved.tokens / context.max) * 100) : 0;
  return (
    <div className={cn("relative h-1.5 w-full", className)}>
      <div className="bg-muted relative flex size-full gap-px overflow-hidden rounded-full">
        {shown.map((s) => (
          <div
            key={s.name}
            className={cn("h-full shrink-0 first:rounded-l-full", s.color)}
            style={{ width: `${Math.max(0.5, (s.tokens / context.max) * 100)}%` }}
          />
        ))}
        {/* over the segments rather than beside them: a window already running into it still shows */}
        {reserved > 0 && <div aria-hidden className={cn("absolute inset-y-0 right-0", RESERVED)} style={{ width: `${reserved}%` }} />}
      </div>
      {marker !== undefined && (
        <span
          aria-hidden
          className="bg-foreground/40 ring-popover absolute top-1/2 h-3.5 w-0.5 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2"
          style={{ left: `${marker}%` }}
        />
      )}
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

function Share({
  swatch,
  name,
  value,
  max,
  outside = false,
}: {
  swatch: string;
  name: string;
  value: number;
  max: number;
  /** outside the window, so it has no share of it */
  outside?: boolean;
}) {
  return (
    <li className="flex items-center gap-1.5">
      <span className={cn("size-2 shrink-0 rounded-full", swatch)} />
      <span className="text-muted-foreground min-w-0 flex-1 truncate">{name}</span>
      <span className={cn("shrink-0 tabular-nums", outside && "text-muted-foreground")}>{tokens(value)}</span>
      <span className="text-muted-foreground/70 w-11 shrink-0 text-right tabular-nums">{outside ? "—" : share(value, max)}</span>
    </li>
  );
}

/**
 * What is inside one category. A total is shown only where the backend gives
 * one: a backend counts these its own way -- Claude's message rows are the raw
 * content, not the room it takes in the window -- so where rows do not add up
 * to what the category holds, only the rows themselves are its own claim.
 */
function Section({ title, total, rows }: { title: string; total: number | undefined; rows: Array<{ name: string; tokens: number }> }) {
  const [open, setOpen] = useState(false);
  const { t } = useI18n();
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="hover:bg-accent -mx-1.5 flex w-[calc(100%+0.75rem)] items-center gap-1.5 rounded-md px-1.5 py-1"
      >
        <ChevronRight className={cn("text-muted-foreground size-3.5 shrink-0 transition-transform", open && "rotate-90")} />
        <span className="min-w-0 flex-1 truncate text-left">{title}</span>
        {total !== undefined && <span className="shrink-0 tabular-nums">{tokens(total)}</span>}
        <span className="text-muted-foreground/70 min-w-11 shrink-0 text-right whitespace-nowrap tabular-nums">
          {t("context.items", { count: rows.length })}
        </span>
      </button>
      {open && (
        <ul className="space-y-1 pt-0.5 pb-1.5 pl-5">
          {rows.map((r) => {
            const { text, title: full } = rowLabel(r.name);
            return (
              <li key={r.name} className="flex items-baseline gap-2">
                <span className="text-muted-foreground min-w-0 flex-1 truncate" title={full}>
                  {text}
                </span>
                <span className="shrink-0 tabular-nums">{tokens(r.tokens)}</span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/**
 * Where a session's context window went, in Roster's own terms: each category's
 * share, then what is inside them. The shares are already in the session's own
 * count; the contents take a fresh count, so they are only asked for once this
 * is on screen. Every name in here comes from the backend.
 */
export function ContextBreakdown({
  context,
  conversationId,
  memberId,
  className,
}: {
  context: ContextUse;
  conversationId: string;
  memberId: string;
  className?: string;
}) {
  const [detail, setDetail] = useState<ContextDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** the session's count a request went out at, and the count its answer came back with */
  const asked = useRef<number | null>(null);
  const answered = useRef<number | null>(null);
  const counting = useRef(false);
  const mounted = useRef(true);
  const [settled, setSettled] = useState(0);
  const { t } = useI18n();

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // A finished turn changes the count, so it counts again, one count at a time;
  // what was there stays until the new one lands. A backend that reports its
  // fresher count back through the session has not changed anything by it.
  useEffect(() => {
    const used = context.used;
    if (counting.current || used === asked.current || used === answered.current) return;
    counting.current = true;
    asked.current = used;
    api
      .contextDetail(conversationId, memberId)
      .then((d) => {
        if (!mounted.current) return;
        if (d.error) return setError(d.error);
        answered.current = d.used;
        setDetail(d);
        setError(null);
      })
      .catch((e: unknown) => mounted.current && setError(String(e)))
      .finally(() => {
        counting.current = false;
        // the count may have moved while this one was out
        if (mounted.current) setSettled((n) => n + 1);
      });
  }, [conversationId, memberId, context.used, settled]);

  const reserved = context.reserved?.tokens ?? 0;
  return (
    <div className={cn("space-y-3 text-xs", className)}>
      <ul className="space-y-1.5">
        {context.parts?.map((p, i) => (
          <Share key={p.name} swatch={partColor(i)} name={p.name} value={p.tokens} max={context.max} />
        ))}
        {context.reserved && <Share swatch={RESERVED} name={context.reserved.name} value={reserved} max={context.max} />}
        <Share
          swatch="bg-muted ring-1 ring-inset ring-foreground/15"
          name={t("context.free")}
          value={Math.max(0, context.max - context.used - reserved)}
          max={context.max}
        />
        {context.deferred?.map((p) => (
          <Share key={p.name} swatch="ring-1 ring-inset ring-muted-foreground/40" name={p.name} value={p.tokens} max={context.max} outside />
        ))}
      </ul>
      {detail ? (
        detail.sections.length > 0 && (
          <div>
            <h4 className="text-muted-foreground pb-1 font-medium">{t("context.breakdown")}</h4>
            {detail.sections.map((s) => (
              <Section key={s.title} title={s.title} total={s.tokens} rows={s.rows} />
            ))}
          </div>
        )
      ) : (
        !error && (
          <p className="text-muted-foreground flex items-center gap-1.5">
            <Loader className="size-3 animate-spin" />
            {t("context.counting")}
          </p>
        )
      )}
      {error && <p className="text-muted-foreground break-words">{error}</p>}
    </div>
  );
}
