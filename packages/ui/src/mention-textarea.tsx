import { useRef, useState, type ComponentProps, type ReactNode } from "react";
import { MENTION } from "./markdown";
import { segments } from "./mentions";
import { cn } from "@/lib/utils";

type Range = { start: number; end: number };

/** The draft as runs: mentions marked, and what an IME is still composing underlined. */
function runs(text: string, names: readonly string[], composing: Range | null): ReactNode[] {
  const out: ReactNode[] = [];
  let at = 0;
  segments(text, names).forEach((s, i) => {
    const end = at + s.text.length;
    const cuts = [at, ...(composing ? [composing.start, composing.end].filter((c) => c > at && c < end) : []), end];
    for (let j = 1; j < cuts.length; j++) {
      const from = cuts[j - 1]!;
      const to = cuts[j]!;
      const underline = composing !== null && from >= composing.start && to <= composing.end;
      out.push(
        s.mention || underline ? (
          // the chip's padding without moving the text: the negative margin takes it back; weight would move it too
          <span key={`${i}-${j}`} className={cn(s.mention && `${MENTION} -mx-0.5 px-0.5`, underline && "underline")}>
            {text.slice(from, to)}
          </span>
        ) : (
          text.slice(from, to)
        ),
      );
    }
    at = end;
  });
  return out;
}

/**
 * A textarea that highlights @mentions as they are typed. A textarea cannot
 * colour part of its text, so its own is transparent and a copy laid exactly
 * under it shows through; the textarea still draws the caret and selection.
 */
export function MentionTextarea({
  names,
  className = "",
  onScroll,
  onCompositionStart,
  onCompositionUpdate,
  onCompositionEnd,
  ...props
}: ComponentProps<"textarea"> & { names: readonly string[] }) {
  const copy = useRef<HTMLDivElement>(null);
  // Chromium underlines a composition in the text colour, which is transparent here
  const [composing, setComposing] = useState<Range | null>(null);
  const text = String(props.value ?? "");
  // joined, not cn(): tailwind-merge takes text-message for a colour and drops it for text-transparent.
  // The same gutter on both, or a classic scrollbar would wrap the two differently.
  const shared = `${className} [scrollbar-gutter:stable]`;
  return (
    <div className="relative">
      <div ref={copy} aria-hidden className={`${shared} pointer-events-none absolute inset-0 overflow-hidden break-words whitespace-pre-wrap`}>
        {runs(text, names, composing)}
        {/* a textarea gives a trailing newline a line of its own; a div only once something follows it */}
        {text.endsWith("\n") && " "}
      </div>
      <textarea
        {...props}
        onScroll={(e) => {
          if (copy.current) copy.current.scrollTop = e.currentTarget.scrollTop;
          onScroll?.(e);
        }}
        onCompositionStart={(e) => {
          const at = e.currentTarget.selectionStart;
          setComposing({ start: at, end: at });
          onCompositionStart?.(e);
        }}
        onCompositionUpdate={(e) => {
          setComposing((c) => c && { start: c.start, end: c.start + e.data.length });
          onCompositionUpdate?.(e);
        }}
        onCompositionEnd={(e) => {
          setComposing(null);
          onCompositionEnd?.(e);
        }}
        className={`${shared} relative text-transparent caret-foreground`}
      />
    </div>
  );
}
