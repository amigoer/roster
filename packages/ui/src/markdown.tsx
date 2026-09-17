import { Children, createContext, isValidElement, memo, useContext, useRef } from "react";
import { Button } from "@/components/ui/button";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";
import { CopyIcon, useCopy } from "./copy";
import { useI18n } from "./i18n";
import { segments } from "./mentions";

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

/** Member names in the current conversation, so @name renders as an address. */
export const MentionNames = createContext<readonly string[]>([]);

/** How a mention is marked, in a message and in the composer. */
export const MENTION = "rounded bg-sky-500/10 text-sky-700 dark:text-sky-300";

export function MentionChip({ children }: { children: React.ReactNode }) {
  return <span className={cn(MENTION, "px-0.5 font-medium")}>{children}</span>;
}

/** Highlights mentions in the plain-string children of a block; everything else passes through. */
function Mentions({ children }: { children?: React.ReactNode }) {
  const names = useContext(MentionNames);
  if (names.length === 0) return <>{children}</>;
  return (
    <>
      {Children.map(children, (child) =>
        typeof child === "string"
          ? segments(child, names).map((s, i) => (s.mention ? <MentionChip key={i}>{s.text}</MentionChip> : s.text))
          : child,
      )}
    </>
  );
}

function Strong({ children }: { children?: React.ReactNode }) {
  return <strong className="font-semibold">{children}</strong>;
}

/** A paragraph that is one bold run and nothing else: a model's section label, spaced like a heading. */
function isLabel(children: React.ReactNode): boolean {
  const parts = Children.toArray(children).filter((c) => !(typeof c === "string" && c.trim() === ""));
  return parts.length === 1 && isValidElement(parts[0]) && parts[0].type === Strong;
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
  li: ({ children }) => (
    // a list inside a list keeps the outer rhythm rather than starting its own
    <li className="pl-[0.25em] [&>ol]:my-[0.4em] [&>ul]:my-[0.4em] [&>p]:my-0">
      <Mentions>{children}</Mentions>
    </li>
  ),
  strong: Strong,
  em: ({ children }) => <em className="italic">{children}</em>,
  a: ({ href, children }) => (
    // external links open in the user's browser, not inside the app shell
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className="text-primary decoration-primary/35 hover:decoration-primary underline decoration-1 underline-offset-[3px] transition-colors"
    >
      {children}
    </a>
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
  th: ({ children }) => (
    <th className="bg-muted/50 border-b px-2.5 py-1.5 text-left font-medium whitespace-nowrap">{children}</th>
  ),
  td: ({ children }) => <td className="border-b px-2.5 py-1.5 align-top last:border-b-0">{children}</td>,
  tbody: ({ children }) => <tbody className="[&>tr:last-child>td]:border-b-0">{children}</tbody>,
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
