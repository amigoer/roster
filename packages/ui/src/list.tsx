import { Search } from "lucide-react";
import { cn } from "@/lib/utils";

/** Every list in the middle column -- conversations, contacts, settings -- shares one row. */
export const ROW =
  "relative flex w-full items-center gap-3 rounded-[10px] px-2.5 py-2 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/60";

/** Hover and selected must not look the same, or you cannot tell which one you are actually in. */
export const rowState = (selected: boolean) => (selected ? "bg-selected" : "hover:bg-accent active:bg-foreground/[0.07]");

/** Rows are inset from the column edge; labels line up with the avatars inside them. */
export const LIST_BODY = "px-2 pb-2";

/** A field the way the search box draws one: a faint fill, and no outline until it is focused. */
export const FIELD =
  "bg-foreground/[0.045] placeholder:text-muted-foreground rounded-lg border border-transparent outline-none focus-visible:border-ring/60 focus-visible:bg-background focus-visible:ring-ring/20 transition-[background-color,border-color,box-shadow] focus-visible:ring-[3px]";

export function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div className="text-muted-foreground px-2.5 pt-3 pb-1 text-[11px] font-medium">{children}</div>;
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
    <div className="shrink-0 px-2 pb-1.5">
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
    </div>
  );
}
