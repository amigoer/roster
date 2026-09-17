import { Search } from "lucide-react";
import { cn } from "@/lib/utils";

/** Every list in the middle column -- conversations, contacts, settings -- shares one row. */
export const ROW =
  "relative flex w-full items-center gap-3 rounded-[10px] px-2.5 py-2 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/60";

/** Hover and selected must not look the same, or you cannot tell which one you are actually in. */
export const rowState = (selected: boolean) => (selected ? "bg-selected" : "hover:bg-accent active:bg-foreground/[0.07]");

/** Rows are inset from the column edge; labels line up with the avatars inside them. */
export const LIST_BODY = "px-2 pb-2";

export function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div className="text-muted-foreground px-2.5 pt-3 pb-1 text-[11px] font-medium">{children}</div>;
}

export function ListSearch({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
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
          }}
          placeholder={placeholder}
          spellCheck={false}
          className={cn(
            "bg-foreground/[0.045] placeholder:text-muted-foreground h-8 w-full rounded-lg border border-transparent pr-2.5 pl-8 text-[13px] outline-none",
            "focus-visible:border-ring/60 focus-visible:bg-background focus-visible:ring-ring/20 transition-[background-color,border-color,box-shadow] focus-visible:ring-[3px]",
          )}
        />
      </div>
    </div>
  );
}
