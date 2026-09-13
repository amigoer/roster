import { Check, Minus } from "lucide-react";
import type { Capabilities } from "./api";
import { useExecutor } from "./executors";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

/**
 * The design calls for telling the user what the current backend lacks rather
 * than silently hiding the feature -- a missing button is indistinguishable
 * from a broken one.
 */
const ROWS = [
  { key: "interceptToolCall", label: "执行前拦截工具" },
  { key: "mutateToolInput", label: "放行时可改参数" },
  { key: "costLimit", label: "成本上限" },
  { key: "mcp", label: "MCP" },
  { key: "branch", label: "分支与恢复" },
] as const;

export function CapabilityNotes({ caps }: { caps: Capabilities }) {
  const missing = ROWS.filter((r) => !caps[r.key]);
  return (
    <div className="space-y-1.5">
      <div className="grid grid-cols-2 gap-x-4 gap-y-1">
        {ROWS.map((r) => (
          <div key={r.key} className="flex items-center gap-1.5 text-xs">
            {caps[r.key] ? (
              <Check className="text-muted-foreground size-3 shrink-0" />
            ) : (
              <Minus className="text-muted-foreground/40 size-3 shrink-0" />
            )}
            <span className={caps[r.key] ? "" : "text-muted-foreground/60 line-through"}>
              {r.label}
            </span>
          </div>
        ))}
      </div>
      <p className="text-muted-foreground text-xs">
        中途插话：
        {caps.midRunInject.includes("steer") ? "可打断并纠正" : "只能排到下一轮"}
        {missing.length > 0 && ` · 划掉的 ${missing.length} 项这个执行器不支持`}
      </p>
    </div>
  );
}

/** The compact form for the conversation header. */
export function CapabilityBadge({ executor, caps }: { executor: string; caps?: Capabilities }) {
  const { label } = useExecutor()(executor);
  if (!caps) {
    return (
      <Badge variant="outline" className="px-1.5 py-0 text-[10px] font-normal">
        {label}
      </Badge>
    );
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* just the executor's name: a bare count beside it reads as noise, and the
            tooltip already spells out what it can and cannot do */}
        <Badge variant="outline" className="cursor-default px-1.5 py-0 text-[10px] font-normal">
          {label}
        </Badge>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="w-64 p-3">
        <CapabilityNotes caps={caps} />
      </TooltipContent>
    </Tooltip>
  );
}
