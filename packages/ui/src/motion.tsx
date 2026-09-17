import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Presence } from "radix-ui/internal";
import { cn } from "@/lib/utils";

/** How a page or a pane arrives: it settles up into place. Keyed on what it shows, it plays again when that changes. */
export const PAGE_IN = "animate-in fade-in-0 slide-in-from-bottom-1 duration-200 ease-soft";

/** How a swapped icon or a mark arrives: it grows into its slot. */
export const ICON_IN = "animate-in fade-in-0 zoom-in-50 duration-150 ease-soft";

/** How something floating comes and goes: it lifts in and drops out. */
const POP =
  "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=open]:slide-in-from-bottom-1 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=closed]:slide-out-to-bottom-1 duration-150 ease-soft";

/**
 * Something that unfolds in the flow of a page: a bar over the composer, a
 * section of a form. Folded, it stays in the DOM at no height, so what is
 * around it eases instead of jumping, and it keeps what it last showed for
 * the moment it takes to fold away.
 */
export function Collapse({ open, className, children }: { open: boolean; className?: string; children?: ReactNode }) {
  // read during render on purpose: what was shown last is what folds away
  const last = useRef<ReactNode>(null);
  if (open && children != null) last.current = children;
  // settled: the fold in the current direction has ended; clipping and hiding only apply then
  const [settled, setSettled] = useState(true);
  const [was, setWas] = useState(open);
  if (was !== open) {
    setWas(open);
    setSettled(false);
  }
  return (
    <div
      inert={!open || undefined}
      onTransitionEnd={(e) => {
        if (e.target === e.currentTarget) setSettled(true);
      }}
      className={cn(
        "grid transition-[grid-template-rows] duration-200 ease-soft",
        open ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
        className,
      )}
    >
      {/* clipped only while moving: a focus ring on a field inside must not be cut once it is open */}
      {/* min-w-0: a grid item is otherwise as wide as its widest unbreakable line, and a truncated one is unbreakable */}
      <div className={cn("min-h-0 min-w-0", !(open && settled) && "overflow-hidden", !open && settled && "invisible")}>
        {open ? children : last.current}
      </div>
    </div>
  );
}

/**
 * Something floating that is there or not: a list over the composer. It
 * leaves the DOM only once its exit has played.
 */
export function Pop({ open, className, children }: { open: boolean; className?: string; children?: ReactNode }) {
  const last = useRef<ReactNode>(null);
  if (open && children != null) last.current = children;
  return (
    <Presence.Presence present={open}>
      <div data-state={open ? "open" : "closed"} className={cn(POP, className)}>
        {open ? children : last.current}
      </div>
    </Presence.Presence>
  );
}

/** Whether an element is at least so wide, kept current as it resizes; pass the ref back to the element. */
export function useAtLeast(px: number): [boolean, (el: HTMLElement | null) => void] {
  const [el, setEl] = useState<HTMLElement | null>(null);
  const [ok, setOk] = useState(true);
  useLayoutEffect(() => {
    if (!el) return;
    const measure = () => setOk(el.clientWidth >= px);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [el, px]);
  return [ok, setEl];
}
