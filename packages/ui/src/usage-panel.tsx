import { useEffect, useState } from "react";
import { ArrowUpRight, Layers, Shrink } from "lucide-react";
import type { ContextUse, Quota, QuotaWindow } from "./api";
import { ContextBar, ContextBreakdown, partColor, tokens, type Slice } from "./context-breakdown";
import { useI18n, type I18n, type Translate } from "./i18n";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

const clamp = (percent: number) => Math.min(100, Math.max(0, percent));

type Level = "normal" | "warn" | "bad";

/** The ring, the badge and every meter change colour at the same two marks. */
const levelOf = (percent: number): Level => (percent >= 90 ? "bad" : percent >= 70 ? "warn" : "normal");

const STROKE: Record<Level, string> = { normal: "text-primary", warn: "text-amber-500", bad: "text-destructive" };
const FILL: Record<Level, string> = { normal: "bg-primary", warn: "bg-amber-500", bad: "bg-destructive" };
const TEXT: Record<Level, string> = { normal: "", warn: "text-amber-600 dark:text-amber-400", bad: "text-destructive" };
const BADGE: Record<Level, string> = {
  normal: "bg-primary/10 text-primary",
  warn: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  bad: "bg-destructive/10 text-destructive",
};

/** Within a day the countdown matters; past it, the day and time do. */
function resetLabel({ t, locale, clock }: Pick<I18n, "t" | "locale" | "clock">, at: number): string {
  const mins = Math.max(1, Math.ceil((at - Date.now()) / 60_000));
  if (mins < 24 * 60) {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    const time = [h > 0 && t("usage.hours", { count: h }), (m > 0 || h === 0) && t("usage.minutes", { count: m })];
    return t("usage.resetsIn", { time: time.filter(Boolean).join(" ") });
  }
  // a reset lands on the minute; the seconds the backend carries would round it down
  const d = Math.round(at / 60_000) * 60_000;
  const day = new Intl.DateTimeFormat(locale, { weekday: "short" }).format(d);
  return t("usage.resetsAt", { when: `${day} ${clock(d)}` });
}

const windowLabel = (t: Translate, w: QuotaWindow) =>
  w.kind === "session" ? t("usage.session") : w.scope ? t("usage.weeklyScoped", { scope: w.scope }) : t("usage.weekly");

/** A window past its reset is a fresh one; what was held for it counted usage that no longer stands. */
const current = (w: QuotaWindow): QuotaWindow =>
  w.resetsAt !== undefined && w.resetsAt <= Date.now() ? { kind: w.kind, ...(w.scope ? { scope: w.scope } : {}), usedPercent: 0 } : w;

const NAMED = 3;
const REST = "bg-muted-foreground/40";

/**
 * The largest few in the side panel's colours; past four, the rest share one
 * grey slice, so every colour in the bar is named under it.
 */
function slicesOf(context: ContextUse, t: Translate): Slice[] {
  const parts = context.parts ?? [];
  const named = parts.length > NAMED + 1 ? parts.slice(0, NAMED) : parts;
  const rest = parts.slice(named.length).reduce((n, p) => n + p.tokens, 0);
  return [
    ...named.map((p, i) => ({ ...p, color: partColor(i) })),
    ...(rest > 0 ? [{ name: t("usage.other"), tokens: rest, color: REST }] : []),
  ];
}

/** Filled by the share in use. */
function Ring({ percent, className }: { percent: number; className?: string }) {
  const r = 6;
  const c = 2 * Math.PI * r;
  return (
    <svg viewBox="0 0 16 16" className={cn("size-4 shrink-0 -rotate-90 transition-colors duration-300", STROKE[levelOf(percent)], className)} aria-hidden>
      <circle cx="8" cy="8" r={r} fill="none" strokeWidth="2.5" className="stroke-current opacity-20" />
      {/* the arc sweeps to its new share rather than jumping */}
      <circle
        cx="8"
        cy="8"
        r={r}
        fill="none"
        strokeWidth="2.5"
        strokeLinecap="round"
        className="stroke-current transition-[stroke-dasharray] duration-300 ease-soft"
        strokeDasharray={`${(clamp(percent) / 100) * c} ${c}`}
      />
    </svg>
  );
}

function Meter({ percent, className }: { percent: number; className?: string }) {
  return (
    <div className={cn("bg-muted h-1.5 w-full overflow-hidden rounded-full", className)}>
      <div className={cn("h-full rounded-full transition-[width,background-color] duration-300 ease-soft", FILL[levelOf(percent)])} style={{ width: `${clamp(percent)}%` }} />
    </div>
  );
}

const ACTION = "hover:bg-foreground/[0.08] h-8 flex-1 rounded-lg font-normal [&_svg]:size-3.5";

/** Whose context a card shows, so what is inside it can be counted. */
type ContextOwner = { conversationId: string; memberId: string };

function ContextSection({
  name,
  context,
  busy,
  member,
  expanded,
  onExpand,
  onCompact,
}: {
  name: string | undefined;
  context: ContextUse;
  busy: boolean;
  member: ContextOwner | undefined;
  expanded: boolean;
  onExpand: (expanded: boolean) => void;
  onCompact: (() => void) | undefined;
}) {
  const { t } = useI18n();
  // a backend that names no categories has nothing inside them to count either
  const canExpand = member !== undefined && Boolean(context.parts?.length);
  const open = expanded && canExpand;
  const slices = slicesOf(context, t);
  // a threshold of 0 is no threshold
  const compactAt = context.autoCompactAt || undefined;
  return (
    <section className="flex min-h-0 flex-col px-2.5 pt-2 pb-2.5">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-muted-foreground min-w-0 truncate text-xs font-medium">
          {name ? `${t("context.title")} · ${name}` : t("context.title")}
        </h3>
        <span className="text-muted-foreground min-w-0 truncate text-[11px]">
          {compactAt ? t("usage.autoCompact", { percent: compactAt }) : t("usage.noAutoCompact")}
        </span>
      </div>
      <div className="mt-1.5 flex items-baseline gap-1">
        <span className="text-xl font-semibold tracking-tight tabular-nums">{tokens(context.used)}</span>
        <span className="text-muted-foreground text-xs tabular-nums">/ {tokens(context.max)}</span>
        <span className={cn("ml-auto rounded-md px-1.5 py-0.5 text-xs font-medium tabular-nums", BADGE[levelOf(context.percent)])}>
          {context.percent}%
        </span>
      </div>
      {/* opened, every category is listed, so none of them is folded into the grey slice; a reserve drawn at the end already marks the threshold */}
      <ContextBar
        context={context}
        slices={!open && slices.length > 0 ? slices : undefined}
        marker={context.reserved ? undefined : compactAt}
        className="mt-2.5 h-2 shrink-0"
      />
      {open ? (
        <ContextBreakdown
          context={context}
          conversationId={member.conversationId}
          memberId={member.memberId}
          // the fade covers only the padding at rest, so rows soften only while they scroll past the edges
          className="animate-in fade-in-0 -mx-2.5 mt-1 max-h-80 min-h-0 overflow-y-auto px-2.5 py-2 duration-200 [mask-image:linear-gradient(to_bottom,transparent,black_0.5rem,black_calc(100%_-_0.5rem),transparent)]"
        />
      ) : (
        slices.length > 0 && (
          <ul className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
            {slices.map((s) => (
              <li key={s.name} className="flex min-w-0 items-center gap-1.5">
                <span className={cn("size-2 shrink-0 rounded-full", s.color)} />
                <span className="text-muted-foreground min-w-0 flex-1 truncate">{s.name}</span>
                <span className="shrink-0 tabular-nums">{tokens(s.tokens)}</span>
              </li>
            ))}
          </ul>
        )
      )}
      {(onCompact || canExpand) && (
        <div className={cn("flex gap-2", open ? "mt-1" : "mt-3")}>
          {onCompact && (
            <Button variant="secondary" size="sm" disabled={busy} onClick={onCompact} className={ACTION}>
              <Shrink />
              {t("usage.compact")}
            </Button>
          )}
          {canExpand && (
            <Button
              variant="secondary"
              size="sm"
              aria-expanded={open}
              onClick={() => onExpand(!open)}
              className={cn(ACTION, "aria-expanded:bg-selected aria-expanded:text-primary aria-expanded:hover:bg-primary/15")}
            >
              <Layers />
              {open ? t("usage.hideDetail") : t("usage.detail")}
            </Button>
          )}
        </div>
      )}
    </section>
  );
}

function PlanSection({ quota, owner, windows }: { quota: Quota | null | undefined; owner: string | undefined; windows: QuotaWindow[] }) {
  const i18n = useI18n();
  const { t } = i18n;
  const name = quota?.plan ? capitalize(quota.plan) : owner;
  const title = name ? `${t("usage.plan")} · ${name}` : t("usage.plan");
  return (
    <section className="px-2.5 pt-2 pb-2">
      {quota?.url ? (
        <a
          href={quota.url}
          target="_blank"
          rel="noreferrer noopener"
          className="text-muted-foreground hover:text-foreground flex items-center justify-between gap-3 text-xs font-medium transition-colors"
        >
          <span className="truncate">{title}</span>
          <ArrowUpRight className="size-3.5 shrink-0" />
        </a>
      ) : (
        <h3 className="text-muted-foreground truncate text-xs font-medium">{title}</h3>
      )}
      <div className="mt-2.5 space-y-3">
        {windows.map((w) => {
          const level = levelOf(w.usedPercent);
          return (
            <div key={`${w.kind}-${w.scope ?? ""}`}>
              <div className="flex items-baseline gap-2">
                <span className="min-w-0 flex-1 truncate text-[13px]">{windowLabel(t, w)}</span>
                {w.resetsAt ? (
                  <span className="text-muted-foreground shrink-0 text-[11px] tabular-nums">{resetLabel(i18n, w.resetsAt)}</span>
                ) : null}
                <span className={cn("w-9 shrink-0 text-right text-xs font-medium tabular-nums", TEXT[level])}>
                  {Math.round(w.usedPercent)}%
                </span>
              </div>
              <Meter percent={w.usedPercent} className="mt-1.5" />
            </div>
          );
        })}
      </div>
    </section>
  );
}

/**
 * The ring by the send button and what sits behind it: how full the
 * context is, in Roster's own terms, and how much of the plan is left, in the
 * backend's. With no context to show, the ring tracks the plan.
 */
export function UsagePanel({
  owner,
  name,
  context,
  quota,
  busy,
  member,
  openWhen,
  onOpen,
  onCompact,
  dense = false,
}: {
  /** whose plan this is, when the plan itself carries no name */
  owner: string | undefined;
  /** whose context this is, where there is more than one it could be */
  name?: string;
  context: ContextUse | undefined;
  quota: Quota | null | undefined;
  busy: boolean;
  /** absent where no one session holds the context */
  member: ContextOwner | undefined;
  /** a nonce: each new value opens the card with what is inside the context laid out */
  openWhen?: number;
  /** plan usage is only re-read when something asks for it, and opening the panel is the ask */
  onOpen: () => void;
  onCompact: (() => void) | undefined;
  /** sized for a list row */
  dense?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const { t } = useI18n();
  const show = (next: boolean) => {
    setOpen(next);
    // counting what is inside costs the backend a request, so a card opened again starts folded
    if (next) onOpen();
    else setExpanded(false);
  };
  useEffect(() => {
    if (!openWhen) return;
    show(true);
    setExpanded(true);
  }, [openWhen]);
  const windows = (quota?.windows ?? []).map(current);
  if (!context && windows.length === 0) return null;
  const tightest = windows.reduce<QuotaWindow | undefined>((a, b) => (!a || b.usedPercent > a.usedPercent ? b : a), undefined);
  const percent = Math.round(context ? context.percent : (tightest?.usedPercent ?? 0));

  return (
    <Popover open={open} onOpenChange={show}>
      <PopoverTrigger
        className={cn(
          "text-muted-foreground hover:bg-accent hover:text-foreground aria-expanded:bg-accent aria-expanded:text-foreground focus-visible:ring-ring/50 inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-2 text-xs tabular-nums outline-none transition-colors focus-visible:ring-2",
          dense && "h-6 gap-1 rounded-md px-1.5 text-[11px]",
        )}
        aria-label={context ? t("usage.contextUsed", { percent: context.percent }) : t("usage.planUsed", { percent })}
      >
        <Ring percent={percent} className={dense ? "size-3.5" : undefined} />
        {/* the figure goes first when the composer is narrow; the ring alone still reads as how full */}
        <span className={cn(!dense && "@max-sm:hidden", TEXT[levelOf(percent)])}>{percent}%</span>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        sideOffset={8}
        collisionPadding={12}
        className="flex max-h-(--radix-popover-content-available-height) w-80 flex-col rounded-xl p-1.5"
        // the card itself takes focus, not its first button: an Enter meant for /context must not compact
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          (e.currentTarget as HTMLElement).focus();
        }}
      >
        {context && (
          <ContextSection
            name={name}
            context={context}
            busy={busy}
            member={member}
            expanded={expanded}
            onExpand={setExpanded}
            onCompact={
              onCompact &&
              (() => {
                show(false);
                onCompact();
              })
            }
          />
        )}
        {context && windows.length > 0 && <Separator className="my-1" />}
        {windows.length > 0 && <PlanSection quota={quota} owner={owner} windows={windows} />}
      </PopoverContent>
    </Popover>
  );
}
