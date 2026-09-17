import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { QuoteIcon } from "lucide-react";
import { CopyIcon, useCopy } from "./copy";
import { useI18n } from "./i18n";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** A highlighted passage and where in the host it ends. */
interface Passage {
  messageId: string;
  text: string;
  /** the end the selection was drawn to, in the host's coordinates: where the pointer, and the eye, are */
  x: number;
  top: number;
  bottom: number;
}

/** Whether the selection was drawn from its end back to its start. */
function backward(sel: Selection): boolean {
  if (!sel.anchorNode || !sel.focusNode) return false;
  const r = document.createRange();
  r.setStart(sel.anchorNode, sel.anchorOffset);
  // an end set before the start collapses the range
  r.setEnd(sel.focusNode, sel.focusOffset);
  return r.collapsed;
}

/** What is highlighted, if it is a passage inside one message of the host. */
function passageOf(host: HTMLElement): Passage | null {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  const text = sel.toString().trim();
  if (!text) return null;
  const range = sel.getRangeAt(0);
  const node = range.commonAncestorContainer;
  // every message root in the transcript carries its id (see cards.tsx); a selection across two has no root
  const root = (node instanceof Element ? node : node.parentElement)?.closest<HTMLElement>("[data-message]");
  if (!root?.dataset.message || !host.contains(root)) return null;
  // a wholly selected block lists its box before the lines in it, so the ends of the list are lines either way
  const rects = Array.from(range.getClientRects()).filter((r) => r.height > 0);
  const back = backward(sel);
  const edge = back ? rects[0] : rects[rects.length - 1];
  if (!edge) return null;
  const at = host.getBoundingClientRect();
  return {
    messageId: root.dataset.message,
    text,
    x: (back ? edge.left : edge.right) - at.left,
    top: edge.top - at.top,
    bottom: edge.bottom - at.top,
  };
}

const GAP = 6;

/**
 * Quoting a whole eighty-line answer is rarely what is wanted: highlight a
 * passage in a message and this offers to quote just that, or copy it. It
 * appears once the selection settles, at the end it was drawn to, and goes
 * with the selection. Rendered inside the host it positions in, so it scrolls
 * with the text it belongs to.
 */
export function SelectionMenu({
  host,
  onQuote,
}: {
  /** the transcript: what is selectable, and what the menu is placed in */
  host: RefObject<HTMLElement | null>;
  onQuote: (messageId: string, text: string) => void;
}) {
  const [passage, setPassage] = useState<Passage | null>(null);
  const bar = useRef<HTMLDivElement>(null);
  const { copied, copy } = useCopy();
  const { t } = useI18n();

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let pressed = false;
    let frame = 0;
    // a frame late, so the selection is read once, after every change the same input made
    const settle = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setPassage(passageOf(el)));
    };
    const down = (e: PointerEvent) => {
      if (e.button === 0) pressed = true;
    };
    const up = (e: PointerEvent) => {
      if (e.button !== 0) return;
      pressed = false;
      settle();
    };
    // while the pointer is down the selection is still being drawn; showing it mid-drag would only get in the way
    const change = () => (pressed ? setPassage(null) : settle());
    // the text reflows when the pane changes width, and the passage's end moves with it
    const reflow = new ResizeObserver(settle);
    reflow.observe(el);
    document.addEventListener("pointerdown", down);
    document.addEventListener("pointerup", up);
    document.addEventListener("selectionchange", change);
    return () => {
      reflow.disconnect();
      document.removeEventListener("pointerdown", down);
      document.removeEventListener("pointerup", up);
      document.removeEventListener("selectionchange", change);
      cancelAnimationFrame(frame);
    };
  }, [host]);

  useLayoutEffect(() => {
    const el = bar.current;
    const root = host.current;
    if (!el || !root || !passage) return;
    const at = root.getBoundingClientRect();
    // above the passage's last line unless that is scrolled out of sight, then under it
    const viewport = root.closest('[data-slot="scroll-area-viewport"]')?.getBoundingClientRect();
    const seen = viewport ? viewport.top - at.top : -Infinity;
    const above = passage.top - el.offsetHeight - GAP;
    const below = above < seen + GAP;
    el.style.left = `${Math.min(Math.max(passage.x - el.offsetWidth / 2, 0), root.clientWidth - el.offsetWidth)}px`;
    el.style.top = `${below ? passage.bottom + GAP : above}px`;
    el.dataset.side = below ? "bottom" : "top";
  }, [host, passage]);

  if (!passage) return null;
  return (
    <div
      ref={bar}
      className={cn(
        "bg-popover text-popover-foreground absolute z-10 flex cursor-default items-center gap-0.5 rounded-lg border p-0.5 shadow-lg select-none",
        // it lifts in from the line it belongs to, whichever side of it there was room on
        "animate-in fade-in-0 zoom-in-95 duration-150 ease-soft data-[side=top]:origin-bottom data-[side=top]:slide-in-from-bottom-1 data-[side=bottom]:origin-top data-[side=bottom]:slide-in-from-top-1",
      )}
      // a press on the menu must not collapse the selection it is about, nor take focus from where it was
      onMouseDown={(e) => e.preventDefault()}
    >
      <Button
        variant="ghost"
        size="xs"
        onClick={() => {
          setPassage(null);
          // the composer takes the caret next; the highlight has done its job
          window.getSelection()?.removeAllRanges();
          onQuote(passage.messageId, passage.text);
        }}
      >
        <QuoteIcon />
        {t("selection.quote")}
      </Button>
      <Button variant="ghost" size="xs" onClick={() => void copy(passage.text)}>
        <CopyIcon copied={copied} className="size-3" />
        {t("common.copy")}
      </Button>
    </div>
  );
}
