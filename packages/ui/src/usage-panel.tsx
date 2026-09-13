import { useState } from "react";
import { ArrowRight, ChevronRight } from "lucide-react";
import type { ContextUse, Quota, QuotaWindow } from "./api";
import { ContextBar, tokens } from "./context-panel";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Within a day the countdown matters; past it, the day and time do. */
function resets(at: number): string {
  const mins = Math.max(1, Math.ceil((at - Date.now()) / 60_000));
  if (mins < 24 * 60) {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return `Resets in ${[h > 0 && `${h} hr`, (m > 0 || h === 0) && `${m} min`].filter(Boolean).join(" ")}`;
  }
  // a reset lands on the minute; the seconds the backend carries would round it down
  const d = new Date(Math.round(at / 60_000) * 60_000);
  const day = d.toLocaleDateString("en-US", { weekday: "short" });
  return `Resets ${day} ${d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`;
}

const windowLabel = (w: QuotaWindow) => (w.kind === "session" ? "5-hour limit" : `Weekly · ${w.scope ?? "all models"}`);

/** A window past its reset is a fresh one; what was held for it counted usage that no longer stands. */
const current = (w: QuotaWindow): QuotaWindow =>
  w.resetsAt !== undefined && w.resetsAt <= Date.now() ? { kind: w.kind, ...(w.scope ? { scope: w.scope } : {}), usedPercent: 0 } : w;

function Meter({ percent }: { percent: number }) {
  return (
    <div className="bg-muted h-1.5 w-full overflow-hidden rounded-full">
      <div className="h-full rounded-full bg-blue-500" style={{ width: `${Math.min(100, Math.max(0, percent))}%` }} />
    </div>
  );
}

/** Filled by the share in use. */
function Ring({ percent }: { percent: number }) {
  const r = 6;
  const c = 2 * Math.PI * r;
  const tone = percent >= 90 ? "text-destructive" : percent >= 70 ? "text-amber-500" : "text-blue-500";
  return (
    <svg viewBox="0 0 16 16" className={cn("size-4 shrink-0 -rotate-90", tone)} aria-hidden>
      <circle cx="8" cy="8" r={r} fill="none" strokeWidth="2.5" className="stroke-current opacity-20" />
      <circle
        cx="8"
        cy="8"
        r={r}
        fill="none"
        strokeWidth="2.5"
        strokeLinecap="round"
        className="stroke-current"
        strokeDasharray={`${(Math.min(100, Math.max(0, percent)) / 100) * c} ${c}`}
      />
    </svg>
  );
}

/**
 * The ring at the end of the composer bar and what sits behind it: how full the
 * context is, in Roster's own terms, and how much of the plan is left, in the
 * backend's. A group has no single context, so there the ring tracks the plan.
 */
export function UsagePanel({
  owner,
  context,
  quota,
  busy,
  onOpen,
  onCompact,
  onDetail,
}: {
  /** whose plan this is, when the plan itself carries no name */
  owner: string | undefined;
  context: ContextUse | undefined;
  quota: Quota | null | undefined;
  busy: boolean;
  /** plan usage is only re-read when something asks for it, and opening the panel is the ask */
  onOpen: () => void;
  onCompact: (() => void) | undefined;
  onDetail: (() => void) | undefined;
}) {
  const [open, setOpen] = useState(false);
  const windows = (quota?.windows ?? []).map(current);
  if (!context && windows.length === 0) return null;
  const tightest = windows.reduce<QuotaWindow | undefined>((a, b) => (!a || b.usedPercent > a.usedPercent ? b : a), undefined);
  const showDetail = () => {
    setOpen(false);
    onDetail?.();
  };

  return (
    <>
      <Popover
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (next) onOpen();
        }}
      >
        <PopoverTrigger
          className="hover:bg-accent data-[state=open]:bg-accent focus-visible:ring-ring/50 inline-flex size-7 items-center justify-center rounded-lg outline-none focus-visible:ring-2"
          aria-label={context ? `上下文已用 ${context.percent}%` : "套餐用量"}
        >
          <Ring percent={context ? context.percent : (tightest?.usedPercent ?? 0)} />
        </PopoverTrigger>
        <PopoverContent side="top" align="end" className="w-[400px] max-w-[calc(100vw-2rem)] rounded-xl p-0 text-sm">
          {context && (
            <div className="space-y-2.5 p-4">
              <button
                type="button"
                onClick={onDetail ? showDetail : undefined}
                className="text-muted-foreground hover:text-foreground flex w-full items-center justify-between gap-2"
              >
                <span>上下文</span>
                <span className="flex items-center gap-1 tabular-nums">
                  {tokens(context.used)} / {tokens(context.max)}（{context.percent}%）
                  {onDetail && <ChevronRight className="size-4" />}
                </span>
              </button>
              <ContextBar context={context} />
              <div className="flex items-center justify-between gap-2">
                <span className="truncate">
                  {context.autoCompactAt ? `到 ${context.autoCompactAt}% 自动压缩` : "不会自动压缩"}
                </span>
                {onCompact && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      setOpen(false);
                      onCompact();
                    }}
                    className="shrink-0 text-blue-600 underline decoration-blue-600/30 underline-offset-4 hover:decoration-blue-600 disabled:cursor-not-allowed disabled:opacity-40 dark:text-blue-400"
                  >
                    压缩会话
                  </button>
                )}
              </div>
            </div>
          )}
          {windows.length > 0 && (
            <div className={cn("space-y-3 p-4", context && "border-t")}>
              <a
                href={quota?.url}
                target="_blank"
                rel="noreferrer noopener"
                className={cn("text-muted-foreground flex items-center justify-between", quota?.url ? "hover:text-foreground" : "pointer-events-none")}
              >
                <span>
                  Plan usage limits{quota?.plan ? ` · ${capitalize(quota.plan)}` : owner ? ` · ${owner}` : ""}
                </span>
                {quota?.url && <ArrowRight className="size-4" />}
              </a>
              {windows.map((w) => (
                <div key={`${w.kind}-${w.scope ?? ""}`} className="space-y-1.5">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="truncate">{windowLabel(w)}</span>
                    <span className="text-muted-foreground flex shrink-0 gap-3 tabular-nums">
                      {w.resetsAt && <span>{resets(w.resetsAt)}</span>}
                      <span>{Math.round(w.usedPercent)}%</span>
                    </span>
                  </div>
                  <Meter percent={w.usedPercent} />
                </div>
              ))}
            </div>
          )}
          {context && onDetail && (
            <button type="button" onClick={showDetail} className="hover:bg-accent w-full rounded-b-xl border-t px-4 py-3 text-left">
              查看明细
            </button>
          )}
        </PopoverContent>
      </Popover>
    </>
  );
}
