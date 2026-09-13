import { useState } from "react";
import { TableOfContents } from "lucide-react";
import type { Message } from "./api";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

const hhmm = (ts: number) => {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

/** A quoted reply leads with the quote; what was actually asked is the line after it. */
function gist(text: string): string {
  const lines = text.split("\n").map((l) => l.trim());
  return lines.find((l) => l && !l.startsWith(">")) ?? lines.find(Boolean) ?? "";
}

/**
 * A long record is read by looking for the question you asked, so your own
 * messages are its table of contents. A group has several people asking and no
 * single thread to walk, so it has none.
 */
export function Outline({ messages, onJump }: { messages: Message[]; onJump: (messageId: string) => void }) {
  const [open, setOpen] = useState(false);
  const asked = messages.filter((m) => m.author_kind === "human" && m.card_kind === "text");
  if (asked.length < 2) return null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant={open ? "secondary" : "ghost"} size="icon-sm" title="翻记录">
          <TableOfContents className="size-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent side="bottom" align="end" className="max-h-[60vh] w-80 overflow-y-auto rounded-xl p-1.5">
        <div className="text-muted-foreground px-2 pt-1 pb-1.5 text-xs">你问过的</div>
        {asked.map((m) => (
          <button
            key={m.id}
            type="button"
            onClick={() => {
              setOpen(false);
              onJump(m.id);
            }}
            className="hover:bg-accent flex w-full items-baseline gap-2 rounded-lg px-2 py-1.5 text-left"
          >
            <span className="min-w-0 flex-1 truncate text-sm">
              {gist(String((JSON.parse(m.body_json) as { text?: string }).text ?? ""))}
            </span>
            <span className="text-muted-foreground shrink-0 text-[11px] tabular-nums">{hhmm(m.created_at)}</span>
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
}
