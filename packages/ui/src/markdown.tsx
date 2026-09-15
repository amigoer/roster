import { Children, createContext, memo, useContext, useRef } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";
import { CopyIcon, useCopy } from "./copy";
import { useI18n } from "./i18n";
import { segments } from "./mentions";

/** Member names in the current conversation, so @name renders as an address. */
export const MentionNames = createContext<readonly string[]>([]);

export function MentionChip({ children }: { children: React.ReactNode }) {
  return <span className="rounded bg-sky-500/10 px-0.5 font-medium text-sky-700 dark:text-sky-300">{children}</span>;
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
    <p className="my-2 first:mt-0 last:mb-0">
      <Mentions>{children}</Mentions>
    </p>
  ),
  h1: ({ children }) => <h1 className="mt-4 mb-2 text-[1.15em] font-semibold first:mt-0">{children}</h1>,
  h2: ({ children }) => <h2 className="mt-4 mb-2 text-[1em] font-semibold first:mt-0">{children}</h2>,
  h3: ({ children }) => <h3 className="mt-3 mb-1.5 text-[1em] font-semibold first:mt-0">{children}</h3>,
  ul: ({ children }) => <ul className="my-2 ml-4 list-disc space-y-1">{children}</ul>,
  ol: ({ children }) => <ol className="my-2 ml-4 list-decimal space-y-1">{children}</ol>,
  li: ({ children }) => (
    <li className="pl-0.5">
      <Mentions>{children}</Mentions>
    </li>
  ),
  strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  a: ({ href, children }) => (
    // external links open in the user's browser, not inside the app shell
    <a href={href} target="_blank" rel="noreferrer noopener" className="underline underline-offset-2">
      {children}
    </a>
  ),
  blockquote: ({ children }) => (
    <blockquote className="text-muted-foreground my-2 border-l-2 pl-3">{children}</blockquote>
  ),
  hr: () => <hr className="my-3" />,
  code: ({ className, children, ...props }) => {
    // react-markdown gives inline code no language class; a fenced block gets one,
    // and multi-line content is a block even without a language
    const text = String(children);
    const isBlock = /language-/.test(className ?? "") || text.includes("\n");
    if (!isBlock) {
      return (
        <code className="bg-muted rounded px-1 py-0.5 font-mono text-[0.85em]" {...props}>
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
  table: ({ children }) => (
    <div className="my-2 overflow-x-auto">
      <table className="w-full border-collapse text-[0.86em]">{children}</table>
    </div>
  ),
  th: ({ children }) => <th className="border px-2 py-1 text-left font-medium">{children}</th>,
  td: ({ children }) => <td className="border px-2 py-1 align-top">{children}</td>,
};

/** Grabbing a snippet is the most common thing done with an agent's answer. */
function CodeBlock({ children }: { children?: React.ReactNode }) {
  const ref = useRef<HTMLPreElement>(null);
  const { copied, copy } = useCopy();
  const { t } = useI18n();
  return (
    <div className="group/code relative my-2">
      {/* its own scroller: a long line must not widen the bubble */}
      <pre ref={ref} className="bg-muted overflow-x-auto rounded-md p-3 pr-10">
        {children}
      </pre>
      <button
        onClick={() => void copy(ref.current?.innerText ?? "")}
        title={t("markdown.copyCode")}
        className="text-muted-foreground hover:bg-background hover:text-foreground absolute top-2 right-2 rounded p-1 opacity-0 transition-opacity group-hover/code:opacity-100 focus-visible:opacity-100"
      >
        <CopyIcon copied={copied} />
      </button>
    </div>
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
    <div className={cn("text-message leading-relaxed break-words", className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={COMPONENTS}>
        {children}
      </ReactMarkdown>
    </div>
  );
});
