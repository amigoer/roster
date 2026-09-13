import { useCallback, useEffect, useState } from "react";
import { NO_DRAG } from "./app-region";
import { cn } from "@/lib/utils";

/**
 * Column widths are pixels, not percentages: a nav rail that grows when the
 * window is maximized is wrong, and percentage-based panels do exactly that.
 */
export function useColumnWidth(key: string, initial: number, min: number, max: number) {
  const [width, setWidth] = useState(() => {
    try {
      const saved = Number(localStorage.getItem(key));
      if (Number.isFinite(saved) && saved >= min && saved <= max) return saved;
    } catch {
      // private windows and cleared site data both land here
    }
    return initial;
  });

  const set = useCallback(
    (n: number) => setWidth(Math.round(Math.min(max, Math.max(min, n)))),
    [min, max],
  );

  useEffect(() => {
    try {
      localStorage.setItem(key, String(width));
    } catch {
      // a width that cannot be remembered is still a width that works
    }
  }, [key, width]);

  const reset = useCallback(() => setWidth(initial), [initial]);
  return { width, set, reset };
}

/**
 * The gap between two panels, doubling as the handle that resizes them. It draws
 * nothing until hovered: a divider line is exactly what the gap replaces. onDrag
 * gets the x the gap's centre should move to, from the pointer or the arrow keys.
 */
export function Resizer({
  onDrag,
  onReset,
  label,
}: {
  onDrag: (clientX: number) => void;
  onReset: () => void;
  label: string;
}) {
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    if (!dragging) return;
    // the pointer leaves the handle during a drag; without these it flickers and selects text across panes
    const prevCursor = document.body.style.cursor;
    const prevSelect = document.body.style.userSelect;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    return () => {
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevSelect;
    };
  }, [dragging]);

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      tabIndex={0}
      data-dragging={dragging || undefined}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        // capture, not window listeners: a release outside the window must still end the drag
        e.currentTarget.setPointerCapture(e.pointerId);
        setDragging(true);
      }}
      onPointerMove={(e) => {
        if (e.currentTarget.hasPointerCapture(e.pointerId)) onDrag(e.clientX);
      }}
      onPointerUp={(e) => e.currentTarget.releasePointerCapture(e.pointerId)}
      onLostPointerCapture={() => setDragging(false)}
      onDoubleClick={onReset}
      onKeyDown={(e) => {
        // keyboard resize, because a mouse-only handle is not reachable
        const step = e.shiftKey ? 24 : 8;
        const r = e.currentTarget.getBoundingClientRect();
        const mid = r.left + r.width / 2;
        if (e.key === "ArrowLeft") {
          e.preventDefault();
          onDrag(mid - step);
        } else if (e.key === "ArrowRight") {
          e.preventDefault();
          onDrag(mid + step);
        }
      }}
      className="group/resize relative w-2 shrink-0 cursor-col-resize outline-none"
      // the gap is chrome, and chrome drags the window; the handle has to opt out or it moves the window instead
      style={NO_DRAG}
    >
      {/* a short delay, so a pointer crossing the gap on its way somewhere does not flash it */}
      <span
        aria-hidden
        className={cn(
          "bg-foreground/15 pointer-events-none absolute inset-y-4 left-1/2 w-[3px] -translate-x-1/2 rounded-full opacity-0 transition-[opacity,background-color] duration-150",
          "group-hover/resize:opacity-100 group-hover/resize:delay-100",
          "group-focus-visible/resize:bg-primary group-focus-visible/resize:opacity-100",
          "group-data-[dragging]/resize:bg-primary group-data-[dragging]/resize:opacity-100 group-data-[dragging]/resize:delay-0",
        )}
      />
    </div>
  );
}
