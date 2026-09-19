import { ArrowUpRight, Globe, Square, SquareCheck } from "lucide-react";
import { Children, isValidElement, memo, useContext, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";
import { CopyIcon, useCopy } from "./copy";
import { useI18n } from "./i18n";
import { MentionBots, MentionText } from "./mention-chip";

/**
 * A Markdown passage as one line of plain text, for a preview: fences, block
 * markers, bold, inline code and link syntax off, whitespace folded. Italics
 * are left alone, since _ also spells snake_case.
 */
export function plain(md: string): string {
  return md
    .replace(/^\s{0,3}(```|~~~)[^\n]*$/gm, "")
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/gm, "")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/** Marks mentions in the plain-string children of a block; everything else passes through. */
function Mentions({ children }: { children?: React.ReactNode }) {
  if (useContext(MentionBots).length === 0) return <>{children}</>;
  return <>{Children.map(children, (child) => (typeof child === "string" ? <MentionText text={child} /> : child))}</>;
}

function Strong({ children }: { children?: React.ReactNode }) {
  return <strong className="font-semibold">{children}</strong>;
}

/** A paragraph that is one bold run and nothing else: a model's section label, spaced like a heading. */
function isLabel(children: React.ReactNode): boolean {
  const parts = Children.toArray(children).filter((c) => !(typeof c === "string" && c.trim() === ""));
  return parts.length === 1 && isValidElement(parts[0]) && parts[0].type === Strong;
}

/** Whether each site's icon loaded, so a message drawn again shows it at once, and one that failed is not asked for again. */
const icons = new Map<string, boolean>();

/** A site's own icon, which core finds; a globe when it has none. */
function SiteIcon({ site }: { site: string }) {
  const [loaded, setLoaded] = useState(() => icons.get(site));
  const settle = (ok: boolean) => {
    icons.set(site, ok);
    setLoaded(ok);
  };
  const box = "mr-[0.3em] inline-block size-[1em] align-[-0.15em]";
  if (loaded === false) return <Globe aria-hidden strokeWidth={1.75} className={box} />;
  return (
    <img
      src={`/api/favicon?site=${encodeURIComponent(site)}`}
      alt=""
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      draggable={false}
      onLoad={() => settle(true)}
      onError={() => settle(false)}
      // many sites draw a black mark for a light tab bar, so on dark it sits on a light tile, shown only once filled
      className={cn(box, "rounded-[0.2em] object-contain dark:bg-white dark:p-[0.1em]", !loaded && "invisible")}
    />
  );
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const graphemeAt = (s: string, i: number) => graphemes.segment(s).containing(i)?.segment ?? "";

/** The site an absolute web link points at; a path, an anchor or a mail link has none. */
function siteOf(href: string | undefined): string | null {
  if (!href || !/^https?:\/\//i.test(href)) return null;
  try {
    return new URL(href).origin;
  } catch {
    return null;
  }
}

/**
 * A link's text between the site's icon and an arrow. A line may break inside
 * the text but not between an icon and the character next to it, so each
 * icon is held to the first or last character; an element at an end stays whole.
 */
function Marked({ site, children }: { site: string; children: React.ReactNode }) {
  const parts = Children.toArray(children);
  let lead = "";
  let end = "";
  const first = parts[0];
  if (typeof first === "string") {
    lead = graphemeAt(first, 0);
    parts[0] = first.slice(lead.length);
  }
  const last = parts.at(-1);
  if (typeof last === "string" && last) {
    end = graphemeAt(last, last.length - 1);
    parts[parts.length - 1] = last.slice(0, -end.length);
  }
  const icon = <SiteIcon key={site} site={site} />;
  const arrow = <ArrowUpRight aria-hidden strokeWidth={2} className="ml-[0.1em] inline-block size-[0.85em] align-[-0.05em]" />;
  // one character leaves nothing between the ends, so both icons hold to it
  if (parts.every((p) => p === "")) {
    return (
      <span className="whitespace-nowrap">
        {icon}
        {lead}
        {end}
        {arrow}
      </span>
    );
  }
  return (
    <>
      <span className="whitespace-nowrap">
        {icon}
        {lead}
      </span>
      {parts}
      <span className="whitespace-nowrap">
        {end}
        {arrow}
      </span>
    </>
  );
}

/** Inline, so badges line up in a row; the stylesheet's reset makes every image a block. */
function Img({ src, alt, title }: React.ComponentProps<"img">) {
  return <img src={src} alt={alt} title={title} loading="lazy" className="inline-block max-w-full align-text-bottom" />;
}

/** A link to a website wears the site's icon in front and an arrow behind, so where it leads shows before it is clicked. */
function Link({ href, title, children }: { href?: string; title?: string; children?: React.ReactNode }) {
  const site = siteOf(href);
  // a linked badge or picture needs no marker
  const pictured = Children.toArray(children).some((c) => isValidElement(c) && c.type === Img);
  // a bare address reads as host and path; the icons already say it is on the web
  const text = href && children === href ? href.replace(/^https?:\/\//i, "").replace(/\/$/, "") : children;
  return (
    // opens in the user's browser, not the app shell; the window has no status bar, so the title shows where it goes
    <a
      href={href}
      title={title ?? href}
      target="_blank"
      rel="noreferrer noopener"
      // underlined with a border: text-decoration skips images and icons, a border runs beneath them as well
      className={cn("text-primary transition-colors", !pictured && "border-primary/35 hover:border-primary border-b")}
    >
      {site && !pictured ? <Marked site={site}>{text}</Marked> : children}
    </a>
  );
}

/**
 * The vertical rhythm is in em, so it scales with the text size picked in
 * settings: a block gap of 0.85em, headings further above than below.
 */
const BLOCK = "mt-[0.85em] mb-[0.85em] first:mt-0 last:mb-0";

/**
 * A coding agent answers in Markdown, so rendering it raw shows the reader
 * literal ** and backticks. Elements are styled here rather than through a
 * prose plugin so the palette stays the shadcn token set.
 */
const COMPONENTS: Components = {
  p: ({ children }) => (
    <p className={cn(BLOCK, isLabel(children) && "mt-[1.4em] mb-[0.5em]")}>
      <Mentions>{children}</Mentions>
    </p>
  ),
  // a heading has to be seen as one at a glance, so each is a step above the text it opens
  h1: ({ children }) => (
    <h1 className="mt-[1.5em] mb-[0.55em] text-[1.3em] leading-[1.35] font-semibold tracking-tight first:mt-0">{children}</h1>
  ),
  h2: ({ children }) => (
    <h2 className="mt-[1.45em] mb-[0.5em] text-[1.18em] leading-[1.4] font-semibold tracking-tight first:mt-0">{children}</h2>
  ),
  h3: ({ children }) => <h3 className="mt-[1.4em] mb-[0.45em] text-[1.06em] leading-[1.5] font-semibold first:mt-0">{children}</h3>,
  h4: ({ children }) => <h4 className="mt-[1.3em] mb-[0.4em] font-semibold first:mt-0">{children}</h4>,
  // markers in the text colour: grey dots vanish and the list reads as ragged paragraphs
  ul: ({ children }) => (
    <ul className={cn(BLOCK, "marker:text-foreground/70 list-disc space-y-[0.4em] pl-[1.6em]")}>{children}</ul>
  ),
  ol: ({ children }) => (
    <ol className={cn(BLOCK, "marker:text-foreground/70 list-decimal space-y-[0.4em] pl-[1.6em]")}>{children}</ol>
  ),
  li: ({ children, className }) => (
    // a list inside a list keeps the outer rhythm rather than starting its own; a task's box stands in for the bullet
    <li className={cn("pl-[0.25em] [&>ol]:my-[0.4em] [&>ul]:my-[0.4em] [&>p]:my-0", className?.includes("task-list-item") && "list-none")}>
      <Mentions>{children}</Mentions>
    </li>
  ),
  // only a task list puts an input in Markdown: drawn, as a disabled checkbox greys out, and floated
  // into the bullet's place so the space written after it starts the line and collapses
  input: ({ checked }) => {
    const Box = checked ? SquareCheck : Square;
    return (
      <Box
        role="checkbox"
        aria-checked={Boolean(checked)}
        aria-disabled
        strokeWidth={2}
        className={cn(
          "float-left mt-[calc((1lh_-_1em)/2)] mr-[0.4em] -ml-[1.4em] size-[1em]",
          checked ? "text-primary" : "text-muted-foreground",
        )}
      />
    );
  },
  img: Img,
  strong: Strong,
  em: ({ children }) => <em className="italic">{children}</em>,
  a: ({ href, title, children }) => (
    <Link href={href} title={title}>
      {children}
    </Link>
  ),
  blockquote: ({ children }) => (
    <blockquote className={cn(BLOCK, "border-foreground/15 text-muted-foreground border-l-2 pl-[0.9em]")}>{children}</blockquote>
  ),
  hr: () => <hr className="my-[1.5em]" />,
  code: ({ className, children, ...props }) => {
    // react-markdown gives inline code no language class; a fenced block gets one,
    // and multi-line content is a block even without a language
    const text = String(children);
    const isBlock = /language-/.test(className ?? "") || text.includes("\n");
    if (!isBlock) {
      return (
        // an identifier reads as one by its colour, so it keeps a regular weight even inside a bold run
        <code
          className="text-code-foreground bg-code-background border-code-border box-decoration-clone rounded-[0.35em] border px-[0.4em] py-[0.1em] font-mono text-[0.88em] font-normal break-words whitespace-pre-wrap"
          {...props}
        >
          {children}
        </code>
      );
    }
    return (
      <code className="font-mono text-[0.875em] leading-[1.6]" {...props}>
        {children}
      </code>
    );
  },
  pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
  // rules between the rows, not around every cell: the columns line the table up on their own
  table: ({ children }) => (
    <div className={cn(BLOCK, "overflow-x-auto rounded-lg border")}>
      <table className="w-full border-collapse text-[0.9em]">{children}</table>
    </div>
  ),
  // each body row draws the rule above it, so there is never one against the frame; a column's alignment arrives as style
  th: ({ children, style }) => (
    <th style={style} className="bg-muted/50 px-2.5 py-1.5 text-left font-medium whitespace-nowrap">
      {children}
    </th>
  ),
  td: ({ children, style }) => (
    <td style={style} className="border-t px-2.5 py-1.5 align-top">
      {children}
    </td>
  ),
};

/** Grabbing a snippet is the most common thing done with an agent's answer. */
function CodeBlock({ children }: { children?: React.ReactNode }) {
  const ref = useRef<HTMLPreElement>(null);
  const { copied, copy } = useCopy();
  const { t } = useI18n();
  return (
    <div className={cn(BLOCK, "group/code relative")}>
      {/* its own scroller: a long line must not widen the bubble */}
      <pre ref={ref} className="bg-muted overflow-x-auto rounded-lg border p-3 pr-10">
        {children}
      </pre>
      <Button
        variant="ghost"
        size="icon-xs"
        onClick={() => void copy(ref.current?.innerText ?? "")}
        title={t("markdown.copyCode")}
        className="text-muted-foreground hover:bg-background hover:text-foreground absolute top-1.5 right-1.5 opacity-0 transition-opacity group-hover/code:opacity-100 focus-visible:opacity-100"
      >
        <CopyIcon copied={copied} />
      </Button>
    </div>
  );
}

/**
 * Where a text still being written can be cut: after the last blank line
 * outside a code fence. Everything before it is a block that is done.
 */
function settledEnd(text: string): number {
  let fenced = false;
  let cut = 0;
  let at = 0;
  for (const line of text.split("\n")) {
    if (/^\s{0,3}(```|~~~)/.test(line)) fenced = !fenced;
    else if (!fenced && at > 0 && line.trim() === "") cut = at + line.length + 1;
    at += line.length + 1;
  }
  return Math.min(cut, text.length);
}

/**
 * A reply as it streams: the blocks that are done read as Markdown already,
 * and only the one still being written stays plain, since half-written
 * Markdown renders as garbage. Finishing then changes one block, not the page.
 */
export function StreamingMarkdown({ text }: { text: string }) {
  const cut = settledEnd(text);
  const settled = text.slice(0, cut);
  const tail = text.slice(cut);
  return (
    <>
      {settled && <Markdown>{settled}</Markdown>}
      {tail && (
        <div className={cn("text-message leading-message break-words whitespace-pre-wrap", settled && "mt-[0.85em]")}>{tail}</div>
      )}
    </>
  );
}

export const Markdown = memo(function Markdown({
  children,
  className,
}: {
  children: string;
  className?: string;
}) {
  return (
    <div className={cn("text-message leading-message break-words", className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={COMPONENTS}>
        {children}
      </ReactMarkdown>
    </div>
  );
});
