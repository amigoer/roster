import { useEffect, useState } from "react";
import { Check } from "lucide-react";
import {
  activeMembers,
  api,
  type Conversation,
  type Quota,
  type SessionInfo,
  type SessionOptions,
  type SessionSettings,
} from "./api";
import { useExecutor } from "./executors";
import { UsagePanel } from "./usage-panel";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

type Item = { id: string; label: string; description?: string };
type Model = SessionOptions["models"][number];

/** what the bar can be asked to open: one of its pickers, or the context card behind the ring */
export type Picker = "model" | "effort" | "mode" | "context";
/** A picker the composer wants opened; the nonce makes asking twice for the same one open it again. */
export type PickerRequest = { picker: Picker; nonce: number };

const trigger =
  "hover:bg-accent data-[state=open]:bg-accent focus-visible:ring-ring/50 inline-flex h-7 min-w-0 items-center rounded-lg px-2 text-sm outline-none transition-colors focus-visible:ring-2";

/** Newest first across families, the way Claude Code orders its picker. */
const FAMILIES = ["fable", "opus", "sonnet", "haiku"];
const familyOf = (m: Model) => m.label.split(" ")[0]?.toLowerCase() ?? m.id;
const rankOf = (m: Model) => {
  const i = FAMILIES.indexOf(familyOf(m));
  return i === -1 ? FAMILIES.length : i;
};

const FAST_UNAVAILABLE: Record<string, string> = {
  extra_usage_disabled: "Requires extra usage",
  free: "Not available on the free plan",
  not_first_party: "Only available through Anthropic",
  model_not_allowed: "Not available for this model",
  disabled_by_env: "Turned off in this environment",
  preference: "Turned off in settings",
  network_error: "Couldn't check availability",
};

function Entry({ item, index, current }: { item: Item; index: number | undefined; current: string | undefined }) {
  return (
    <>
      <div className="min-w-0 flex-1">
        <div className="truncate">{item.label}</div>
        {item.description && <div className="text-muted-foreground text-xs leading-snug">{item.description}</div>}
      </div>
      {item.id === current ? (
        <Check className="size-4 text-blue-600 dark:text-blue-400" />
      ) : (
        index !== undefined && <span className="text-muted-foreground w-4 text-right text-sm tabular-nums">{index + 1}</span>
      )}
    </>
  );
}

/** Claude Code's picker: the current choice ticked, the rest numbered, and a number key picks while the list is open. */
function Menu({
  label,
  className,
  items,
  current,
  onPick,
  align,
  width = "min-w-52",
  openWhen,
  children,
}: {
  label: string;
  className?: string;
  items: Item[];
  current: string | undefined;
  onPick: (id: string) => void;
  align: "start" | "end";
  width?: string;
  /** a nonce: each new value opens the list */
  openWhen?: number;
  children?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (openWhen) setOpen(true);
  }, [openWhen]);
  const choose = (id: string) => {
    setOpen(false);
    if (id !== current) onPick(id);
  };
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger className={cn(trigger, className)}>
        <span className="truncate">{label}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="top"
        align={align}
        className={cn("rounded-xl p-1.5", width)}
        onKeyDown={(e) => {
          const n = Number(e.key);
          const item = Number.isInteger(n) && n >= 1 ? items[n - 1] : undefined;
          if (!item) return;
          e.preventDefault();
          choose(item.id);
        }}
      >
        {items.map((item, i) => (
          <DropdownMenuItem key={item.id} onSelect={() => choose(item.id)} className="gap-6 rounded-lg px-2.5 py-2">
            <Entry item={item} index={i < 9 ? i : undefined} current={current} />
          </DropdownMenuItem>
        ))}
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * What the next message runs on, laid out and named the way Claude Code's
 * composer does it, and switchable from here. A group has no single session to
 * switch, but the plan limits are the account's, so the usage ring still shows.
 */
export function SessionBar({
  conv,
  sessions,
  options,
  quota,
  request,
}: {
  conv: Conversation;
  sessions: Record<string, SessionInfo>;
  options: Record<string, SessionOptions>;
  quota: Record<string, Quota | null>;
  request?: PickerRequest | null;
}) {
  const opens = (picker: Picker) => (request?.picker === picker ? request.nonce : undefined);
  const [error, setError] = useState<string | null>(null);
  const members = activeMembers(conv);
  const solo = conv.shape === "direct" ? members[0] : undefined;
  const info = solo ? sessions[solo.id] : undefined;
  const executor = useExecutor();
  const choices = solo ? options[solo.id] : undefined;
  // a group has no one session, so its ring shows the first agent that has plan limits at all
  const planOwner = solo?.executor_id ?? [...new Set(members.map((m) => m.executor_id))].find((id) => quota[id]?.windows.length);
  const plan = planOwner ? quota[planOwner] : null;
  if (!info && !plan?.windows.length) return null;

  const run = async (call: () => Promise<{ error?: string }>) => {
    setError(null);
    const r = await call().catch((e: unknown) => ({ error: String(e) }));
    if (r.error) setError(r.error);
  };
  const pick = (patch: SessionSettings) => {
    if (solo) void run(() => api.configure(conv.id, solo.id, patch));
  };

  // only the agent's own models: where they come from is the agent's, not the session's, to change
  const models = choices?.models ?? [];
  const model = models.find((m) => m.resolved === info?.model || m.id === info?.model);
  // the newest of each family leads; older versions and variants wait under More models
  const primary: Model[] = [];
  const more: Model[] = [];
  for (const m of models) (primary.some((p) => familyOf(p) === familyOf(m)) ? more : primary).push(m);
  primary.sort((a, b) => rankOf(a) - rankOf(b));

  const efforts = (choices?.efforts ?? []).filter((e) => (model ? model.efforts.includes(e.id) : true));
  const effort = choices?.efforts.find((e) => e.id === info?.effort);
  const mode = choices?.modes.find((m) => m.id === info?.mode);
  const fastBlocked = choices?.fast?.available === false;

  return (
    <div className="mt-1.5 flex min-w-0 items-center gap-1">
      {info?.mode && choices && choices.modes.length > 0 && (
        <Menu
          label={mode?.label ?? info.mode}
          className="text-muted-foreground hover:text-foreground data-[state=open]:text-foreground"
          items={choices.modes}
          current={info.mode}
          onPick={(id) => pick({ mode: id })}
          align="start"
          width="w-72"
          openWhen={opens("mode")}
        />
      )}
      {error && <span className="text-destructive min-w-0 truncate px-1 text-xs">{error}</span>}
      <div className="ml-auto flex min-w-0 items-center gap-0.5">
        {info?.model &&
          (choices && choices.models.length > 0 ? (
            <Menu
              label={info.modelLabel ?? info.model}
              // names only, as Claude Code's model list shows them
              items={primary.map(({ id, label }) => ({ id, label }))}
              current={model?.id}
              onPick={(id) => pick({ model: id })}
              align="end"
              openWhen={opens("model")}
            >
              {more.length > 0 && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger className="rounded-lg px-2.5 py-2">More models</DropdownMenuSubTrigger>
                    <DropdownMenuSubContent className="min-w-52 rounded-xl p-1.5">
                      {more.map((m) => (
                        <DropdownMenuItem
                          key={m.id}
                          onSelect={() => m.id !== model?.id && pick({ model: m.id })}
                          className="gap-6 rounded-lg px-2.5 py-2"
                        >
                          <Entry item={{ id: m.id, label: m.label }} index={undefined} current={model?.id} />
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                </>
              )}
              {model?.fast && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuLabel className="text-muted-foreground px-2.5 pt-2 pb-1 text-sm font-normal">
                    Fast mode
                  </DropdownMenuLabel>
                  <label className="flex items-center justify-between gap-6 px-2.5 py-2 text-sm">
                    <span className="min-w-0">
                      <span className={cn("block", fastBlocked && "text-muted-foreground")}>Enable fast mode</span>
                      {fastBlocked && (
                        <span className="text-muted-foreground block text-xs">
                          {FAST_UNAVAILABLE[choices?.fast?.reason ?? ""] ?? "Unavailable right now"}
                        </span>
                      )}
                    </span>
                    <Switch
                      checked={info.fast === "on" || info.fast === "cooldown"}
                      disabled={fastBlocked}
                      onCheckedChange={(on) => pick({ fast: on })}
                    />
                  </label>
                </>
              )}
            </Menu>
          ) : (
            <span className="px-2 text-sm">{info.modelLabel ?? info.model}</span>
          ))}
        {info?.effort && efforts.length > 0 && (
          <Menu
            label={effort?.label ?? info.effort}
            items={efforts}
            current={info.effort}
            onPick={(id) => pick({ effort: id })}
            align="end"
            width={efforts.some((e) => e.description) ? "w-72" : "min-w-40"}
            openWhen={opens("effort")}
          />
        )}
        <UsagePanel
          owner={planOwner ? executor(planOwner).label : undefined}
          context={info?.context}
          quota={plan}
          busy={conv.run_state === "running"}
          member={solo ? { conversationId: conv.id, memberId: solo.id } : undefined}
          openWhen={opens("context")}
          // asking for the status is what makes core re-read usage; the answer arrives on the stream
          onOpen={() => void api.status(conv.id)}
          onCompact={solo && choices?.compact ? () => void run(() => api.compact(conv.id, solo.id)) : undefined}
        />
      </div>
    </div>
  );
}
