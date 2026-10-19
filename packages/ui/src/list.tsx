import { Search } from "lucide-react";
import { cn } from "@/lib/utils";

/** Every list in the middle column -- conversations, contacts, settings -- shares one row. */
export const ROW =
  "relative flex w-full items-center gap-3 px-3.5 py-2.5 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-inset";

/** Hover and selected must not look the same, or you cannot tell which one you are actually in. */
export const rowState = (selected: boolean) => (selected ? "bg-accent" : "hover:bg-black/[0.045] active:bg-black/[0.07] dark:hover:bg-white/[0.06] dark:active:bg-white/[0.09]");

/** Rows run edge to edge in this column, the way a messenger's list does. */
export const LIST_BODY = "pb-2";

/** A field the way the search box draws one: a white pill on the grey column, no outline until it is focused. */
const FIELD =
  "bg-card placeholder:text-muted-foreground rounded-md border border-transparent outline-none focus-visible:border-primary/50 focus-visible:ring-2 focus-visible:ring-primary/15 transition-[background-color,border-color,box-shadow] dark:bg-white/[0.08]";

export function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div className="text-muted-foreground px-3.5 pt-3 pb-1 text-[11px] font-medium">{children}</div>;
}

export function ListSearch({
  value,
  onChange,
  placeholder,
  onEnter,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  /** Enter with something typed: the first match is the one meant */
  onEnter?: () => void;
}) {
  return (
    <div className="relative">
      <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2" />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") onChange("");
          else if (e.key === "Enter" && value.trim() && !e.nativeEvent.isComposing) onEnter?.();
        }}
        placeholder={placeholder}
        spellCheck={false}
        className={cn(FIELD, "h-8 w-full pr-2.5 pl-8 text-[13px]")}
      />
    </div>
  );
}
