import { Check, Minus } from "lucide-react";
import type { Capabilities } from "./api";
import { useExecutor } from "./executors";
import { useI18n } from "./i18n";
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
const ROWS = ["interceptToolCall", "mutateToolInput", "costLimit", "mcp", "branch"] as const;

export function CapabilityNotes({ caps }: { caps: Capabilities }) {
  const { t } = useI18n();
  const missing = ROWS.filter((key) => !caps[key]);
  return (
    <div className="space-y-1.5">
      <div className="grid grid-cols-2 gap-x-4 gap-y-1">
        {ROWS.map((key) => (
          <div key={key} className="flex items-center gap-1.5 text-xs">
            {caps[key] ? (
              <Check className="text-muted-foreground size-3 shrink-0" />
            ) : (
              <Minus className="text-muted-foreground/40 size-3 shrink-0" />
            )}
            <span className={caps[key] ? "" : "text-muted-foreground/60 line-through"}>
              {t(`capability.${key}`)}
            </span>
          </div>
        ))}
      </div>
      <p className="text-muted-foreground text-xs">
        {caps.midRunInject.includes("steer") ? t("capability.midRun.steer") : t("capability.midRun.queue")}
        {missing.length > 0 && t("capability.missing", { count: missing.length })}
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
        {/* just the agent's name: a bare count beside it reads as noise, and the
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
