import { Fragment, memo, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Check,
  ChevronRight,
  Circle,
  CircleCheck,
  CircleDot,
  LoaderCircle,
  Minus,
  ShieldCheck,
  ShieldOff,
  ShieldQuestionMark,
  ShieldX,
  X,
} from "lucide-react";
import { api, type Step, type StepDetail } from "./api";
import { CopyIcon, useCopy } from "./copy";
import { useI18n, type Translate } from "./i18n";
import { cn } from "@/lib/utils";

/** How the human answered each call they were asked about, by call id: pending, allowed, denied or expired. */
export type Decisions = ReadonlyMap<string, string>;

/** Absolute paths under the conversation's repo read as relative ones. */
export function relative(text: string, root: string): string {
  const base = root.endsWith("/") ? root : `${root}/`;
  // a repo at the filesystem root would strip every slash
  return base === "/" ? text : text.split(base).join("");
}

/** An MCP tool is known by its own name; the server's is in the tooltip. */
const toolLabel = (name: string) => (name.startsWith("mcp__") ? name.split("__").slice(2).join("__") || name : name);

function duration(t: Translate, ms: number): string {
  const s = Math.max(ms, 0) / 1000;
  if (s < 10) return t("steps.seconds", { value: Math.max(s, 0.1).toFixed(1) });
  const whole = Math.round(s);
  if (whole < 60) return t("steps.seconds", { value: whole });
  return t("steps.minutes", { minutes: Math.floor(whole / 60), seconds: whole % 60 });
}

/** Ticks every second while on, so a running call's clock moves. */
function useNow(on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [on]);
  return now;
}

/** Which tools a group used: the one name, or the most used few with counts. */
function toolNames(steps: Step[]): string {
  const counts = new Map<string, number>();
  for (const s of steps) counts.set(toolLabel(s.name), (counts.get(toolLabel(s.name)) ?? 0) + 1);
  const ranked = [...counts].sort((a, b) => b[1] - a[1]);
  if (ranked.length === 1) return ranked[0]![0];
  const named = ranked.slice(0, 3).map(([name, n]) => (n > 1 ? `${name} ×${n}` : name));
  return ranked.length > 3 ? `${named.join(" · ")} …` : named.join(" · ");
}

/**
 * Consecutive calls fold under one line saying how many, which tools and how
 * long; a lone call is its own row, since a header over it would only say "1".
 */
export function StepsGroup({
  conversationId,
  turnId,
  steps,
  live,
  decisions,
  root,
}: {
  conversationId: string;
  turnId: string;
  steps: Step[];
  /** the turn is still being written, so a call with no result yet is running rather than cut off */
  live: boolean;
  decisions: Decisions;
  root: string;
}) {
  const [open, setOpen] = useState(false);
  const { t } = useI18n();
  const item = (s: Step) => (
    <StepItem
      key={s.id}
      conversationId={conversationId}
      turnId={turnId}
      step={s}
      live={live}
      decision={decisions.get(s.id)}
      root={root}
    />
  );
  if (steps.length === 1) return item(steps[0]!);

  const running = live ? steps.find((s) => s.ok === undefined) : undefined;
  const asking = running !== undefined && decisions.get(running.id) === "pending";
  const failed = steps.filter((s) => s.ok === false).length;
  const start = Math.min(...steps.map((s) => s.startedAt ?? Infinity));
  const end = steps.every((s) => s.endedAt !== undefined) ? Math.max(...steps.map((s) => s.endedAt ?? 0)) : undefined;
  const meta = [
    running ? t("steps.count", { count: steps.length }) : toolNames(steps),
    end !== undefined && Number.isFinite(start) ? duration(t, end - start) : null,
  ].filter(Boolean);
  return (
    <div className="min-w-0">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="text-muted-foreground hover:text-foreground -ml-1.5 flex max-w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-sm transition-colors"
      >
        <ChevronRight className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")} />
        {running &&
          (asking ? (
            <ShieldQuestionMark className="size-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
          ) : (
            <LoaderCircle className="size-3.5 shrink-0 animate-spin" />
          ))}
        <span className="min-w-0 truncate">
          {running ? (
            <>
              <span className="font-mono text-xs">{toolLabel(running.name)}</span>
              {running.title && ` ${relative(running.title, root)}`}
            </>
          ) : (
            t("steps.count", { count: steps.length })
          )}
        </span>
        <span className="shrink-0 whitespace-nowrap">{meta.map((m) => ` · ${m}`)}</span>
        {failed > 0 && (
          <span className="text-destructive shrink-0 whitespace-nowrap">· {t("steps.failed", { count: failed })}</span>
        )}
      </button>
      {open && <div className="ml-[7px] border-l pl-2.5">{steps.map(item)}</div>}
    </div>
  );
}

function Status({ step, live, asking }: { step: Step; live: boolean; asking: boolean }) {
  const { t } = useI18n();
  const base = "size-3.5 shrink-0";
  if (asking) return <ShieldQuestionMark className={cn(base, "text-amber-600 dark:text-amber-400")} />;
  if (step.ok === true) return <Check className={cn(base, "text-muted-foreground")} />;
  if (step.ok === false) return <X className={cn(base, "text-destructive")} />;
  if (live) return <LoaderCircle className={cn(base, "text-muted-foreground animate-spin")} />;
  return (
    <span title={t("steps.unfinished")} className="shrink-0">
      <Minus className={cn(base, "text-muted-foreground/60")} />
    </span>
  );
}

const DECIDED = {
  allowed: { Icon: ShieldCheck, tone: "text-muted-foreground" },
  denied: { Icon: ShieldX, tone: "text-destructive" },
  expired: { Icon: ShieldOff, tone: "text-muted-foreground" },
} as const;

/** An answered permission request, folded into the call it was about. */
function DecisionTag({ status }: { status: string }) {
  const { t } = useI18n();
  if (status !== "allowed" && status !== "denied" && status !== "expired") return null;
  const { Icon, tone } = DECIDED[status];
  return (
    <span className={cn("bg-muted inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-px text-[11px]", tone)}>
      <Icon className="size-3" />
      {status === "expired" ? t("steps.expired") : t(`cards.decided.${status}`)}
    </span>
  );
}

const StepItem = memo(function StepItem({
  conversationId,
  turnId,
  step,
  live,
  decision,
  root,
}: {
  conversationId: string;
  turnId: string;
  step: Step;
  live: boolean;
  decision?: string;
  root: string;
}) {
  const [open, setOpen] = useState(false);
  const { t } = useI18n();
  const asking = decision === "pending";
  const running = live && step.ok === undefined && !asking;
  const now = useNow(running);
  const end = step.endedAt ?? (running ? now : undefined);
  const title = step.title && relative(step.title, root);
  return (
    <div className="min-w-0">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        title={step.name}
        className={cn(
          "hover:bg-accent -ml-1.5 flex w-[calc(100%+0.375rem)] min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-left text-sm transition-colors",
          open && "bg-accent/70",
        )}
      >
        <Status step={step} live={live} asking={asking} />
        <span className="text-muted-foreground shrink-0 font-mono text-xs">{toolLabel(step.name)}</span>
        <span className="min-w-0 flex-1 truncate">{title}</span>
        {/* a long command must not push out why it failed */}
        {step.error && <span className="text-destructive max-w-1/2 shrink-0 truncate text-xs">{step.error}</span>}
        {decision && !asking && <DecisionTag status={decision} />}
        {step.startedAt !== undefined && end !== undefined && (
          <span className="text-muted-foreground shrink-0 text-[11px] tabular-nums">{duration(t, end - step.startedAt)}</span>
        )}
      </button>
      {open && <StepBody conversationId={conversationId} turnId={turnId} step={step} running={running} root={root} />}
    </div>
  );
});

/** Outputs can be large, so only the most recently opened stay cached. */
const details = new Map<string, Promise<StepDetail | null>>();

function useDetail(conversationId: string, turnId: string, step: Step): StepDetail | null | undefined {
  // a call that was still running is read again once it has a result
  const key = `${conversationId}\n${turnId}\n${step.id}\n${step.ok ?? ""}`;
  const [got, setGot] = useState<{ key: string; detail: StepDetail | null }>();
  useEffect(() => {
    let alive = true;
    let pending = details.get(key);
    if (!pending) {
      pending = api.step(conversationId, turnId, step.id).catch(() => {
        details.delete(key);
        return null;
      });
      details.set(key, pending);
      const oldest = details.keys().next().value;
      if (details.size > 40 && oldest !== undefined) details.delete(oldest);
    }
    void pending.then((detail) => {
      if (alive) setGot({ key, detail });
    });
    return () => {
      alive = false;
    };
  }, [key, conversationId, turnId, step.id]);
  return got?.key === key ? got.detail : undefined;
}

function StepBody({
  conversationId,
  turnId,
  step,
  running,
  root,
}: {
  conversationId: string;
  turnId: string;
  step: Step;
  running: boolean;
  root: string;
}) {
  const detail = useDetail(conversationId, turnId, step);
  const { t } = useI18n();
  if (detail === undefined) return <LoaderCircle className="text-muted-foreground my-1.5 ml-7 size-3.5 animate-spin" />;
  if (detail === null) return <p className="text-muted-foreground py-1 pl-7 text-xs">{t("steps.loadFailed")}</p>;
  return (
    <div className="flex min-w-0 flex-col gap-2 pt-1 pb-2 pl-7">
      <CallInput input={detail.input} root={root} />
      <CallOutput detail={detail} running={running} />
    </div>
  );
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

function commandOf(input: Record<string, unknown>): string | undefined {
  const command = input["command"];
  if (typeof command === "string") return command;
  // an ACP agent can hand a command over as argv
  return Array.isArray(command) && command.every((p) => typeof p === "string") ? command.join(" ") : undefined;
}

const pathOf = (input: Record<string, unknown>) =>
  str(input["file_path"]) ?? str(input["path"]) ?? str(input["notebook_path"]);

/** Claude Code's Edit and MultiEdit and pi's edit, in both of pi's spellings. */
function editsOf(input: Record<string, unknown>): Array<{ before: string; after: string }> | undefined {
  const one = (e: Record<string, unknown>) => {
    const before = str(e["old_string"]) ?? str(e["oldText"]);
    const after = str(e["new_string"]) ?? str(e["newText"]);
    return before !== undefined && after !== undefined ? [{ before, after }] : [];
  };
  const edits = input["edits"];
  const list = Array.isArray(edits)
    ? edits.flatMap((e: unknown) => (e && typeof e === "object" ? one(e as Record<string, unknown>) : []))
    : one(input);
  return list.length > 0 ? list : undefined;
}

function todosOf(input: Record<string, unknown>): Array<{ content: string; status: string }> | undefined {
  const todos = input["todos"];
  if (!Array.isArray(todos)) return undefined;
  const list = todos.flatMap((todo: unknown) => {
    const t = (todo ?? {}) as Record<string, unknown>;
    const content = str(t["content"]);
    return content ? [{ content, status: str(t["status"]) ?? "pending" }] : [];
  });
  return list.length > 0 ? list : undefined;
}

const lineCount = (text: string) => text.split("\n").length;

/** What a call was given, shown the way that kind of call reads: a command, a diff, a file, a list. */
export function CallInput({ input, root }: { input: Record<string, unknown>; root: string }) {
  const { t } = useI18n();
  const path = pathOf(input);
  const file = path !== undefined ? <span className="font-mono">{relative(path, root)}</span> : undefined;

  const command = commandOf(input);
  if (command !== undefined) {
    return (
      <Block label={t("steps.command")} copy={command}>
        <Lines text={command} limit={4} wrap />
      </Block>
    );
  }
  const edits = editsOf(input);
  if (edits) return <Diff label={file ?? t("steps.changes")} edits={edits} />;
  const content = str(input["content"]);
  if (file && content !== undefined) {
    return (
      <Block label={file} meta={t("steps.lines", { count: lineCount(content) })} copy={content}>
        <Lines text={content} limit={12} />
      </Block>
    );
  }
  const todos = todosOf(input);
  if (todos) return <Todos todos={todos} />;

  const entries = Object.entries(input);
  if (entries.length === 0) return null;
  return (
    <Block label={t("steps.parameters")} copy={JSON.stringify(input, null, 2)}>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 px-2.5 py-2 font-mono text-xs leading-relaxed">
        {entries.map(([key, value]) => (
          <Fragment key={key}>
            <dt className="text-muted-foreground">{key}</dt>
            <dd className="break-words whitespace-pre-wrap">
              <Clamped text={typeof value === "string" ? relative(value, root) : JSON.stringify(value, null, 2)} limit={6} />
            </dd>
          </Fragment>
        ))}
      </dl>
    </Block>
  );
}

const size = (chars: number) => (chars < 1024 * 1024 ? `${Math.round(chars / 1024)} KB` : `${(chars / 1024 / 1024).toFixed(1)} MB`);

function CallOutput({ detail, running }: { detail: StepDetail; running: boolean }) {
  const { t } = useI18n();
  if (detail.output === undefined) {
    if (!running) return null;
    return (
      <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
        <LoaderCircle className="size-3 animate-spin" />
        {t("steps.running")}
      </p>
    );
  }
  const output = detail.output.replace(/\n+$/, "");
  return (
    <Block
      label={detail.isError ? t("steps.error") : t("steps.output")}
      meta={output ? t("steps.lines", { count: lineCount(output) }) : undefined}
      copy={output || undefined}
      tone={detail.isError ? "error" : undefined}
    >
      {output ? (
        <Lines text={output} limit={12} />
      ) : (
        <p className="text-muted-foreground px-2.5 py-2 text-xs">{t("steps.noOutput")}</p>
      )}
      {detail.size !== undefined && (
        <p className="text-muted-foreground border-t px-2.5 py-1 text-[11px]">
          {t("steps.truncated", { size: size(detail.output.length) })}
        </p>
      )}
    </Block>
  );
}

function Block({
  label,
  meta,
  copy,
  tone,
  children,
}: {
  label: ReactNode;
  meta?: ReactNode;
  copy?: string;
  tone?: "error";
  children: ReactNode;
}) {
  const { t } = useI18n();
  const { copied, copy: write } = useCopy();
  return (
    <div className={cn("bg-background min-w-0 overflow-hidden rounded-lg border", tone === "error" && "border-destructive/30")}>
      <div
        className={cn(
          "flex items-center gap-2 border-b px-2.5 py-1 text-[11px]",
          tone === "error" ? "bg-destructive/5 text-destructive" : "bg-muted/50 text-muted-foreground",
        )}
      >
        <span className="min-w-0 truncate">{label}</span>
        {meta && <span className="shrink-0">{meta}</span>}
        {copy !== undefined && (
          <button
            type="button"
            onClick={() => void write(copy)}
            title={t("common.copy")}
            className="hover:text-foreground ml-auto shrink-0 rounded p-0.5"
          >
            <CopyIcon copied={copied} className="size-3" />
          </button>
        )}
      </div>
      {children}
    </div>
  );
}

/** The first lines of something long, and a way to see the rest; hiding one or two lines saves nothing. */
function Lines({ text, limit, wrap = false }: { text: string; limit: number; wrap?: boolean }) {
  const [all, setAll] = useState(false);
  const { t } = useI18n();
  const lines = useMemo(() => text.split("\n"), [text]);
  const long = lines.length > limit + 2;
  return (
    <>
      <pre
        className={cn(
          "overflow-x-auto px-2.5 py-2 font-mono text-xs leading-relaxed",
          // a command reads as prose; output keeps its columns
          wrap ? "break-words whitespace-pre-wrap" : "whitespace-pre",
          all && "max-h-[32rem] overflow-y-auto",
        )}
      >
        {long && !all ? lines.slice(0, limit).join("\n") : text}
      </pre>
      {long && <MoreButton all={all} count={lines.length} onClick={() => setAll(!all)} />}
    </>
  );
}

function MoreButton({ all, count, onClick }: { all: boolean; count: number; onClick: () => void }) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-muted-foreground hover:text-foreground w-full border-t px-2.5 py-1 text-left text-[11px]"
    >
      {all ? t("steps.showLess") : t("steps.showAll", { count })}
    </button>
  );
}

function Clamped({ text, limit }: { text: string; limit: number }) {
  const [all, setAll] = useState(false);
  const { t } = useI18n();
  const lines = text.split("\n");
  if (all || lines.length <= limit + 2) return <>{text}</>;
  return (
    <>
      {lines.slice(0, limit).join("\n")}
      {"\n"}
      <button type="button" onClick={() => setAll(true)} className="text-muted-foreground hover:text-foreground font-sans">
        {t("steps.showAll", { count: lines.length })}
      </button>
    </>
  );
}

type DiffLine = { op: "=" | "-" | "+"; text: string };

/** A line diff by longest common subsequence; an edit's two sides are small, so the table stays cheap. */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.split("\n");
  const b = after.split("\n");
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const x = a.slice(head, a.length - tail);
  const y = b.slice(head, b.length - tail);
  const same = (text: string): DiffLine => ({ op: "=", text });
  const middle: DiffLine[] = [];
  if (x.length * y.length > 250_000) {
    // too big to align; the old lines then the new still read as a replacement
    middle.push(...x.map((text): DiffLine => ({ op: "-", text })), ...y.map((text): DiffLine => ({ op: "+", text })));
  } else {
    const w = y.length + 1;
    const lcs = new Uint32Array((x.length + 1) * w);
    for (let i = x.length - 1; i >= 0; i--) {
      for (let j = y.length - 1; j >= 0; j--) {
        lcs[i * w + j] = x[i] === y[j] ? lcs[(i + 1) * w + j + 1]! + 1 : Math.max(lcs[(i + 1) * w + j]!, lcs[i * w + j + 1]!);
      }
    }
    let i = 0;
    let j = 0;
    while (i < x.length && j < y.length) {
      if (x[i] === y[j]) {
        middle.push(same(x[i]!));
        i++;
        j++;
      } else if (lcs[(i + 1) * w + j]! >= lcs[i * w + j + 1]!) {
        middle.push({ op: "-", text: x[i++]! });
      } else {
        middle.push({ op: "+", text: y[j++]! });
      }
    }
    while (i < x.length) middle.push({ op: "-", text: x[i++]! });
    while (j < y.length) middle.push({ op: "+", text: y[j++]! });
  }
  return [...a.slice(0, head).map(same), ...middle, ...a.slice(a.length - tail).map(same)];
}

function Diff({ label, edits }: { label: ReactNode; edits: Array<{ before: string; after: string }> }) {
  const [all, setAll] = useState(false);
  // null separates one edit's lines from the next
  const lines = useMemo(
    () => edits.flatMap((e, i): Array<DiffLine | null> => [...(i > 0 ? [null] : []), ...diffLines(e.before, e.after)]),
    [edits],
  );
  const added = lines.filter((l) => l?.op === "+").length;
  const removed = lines.filter((l) => l?.op === "-").length;
  const limit = 40;
  const long = lines.length > limit + 2;
  const unified = lines.map((l) => (l ? `${l.op === "=" ? " " : l.op}${l.text}` : "...")).join("\n");
  return (
    <Block
      label={label}
      meta={
        <>
          <span className="text-emerald-600 dark:text-emerald-400">+{added}</span>{" "}
          <span className="text-destructive">−{removed}</span>
        </>
      }
      copy={unified}
    >
      <div className={cn("py-1 font-mono text-xs leading-relaxed", all && "max-h-[32rem] overflow-y-auto")}>
        {(long && !all ? lines.slice(0, limit) : lines).map((l, i) =>
          l === null ? (
            <div key={i} className="text-muted-foreground px-2.5">
              ⋯
            </div>
          ) : (
            <div
              key={i}
              className={cn(
                "flex px-2.5",
                l.op === "+" && "bg-emerald-500/10 text-emerald-800 dark:text-emerald-300",
                l.op === "-" && "bg-red-500/10 text-red-800 dark:text-red-300",
              )}
            >
              <span className="w-4 shrink-0 opacity-60 select-none">{l.op === "=" ? "" : l.op === "-" ? "−" : "+"}</span>
              <span className="min-w-0 break-words whitespace-pre-wrap">{l.text || " "}</span>
            </div>
          ),
        )}
      </div>
      {long && <MoreButton all={all} count={lines.length} onClick={() => setAll(!all)} />}
    </Block>
  );
}

function Todos({ todos }: { todos: Array<{ content: string; status: string }> }) {
  return (
    <ul className="space-y-1 rounded-lg border px-2.5 py-2 text-xs">
      {todos.map((todo, i) => (
        <li key={i} className="flex items-start gap-2">
          {todo.status === "completed" ? (
            <CircleCheck className="text-muted-foreground mt-px size-3.5 shrink-0" />
          ) : todo.status === "in_progress" ? (
            <CircleDot className="text-primary mt-px size-3.5 shrink-0" />
          ) : (
            <Circle className="text-muted-foreground/60 mt-px size-3.5 shrink-0" />
          )}
          <span className={cn(todo.status === "completed" && "text-muted-foreground line-through")}>{todo.content}</span>
        </li>
      ))}
    </ul>
  );
}
