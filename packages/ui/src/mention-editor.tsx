import { useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, type ClipboardEvent, type KeyboardEvent, type Ref } from "react";
import type { Bot } from "./api";
import { botOf, CHIP, MentionFace } from "./mention-chip";
import { segments } from "./mentions";
import { cn } from "@/lib/utils";

/** What a mention counts as wherever the editor measures text: one character, since the caret steps over it whole. */
export const MENTION_MARK = "\uFFFC";

/** Something to put into the text: words, or a mention as it is written. */
export type Piece = string | { mention: string };

export interface EditorHandle {
  /** Takes the caret back to where it last was in the text, or to its end. */
  focus(): void;
  /** The text before the caret, each mention as MENTION_MARK. */
  beforeCaret(): string;
  /** Replaces the selection, and `back` characters of text before it; undone the way typing is. */
  insert(pieces: Piece[], back?: number): void;
  /** Replaces the whole text, the caret `caret` characters in. */
  reset(value: string, caret: number): void;
}

const HIGHLIGHT = "mention";

const isChip = (n: Node | null): n is HTMLElement => n instanceof HTMLElement && n.dataset.mention !== undefined;

function chipAround(root: HTMLElement, node: Node): HTMLElement | null {
  for (let n: Node | null = node; n && n !== root; n = n.parentNode) if (isChip(n)) return n;
  return null;
}

const indexOf = (n: Node) => Array.prototype.indexOf.call(n.parentNode!.childNodes, n);

/** A point inside a mention stands for the point after it; Chromium leaves the caret inside one it just inserted last. */
function outside(root: HTMLElement, node: Node, offset: number): [Node, number] {
  const chip = chipAround(root, node);
  return chip ? [chip.parentNode!, indexOf(chip) + 1] : [node, offset];
}

/**
 * A click lands the selection inside a mention's text, which Chromium allows
 * since the text is selectable. A caret there moves to the nearer side; a
 * range grows to take the mention whole, so none is ever split.
 */
function snap(root: HTMLElement, sel: Selection) {
  if (!sel.rangeCount || !sel.anchorNode || !sel.focusNode) return;
  const range = sel.getRangeAt(0);
  const first = chipAround(root, range.startContainer);
  const last = chipAround(root, range.endContainer);
  if (!first && !last) return;
  if (sel.isCollapsed) {
    const text = range.startContainer instanceof Text && first?.lastChild === range.startContainer ? range.startContainer : null;
    const after = text !== null && range.startOffset * 2 >= text.data.length;
    return void sel.collapse(first!.parentNode!, indexOf(first!) + (after ? 1 : 0));
  }
  const start: [Node, number] = first ? [first.parentNode!, indexOf(first)] : [range.startContainer, range.startOffset];
  const end: [Node, number] = last ? [last.parentNode!, indexOf(last) + 1] : [range.endContainer, range.endOffset];
  const forward = sel.anchorNode === range.startContainer && sel.anchorOffset === range.startOffset;
  if (forward) sel.setBaseAndExtent(...start, ...end);
  else sel.setBaseAndExtent(...end, ...start);
}

/**
 * The text as it is sent, and where a point falls in it. A mention reads as
 * what it says, or as `mark`. A line break that ends the last run of text never
 * shows, and Chromium puts one there to hold an empty last line open, so it
 * is not part of the text.
 */
function read(root: HTMLElement, mark: string | null, point?: [Node, number]): { text: string; at: number } {
  let text = "";
  let at = -1;
  let hidden = false;
  let afterChip = false;
  const visit = (n: Node) => {
    if (n instanceof Text) {
      // a chip stays one address in what is sent: a word typed right after it would lengthen the name core matches
      if (!mark && afterChip && /^[\p{L}\p{N}_]/u.test(n.data)) text += " ";
      if (n === point?.[0]) at = text.length + point[1];
      text += n.data;
      if (n.data) {
        hidden = n.data.endsWith("\n");
        afterChip = false;
      }
      return;
    }
    if (isChip(n)) {
      // and glued to a word before it, its @ would read as an email address
      if (!mark && /[A-Za-z0-9_]$/.test(text)) text += " ";
      text += mark ?? n.dataset.mention;
      hidden = false;
      afterChip = true;
      return;
    }
    afterChip = false;
    if (n.nodeName === "BR") {
      // one last in its block only keeps the empty block from collapsing; Chromium can leave an empty text node after it
      let next = n.nextSibling;
      while (next instanceof Text && !next.data) next = next.nextSibling;
      if (next) text += "\n";
      hidden = false;
      return;
    }
    if (n !== root && /^(DIV|P)$/.test(n.nodeName) && text && !text.endsWith("\n")) text += "\n";
    n.childNodes.forEach((c, i) => {
      if (n === point?.[0] && i === point[1]) at = text.length;
      visit(c);
    });
    if (n === point?.[0] && point[1] >= n.childNodes.length) at = text.length;
  };
  visit(root);
  if (hidden) text = text.slice(0, -1);
  text = text.replaceAll("\u00a0", " ");
  return { text, at: at < 0 ? text.length : Math.min(at, text.length) };
}

/** The point `offset` characters into text built by `build`; one that falls inside a mention lands after it. */
function pointAt(root: HTMLElement, offset: number): [Node, number] {
  let left = offset;
  for (const [i, n] of [...root.childNodes].entries()) {
    const size = n instanceof Text ? n.data.length : isChip(n) ? n.dataset.mention!.length : 0;
    if (n instanceof Text && left <= size) return [n, left];
    if (left < size) return [root, i + 1];
    left -= size;
  }
  return [root, root.childNodes.length];
}

/** The point `count` characters before another, through text only: a mention or a line's start stops it. */
function backFrom(node: Node, offset: number, count: number): [Node, number] {
  let n = node;
  let o = offset;
  if (!(n instanceof Text)) {
    const prev = n.childNodes[o - 1];
    if (!(prev instanceof Text)) return [n, o];
    n = prev;
    o = prev.data.length;
  }
  while (count > o) {
    const prev = n.previousSibling;
    if (!(prev instanceof Text)) return [n, 0];
    count -= o;
    n = prev;
    o = prev.data.length;
  }
  return [n, o - count];
}

/**
 * Types plain text over the selection. Chromium turns a newline inside
 * insertText into a new block, so each is a line break of its own; together
 * they still undo as one.
 */
function typePlain(text: string) {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  if (lines.length === 1 && !lines[0]) {
    if (!getSelection()?.isCollapsed) document.execCommand("delete");
    return;
  }
  lines.forEach((line, i) => {
    if (i > 0) document.execCommand("insertLineBreak");
    if (line) document.execCommand("insertText", false, line);
  });
}

/** Brings the caret into view; a command run from script does not scroll to it the way typing does. */
function reveal(root: HTMLElement) {
  const sel = getSelection();
  if (!sel?.rangeCount) return;
  const range = sel.getRangeAt(0);
  let rect = range.getBoundingClientRect();
  if (!rect.height) {
    // a collapsed range between elements has no box of its own; the node beside it stands in
    const { endContainer: c, endOffset: o } = range;
    const near = c instanceof Text ? c : (c.childNodes[o - 1] ?? c.childNodes[o]);
    if (near instanceof Element) rect = near.getBoundingClientRect();
    else if (near) {
      const around = new Range();
      around.selectNode(near);
      rect = around.getBoundingClientRect();
    }
  }
  if (!rect.height) return;
  const box = root.getBoundingClientRect();
  const style = getComputedStyle(root);
  const bottom = box.bottom - parseFloat(style.paddingBottom);
  const top = box.top + parseFloat(style.paddingTop);
  if (rect.bottom > bottom) root.scrollTop += rect.bottom - bottom;
  else if (rect.top < top) root.scrollTop -= top - rect.top;
}

/** A mention typed out by hand still addresses someone, so it is tinted, though only one picked from the list is a chip. */
function paint(root: HTMLElement, names: readonly string[]) {
  if (typeof Highlight === "undefined" || !CSS.highlights) return;
  const ranges: Range[] = [];
  let run: Text[] = [];
  const flush = () => {
    const text = run.map((t) => t.data).join("");
    let from = 0;
    for (const s of segments(text, names)) {
      const to = from + s.text.length;
      if (s.mention) {
        const range = new Range();
        let at = 0;
        for (const t of run) {
          const end = at + t.data.length;
          if (from >= at && from <= end) range.setStart(t, from - at);
          if (to <= end) {
            range.setEnd(t, to - at);
            break;
          }
          at = end;
        }
        ranges.push(range);
      }
      from = to;
    }
    run = [];
  };
  const walk = (n: Node) =>
    n.childNodes.forEach((c) => {
      if (c instanceof Text) return void run.push(c);
      flush();
      if (!isChip(c)) {
        walk(c);
        flush();
      }
    });
  walk(root);
  flush();
  CSS.highlights.set(HIGHLIGHT, new Highlight(...ranges));
}

/**
 * The composer's text box. A mention picked from the list goes in as a chip
 * the caret cannot enter and a delete takes whole; everything else is plain
 * text. The text itself lives in the DOM, where editing and IME composition
 * happen natively, and is read out as a string on every change.
 */
export function MentionEditor({
  ref,
  bots,
  value,
  onChange,
  placeholder,
  className,
  onKeyDown,
  onPaste,
  onSelect,
  onBlur,
}: {
  ref: Ref<EditorHandle>;
  /** who can be mentioned, which is also whose face a chip shows */
  bots: readonly Bot[];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  onKeyDown?: (e: KeyboardEvent<HTMLDivElement>) => void;
  onPaste?: (e: ClipboardEvent<HTMLDivElement>) => void;
  onSelect?: () => void;
  onBlur?: () => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const faces = useRef<HTMLDivElement>(null);
  /** the text the DOM holds, so a value handed back down is not rebuilt under the caret */
  const shown = useRef<string | null>(null);
  /** where the caret last was in here, to come back to once focus has been elsewhere */
  const saved = useRef<Range | null>(null);
  /** while one change runs several commands, it is read out once at the end */
  const muted = useRef(false);
  const names = useMemo(() => bots.map((b) => b.name), [bots]);
  const namesKey = names.join("\n");

  const chip = (text: string) => {
    const el = document.createElement("span");
    el.contentEditable = "false";
    el.dataset.mention = text;
    el.className = CHIP;
    const face = [...(faces.current?.children ?? [])].find((f) => (f as HTMLElement).dataset.face === (botOf(text, bots)?.id ?? ""));
    if (face?.firstChild) el.append(face.firstChild.cloneNode(true));
    el.append(text);
    return el;
  };

  const emit = () => {
    const el = root.current!;
    const text = read(el, null).text;
    shown.current = text;
    paint(el, names);
    onChange(text);
  };

  const quietly = (edit: () => void) => {
    muted.current = true;
    try {
      edit();
    } finally {
      muted.current = false;
    }
    reveal(root.current!);
    emit();
  };

  const build = (text: string) => {
    const el = root.current!;
    const nodes: Node[] = segments(text, names).map((s) => (s.mention ? chip(s.text) : new Text(s.text)));
    // a trailing line break shows only with another after it, the way Chromium holds an empty last line open
    if (text.endsWith("\n")) nodes.push(new Text("\n"));
    el.replaceChildren(...nodes);
    shown.current = text;
    saved.current = null;
    paint(el, names);
  };

  const end = () => {
    const range = new Range();
    range.selectNodeContents(root.current!);
    range.collapse(false);
    return range;
  };

  /** The caret in here and focused: where it is, else where it was, else at the end. */
  const restore = (): Selection => {
    const el = root.current!;
    const sel = getSelection()!;
    const inside = sel.rangeCount > 0 && el.contains(sel.anchorNode);
    const back = inside ? null : saved.current && el.contains(saved.current.startContainer) ? saved.current : end();
    // focusing a contenteditable drops the caret at its start, so the one to restore is picked first
    if (document.activeElement !== el) el.focus({ preventScroll: true });
    if (back) {
      sel.removeAllRanges();
      sel.addRange(back.cloneRange());
    }
    return sel;
  };

  const quietlyRef = useRef(quietly);
  quietlyRef.current = quietly;

  useImperativeHandle(ref, () => ({
    focus: () => void restore(),
    beforeCaret() {
      const el = root.current!;
      const sel = getSelection();
      const range = sel?.rangeCount && el.contains(sel.anchorNode) ? sel.getRangeAt(0) : (saved.current ?? end());
      const { text, at } = read(el, MENTION_MARK, outside(el, range.startContainer, range.startOffset));
      return text.slice(0, at);
    },
    insert(pieces, back = 0) {
      const el = root.current!;
      const sel = restore();
      const range = sel.getRangeAt(0).cloneRange();
      if (back > 0) range.setStart(...backFrom(...outside(el, range.startContainer, range.startOffset), back));
      sel.removeAllRanges();
      sel.addRange(range);
      quietly(() => {
        if (pieces.every((p) => typeof p === "string")) return typePlain(pieces.join(""));
        const html = document.createElement("div");
        for (const p of pieces) html.append(typeof p === "string" ? p : chip(p.mention));
        document.execCommand("insertHTML", false, html.innerHTML);
        const after = getSelection()!;
        if (after.focusNode) after.collapse(...outside(el, after.focusNode, after.focusOffset));
      });
    },
    reset(text, caret) {
      const el = root.current!;
      build(text);
      if (document.activeElement !== el) el.focus({ preventScroll: true });
      getSelection()!.collapse(...pointAt(el, caret));
      reveal(el);
      onChange(text);
    },
  }));

  // a value from outside (sent, restored, a mention added from a card) replaces the text; the caret goes after it
  useLayoutEffect(() => {
    if (value === shown.current) return;
    build(value);
    const el = root.current!;
    if (document.activeElement !== el) return;
    getSelection()!.collapse(el, el.childNodes.length);
    reveal(el);
  }, [value]);

  useEffect(() => {
    if (root.current) paint(root.current, names);
  }, [namesKey]);

  useEffect(() => {
    const el = root.current!;
    const track = () => {
      const sel = getSelection();
      if (!sel?.rangeCount || !el.contains(sel.anchorNode)) return;
      snap(el, sel);
      saved.current = sel.getRangeAt(0).cloneRange();
    };
    // what the box takes in is plain text: no dropped or pasted markup, no bold, and a new line rather than a new block
    const filter = (e: InputEvent) => {
      if (e.inputType.startsWith("format")) return e.preventDefault();
      if (e.inputType === "insertParagraph") {
        e.preventDefault();
        return quietlyRef.current(() => document.execCommand("insertLineBreak"));
      }
      if (!/^insertFrom(Drop|Paste|PasteAsQuotation)$/.test(e.inputType) || !e.dataTransfer) return;
      e.preventDefault();
      const text = e.dataTransfer.getData("text/plain");
      const target = e.getTargetRanges()[0];
      if (target) {
        const range = new Range();
        range.setStart(target.startContainer, target.startOffset);
        range.setEnd(target.endContainer, target.endOffset);
        getSelection()?.removeAllRanges();
        getSelection()?.addRange(range);
      }
      quietlyRef.current(() => typePlain(text));
    };
    document.addEventListener("selectionchange", track);
    el.addEventListener("beforeinput", filter);
    return () => {
      document.removeEventListener("selectionchange", track);
      el.removeEventListener("beforeinput", filter);
      CSS.highlights?.delete(HIGHLIGHT);
    };
  }, []);

  return (
    <div className="relative">
      {/* faces drawn once, the way the rest of the window draws them, and copied into each chip */}
      <div ref={faces} hidden>
        {bots.map((b) => (
          <span key={b.id} data-face={b.id}>
            <MentionFace bot={b} />
          </span>
        ))}
        <span data-face="">
          <MentionFace />
        </span>
      </div>
      {!value && (
        <div aria-hidden className={cn(className, "text-muted-foreground pointer-events-none absolute inset-0 overflow-hidden")}>
          {placeholder}
        </div>
      )}
      <div
        ref={root}
        role="textbox"
        aria-multiline
        aria-label={placeholder}
        aria-placeholder={placeholder}
        contentEditable
        className={cn(className, "cursor-text overflow-y-auto break-words whitespace-pre-wrap select-text")}
        onInput={() => {
          if (!muted.current) emit();
        }}
        onKeyDown={(e) => {
          onKeyDown?.(e);
          // an Enter left to the box is a new line, never a new block, whatever the platform binds it to
          if (e.defaultPrevented || e.key !== "Enter" || e.nativeEvent.isComposing) return;
          e.preventDefault();
          quietly(() => document.execCommand("insertLineBreak"));
        }}
        onPaste={(e) => {
          onPaste?.(e);
          if (e.defaultPrevented) return;
          e.preventDefault();
          quietly(() => typePlain(e.clipboardData.getData("text/plain")));
        }}
        onSelect={onSelect}
        onBlur={onBlur}
      />
    </div>
  );
}
