import { Children, createContext, memo, useContext, useRef } from "react";
import { Button } from "@/components/ui/button";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";
import { CopyIcon, useCopy } from "./copy";
import { useI18n } from "./i18n";
import { segments } from "./mentions";

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

/**
 * A coding agent answers in Markdown, so rendering it raw shows the reader
 * literal ** and backticks. Elements are styled here rather than through a
 * prose plugin so the palette stays the shadcn token set.
 */
const COMPONENTS: Components = {
  p: ({ children }) => (
    <p className="my-3 first:mt-0 last:mb-0">
      <Mentions>{children}</Mentions>
    </p>
  ),
  // a heading has to be seen as one at a glance, so each is a step above the text it opens
  h1: ({ children }) => <h1 className="mt-6 mb-2.5 text-[1.28em] font-semibold tracking-tight first:mt-0">{children}</h1>,
  h2: ({ children }) => <h2 className="mt-5 mb-2 text-[1.14em] font-semibold tracking-tight first:mt-0">{children}</h2>,
  h3: ({ children }) => <h3 className="mt-4 mb-1.5 text-[1.04em] font-semibold first:mt-0">{children}</h3>,
  h4: ({ children }) => <h4 className="mt-4 mb-1.5 font-semibold first:mt-0">{children}</h4>,
  ul: ({ children }) => (
    <ul className="marker:text-muted-foreground/70 my-3 list-disc space-y-1.5 pl-5 first:mt-0 last:mb-0">{children}</ul>
  ),
  ol: ({ children }) => (
    <ol className="marker:text-muted-foreground my-3 list-decimal space-y-1.5 pl-5 first:mt-0 last:mb-0">{children}</ol>
  ),
  li: ({ children }) => (
    // a list inside a list keeps the outer rhythm rather than starting its own
    <li className="pl-1 [&>ol]:my-1.5 [&>ul]:my-1.5 [&>p]:my-0">
      <Mentions>{children}</Mentions>
    </li>
  ),
  strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  a: ({ href, children }) => (
    // external links open in the user's browser, not inside the app shell
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className="text-primary decoration-primary/40 hover:decoration-primary underline underline-offset-2"
    >
      {children}
    </a>
  ),
  blockquote: ({ children }) => (
    <blockquote className="text-muted-foreground my-3 border-l-2 pl-3.5">{children}</blockquote>
  ),
  hr: () => <hr className="my-5" />,
  code: ({ className, children, ...props }) => {
    // react-markdown gives inline code no language class; a fenced block gets one,
    // and multi-line content is a block even without a language
    const text = String(children);
    const isBlock = /language-/.test(className ?? "") || text.includes("\n");
    if (!isBlock) {
      return (
        <code className="bg-muted rounded-[5px] px-1.5 py-0.5 font-mono text-[0.86em] break-words" {...props}>
          {children}
        </code>
      );
    }
    return (
      <code className="font-mono text-[0.86em] leading-relaxed" {...props}>
        {children}
      </code>
    );
  },
  pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
  // rules between the rows, not around every cell: the columns line the table up on their own
  table: ({ children }) => (
    <div className="my-3 overflow-x-auto rounded-lg border">
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
    <div className="group/code relative my-3">
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
      {tail && <div className={cn("text-message leading-message break-words whitespace-pre-wrap", settled && "mt-3")}>{tail}</div>}
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
