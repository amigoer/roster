import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, FilePenLine, Gauge, ListChecks, Shield, ShieldCheck, ShieldHalf, ShieldOff, Zap, type LucideIcon } from "lucide-react";
import {
  activeMembers,
  api,
  type Conversation,
  type Member,
  type Quota,
  type SessionInfo,
  type SessionOptions,
  type SessionSettings,
} from "./api";
import { useExecutor } from "./executors";
import { useI18n, type Key } from "./i18n";
import { ProviderIcon, providerOf } from "./provider-icon";
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
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

type Item = { id: string; label: string; description?: string };
type Model = SessionOptions["models"][number];

/** what the toolbar can be asked to open: one of its pickers, or the context card behind the ring */
export type Picker = "model" | "effort" | "mode" | "context";
/** A picker the composer wants opened; the nonce makes asking twice for the same one open it again. */
export type PickerRequest = { picker: Picker; nonce: number };

/** A control in the composer's toolbar: as quiet as the placeholder until pointed at. */
export const PILL =
  "text-muted-foreground hover:bg-accent hover:text-foreground active:bg-foreground/[0.07] aria-expanded:bg-accent aria-expanded:text-foreground focus-visible:ring-ring/50 inline-flex h-8 min-w-0 items-center gap-1.5 rounded-lg px-2 text-[13px] whitespace-nowrap outline-none transition-colors focus-visible:ring-2 [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4";

/** The same control in a list row, among lines of small text. */
const DENSE = "h-6 gap-1 rounded-md px-1.5 text-xs [&_svg:not([class*='size-'])]:size-3.5";

/** A pill that only reports: it keeps the toolbar's shape without inviting a click. */
const STATIC = "hover:text-muted-foreground hover:bg-transparent";

/** The card behind every pill, and the rows in it, at the toolbar's own text size. */
const CARD = "rounded-xl p-1.5";
const HEADING = "text-muted-foreground px-2.5 pt-1.5 pb-1 text-xs font-medium";
const ROW = "gap-2.5 rounded-lg px-2.5 py-1.5 text-[13px]";
const SEPARATOR = "mx-1 my-1.5";

/** Newest first across families, the way Claude Code orders its picker. */
const FAMILIES = ["fable", "opus", "sonnet", "haiku"];
const familyOf = (m: Model) => m.label.split(" ")[0]?.toLowerCase() ?? m.id;
const rankOf = (m: Model) => {
  const i = FAMILIES.indexOf(familyOf(m));
  return i === -1 ? FAMILIES.length : i;
};

/** Claude Code's modes by what they let through; a mode another backend names gets the plain shield. */
const MODE_ICONS: Record<string, LucideIcon> = {
  default: ShieldCheck,
  acceptEdits: FilePenLine,
  plan: ListChecks,
  auto: ShieldHalf,
  bypassPermissions: ShieldOff,
};

/** A mode that asks nothing before acting stays tinted, so it is never on by accident. */
const UNGUARDED = new Set(["bypassPermissions"]);

const FAST_UNAVAILABLE: Record<string, Extract<Key, `session.fastOff.${string}`>> = {
  extra_usage_disabled: "session.fastOff.extraUsage",
  free: "session.fastOff.free",
  not_first_party: "session.fastOff.firstParty",
  model_not_allowed: "session.fastOff.model",
  disabled_by_env: "session.fastOff.env",
  preference: "session.fastOff.preference",
  network_error: "session.fastOff.network",
};

/** The number key that picks a row, drawn as the key. */
function Keycap({ children }: { children: ReactNode }) {
  return (
    <kbd className="text-muted-foreground border-border inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-[4px] border px-1 font-[inherit] text-[10px] leading-none font-medium tabular-nums">
      {children}
    </kbd>
  );
}

function Entry({ item, index, current }: { item: Item; index: number | undefined; current: string | undefined }) {
  // beside the first line of a two-line row, not the middle of both
  const top = item.description ? "mt-0.5" : undefined;
  return (
    <>
      <div className="min-w-0 flex-1">
        <div className="truncate">{item.label}</div>
        {item.description && <div className="text-muted-foreground mt-px text-xs leading-snug">{item.description}</div>}
      </div>
      {item.id === current ? (
        <Check className={cn("text-primary ml-3 size-4", top)} strokeWidth={2.5} />
      ) : (
        index !== undefined && (
          <span className={cn("ml-3 flex shrink-0", top)}>
            <Keycap>{index + 1}</Keycap>
          </span>
        )
      )}
    </>
  );
}

/** Claude Code's picker: the current choice ticked, the rest numbered, and a number key picks while the list is open. */
function PickerMenu({
  trigger,
  triggerClassName,
  label,
  hint,
  heading,
  items,
  iconOf,
  current,
  onPick,
  width,
  openWhen,
  onClosed,
  children,
}: {
  trigger: ReactNode;
  triggerClassName: string;
  /** what the trigger does, for when its text is hidden or only half of what it means */
  label: string;
  hint?: string;
  heading: string;
  items: Item[];
  iconOf?: (id: string) => LucideIcon;
  current: string | undefined;
  onPick: (id: string) => void;
  width: string;
  /** a nonce: each new value opens the list */
  openWhen?: number;
  /** where focus goes once the list closes; without it, back to the trigger */
  onClosed?: () => void;
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  // a request from before this list was on screen was already answered, or was for another member's
  const seen = useRef(openWhen);
  useEffect(() => {
    if (!openWhen || openWhen === seen.current) return;
    seen.current = openWhen;
    setOpen(true);
  }, [openWhen]);
  // focus a closing list hands back to its trigger is not a visit, so it does not open the tooltip
  const handedBack = useRef(false);
  const choose = (id: string) => {
    setOpen(false);
    if (id !== current) onPick(id);
  };
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      {/* slow to show: the pill already says most of it, and a pointer passing over on its way to click should not pop anything */}
      <Tooltip delayDuration={700}>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger
            className={triggerClassName}
            aria-label={label}
            onFocus={(e) => {
              if (!handedBack.current) return;
              handedBack.current = false;
              // the tooltip opens on focus unless the event comes to it already handled
              e.preventDefault();
            }}
          >
            {trigger}
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={6} className="max-w-64">
          {hint ?? label}
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent
        side="top"
        align="start"
        sideOffset={8}
        collisionPadding={12}
        className={cn(CARD, width)}
        onKeyDown={(e) => {
          const n = Number(e.key);
          const item = Number.isInteger(n) && n >= 1 ? items[n - 1] : undefined;
          if (!item) return;
          e.preventDefault();
          choose(item.id);
        }}
        onCloseAutoFocus={(e) => {
          if (!onClosed) {
            handedBack.current = true;
            // a click outside closes the list without handing focus back
            requestAnimationFrame(() => (handedBack.current = false));
            return;
          }
          // a pick is made on the way to typing, so the caret is where focus goes back to
          e.preventDefault();
          onClosed();
        }}
      >
        <DropdownMenuLabel className={HEADING}>{heading}</DropdownMenuLabel>
        {items.map((item, i) => {
          const Icon = iconOf?.(item.id);
          return (
            <DropdownMenuItem key={item.id} onSelect={() => choose(item.id)} className={cn(ROW, item.description && "items-start")}>
              {Icon && <Icon className={cn("size-4", item.description && "mt-0.5")} />}
              <Entry item={item} index={i < 9 ? i : undefined} current={current} />
            </DropdownMenuItem>
          );
        })}
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * What a member's session runs on, as pills: the model, its thinking level,
 * then the permission mode. In the composer's toolbar they are what the next
 * message runs on, so there they show only while it goes to one member.
 */
export function SessionPickers({
  conversationId,
  member,
  info,
  choices,
  request,
  onError,
  onClosed,
  dense = false,
}: {
  conversationId: string;
  member: Member | undefined;
  info: SessionInfo | undefined;
  choices: SessionOptions | undefined;
  request?: PickerRequest | null;
  onError: (error: string | null) => void;
  /** a picker closed, and focus goes to where the message is typed */
  onClosed?: () => void;
  /** sized for a list row, where the mode is its icon alone */
  dense?: boolean;
}) {
  const { t } = useI18n();
  const executor = useExecutor();
  // a level shows as picked at once, until the session reports the same one
  const [effortPick, setEffortPick] = useState<string | null>(null);
  const reported = info?.effort;
  useEffect(() => {
    if (effortPick !== null && effortPick === reported) setEffortPick(null);
  }, [effortPick, reported]);
  if (!member || !info) return null;

  const opens = (picker: Picker) => (request?.picker === picker ? request.nonce : undefined);
  const pick = (patch: SessionSettings) =>
    api
      .configure(conversationId, member.id, patch)
      .catch((e: unknown) => ({ error: String(e) }))
      .then((r) => onError(r.error ?? null));
  const pickEffort = (id: string) => {
    setEffortPick(id);
    // settled with no matching report: it failed, or the session took another level; show what it has
    void pick({ effort: id }).then(() => setEffortPick((p) => (p === id ? null : p)));
  };

  // only the agent's own models: where they come from is the agent's, not the session's, to change
  const models = choices?.models ?? [];
  const model = models.find((m) => m.resolved === info.model || m.id === info.model);
  // the newest of each family leads; older versions and variants wait under More models
  const primary: Model[] = [];
  const more: Model[] = [];
  for (const m of models) (primary.some((p) => familyOf(p) === familyOf(m)) ? more : primary).push(m);
  primary.sort((a, b) => rankOf(a) - rankOf(b));
  // the one in use is never out of sight under More models: it takes the row after its family's lead
  if (model && more.includes(model)) {
    more.splice(more.indexOf(model), 1);
    primary.splice(primary.findIndex((p) => familyOf(p) === familyOf(model)) + 1, 0, model);
  }
  // named as its row in the list, so the pill and the list never disagree
  const modelName = model?.label ?? info.modelLabel ?? info.model;

  const efforts = info.effort ? (choices?.efforts ?? []).filter((e) => (model ? model.efforts.includes(e.id) : true)) : [];
  const effort = efforts.find((e) => e.id === (effortPick ?? info.effort));
  const effortName = effort?.label ?? effortPick ?? info.effort;
  const fastOn = info.fast === "on" || info.fast === "cooldown";
  const fastBlocked = choices?.fast?.available === false;

  const modes = choices?.modes ?? [];
  const mode = modes.find((m) => m.id === info.mode);
  const ModeIcon = (info.mode && MODE_ICONS[info.mode]) || Shield;
  const unguarded = info.mode !== undefined && UNGUARDED.has(info.mode);

  const modelFace = info.model && (
    <>
      {/* a routed id such as "deepseek/deepseek-chat" names its maker in the last part */}
      <ProviderIcon
        provider={providerOf({ model: info.model.split("/").pop() ?? null }, executor(member.executor_id).type)}
        mono
        className={dense ? "size-3.5" : "size-4"}
      />
      <span className="truncate">{modelName}</span>
      {fastOn && (
        <Zap className={cn(dense ? "size-3" : "size-3.5", "fill-current text-amber-500", info.fast === "cooldown" && "opacity-50")} />
      )}
    </>
  );
  const effortFace = effortName && (
    <>
      <Gauge />
      {/* a narrow composer keeps the icon, as the mode does; the level is in the tooltip and the list */}
      <span className={cn("truncate", !dense && "@max-lg:hidden")}>{effortName}</span>
    </>
  );
  // squeezed past its name, the pill cuts what is left rather than spill over the next one
  const size = cn(dense ? DENSE : "max-w-64", "overflow-hidden");

  return (
    <>
      {modelFace &&
        (models.length > 0 ? (
          <PickerMenu
            trigger={modelFace}
            triggerClassName={cn(PILL, size)}
            label={`${t("session.model")} · ${modelName}`}
            hint={model?.description}
            heading={t("session.model")}
            // names only, as Claude Code's model list shows them
            items={primary.map(({ id, label }) => ({ id, label }))}
            current={model?.id}
            onPick={(id) => void pick({ model: id })}
            width="w-64"
            openWhen={opens("model")}
            onClosed={onClosed}
          >
            {more.length > 0 && (
              <DropdownMenuSub>
                <DropdownMenuSubTrigger className={ROW}>{t("session.moreModels")}</DropdownMenuSubTrigger>
                <DropdownMenuSubContent className={cn(CARD, "min-w-52")}>
                  {more.map((m) => (
                    <DropdownMenuItem key={m.id} onSelect={() => m.id !== model?.id && void pick({ model: m.id })} className={ROW}>
                      <Entry item={{ id: m.id, label: m.label }} index={undefined} current={model?.id} />
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            )}
            {model?.fast && (
              <>
                <DropdownMenuSeparator className={SEPARATOR} />
                <DropdownMenuItem
                  role="menuitemcheckbox"
                  aria-checked={fastOn}
                  aria-disabled={fastBlocked || undefined}
                  // the list stays open, so the switch is seen to move
                  onSelect={(e) => {
                    e.preventDefault();
                    if (!fastBlocked) void pick({ fast: !fastOn });
                  }}
                  className={cn(ROW, fastBlocked && "items-start")}
                >
                  <Zap className={cn("size-4", fastOn ? "fill-current text-amber-500" : "text-muted-foreground", fastBlocked && "mt-0.5")} />
                  <span className="min-w-0 flex-1">
                    <span className={cn("block truncate", fastBlocked && "text-muted-foreground")}>{t("session.fast")}</span>
                    {fastBlocked && (
                      <span className="text-muted-foreground mt-px block text-xs leading-snug">
                        {t(FAST_UNAVAILABLE[choices?.fast?.reason ?? ""] ?? "session.fastOff.unknown")}
                      </span>
                    )}
                  </span>
                  {/* the row is the control; the switch only shows its state */}
                  <Switch checked={fastOn} disabled={fastBlocked} tabIndex={-1} aria-hidden className={cn("pointer-events-none ml-3", fastBlocked && "mt-0.5")} />
                </DropdownMenuItem>
              </>
            )}
          </PickerMenu>
        ) : (
          <span className={cn(PILL, size, STATIC)}>{modelFace}</span>
        ))}
      {effortFace &&
        (efforts.length > 0 ? (
          <PickerMenu
            trigger={effortFace}
            // short enough to hold its width; the model's name is what gives way
            triggerClassName={cn(PILL, dense && DENSE, "shrink-0")}
            label={`${t("session.effort")} · ${effortName}`}
            hint={effort?.description ? `${effort.label} · ${effort.description}` : undefined}
            heading={t("session.effort")}
            items={efforts}
            current={effort?.id}
            onPick={pickEffort}
            width="w-64"
            openWhen={opens("effort")}
            onClosed={onClosed}
          />
        ) : (
          <span className={cn(PILL, dense && DENSE, "shrink-0", STATIC)}>{effortFace}</span>
        ))}
      {info.mode && modes.length > 0 && (
        <PickerMenu
          trigger={
            <>
              <ModeIcon />
              {/* a narrow composer keeps the icon; the name is in the tooltip and the list */}
              {!dense && <span className="truncate @max-lg:hidden">{mode?.label ?? info.mode}</span>}
            </>
          }
          triggerClassName={cn(
            PILL,
            dense && DENSE,
            unguarded &&
              "text-amber-600 hover:text-amber-700 aria-expanded:text-amber-700 dark:text-amber-400 dark:hover:text-amber-300 dark:aria-expanded:text-amber-300",
          )}
          label={`${t("session.mode")} · ${mode?.label ?? info.mode}`}
          hint={mode?.description ? `${mode.label} · ${mode.description}` : undefined}
          heading={t("session.mode")}
          items={modes}
          iconOf={(id) => MODE_ICONS[id] ?? Shield}
          current={info.mode}
          onPick={(id) => void pick({ mode: id })}
          width="w-80"
          openWhen={opens("mode")}
          onClosed={onClosed}
        />
      )}
    </>
  );
}

/**
 * The context ring for the member given. With none, as for a group whose members
 * have no context yet, plan limits are the account's, so it shows the first
 * agent that has any.
 */
export function SessionUsage({
  conv,
  member,
  info,
  choices,
  quota,
  request,
  onError,
  dense = false,
}: {
  conv: Conversation;
  member: Member | undefined;
  info: SessionInfo | undefined;
  choices: SessionOptions | undefined;
  quota: Record<string, Quota | null>;
  request?: PickerRequest | null;
  onError: (error: string | null) => void;
  dense?: boolean;
}) {
  const executor = useExecutor();
  const planOwner =
    member?.executor_id ?? [...new Set(activeMembers(conv).map((m) => m.executor_id))].find((id) => quota[id]?.windows.length);
  const compact = async () => {
    if (!member) return;
    const r = await api.compact(conv.id, member.id).catch((e: unknown) => ({ error: String(e) }));
    onError(r.error ?? null);
  };
  return (
    <UsagePanel
      owner={planOwner ? executor(planOwner).label : undefined}
      // a group holds a context per member, so the card says whose this is
      name={activeMembers(conv).length > 1 ? member?.bot.name : undefined}
      context={info?.context}
      cache={info?.cache}
      quota={planOwner ? quota[planOwner] : null}
      busy={conv.run_state === "running"}
      member={member ? { conversationId: conv.id, memberId: member.id } : undefined}
      openWhen={request?.picker === "context" ? request.nonce : undefined}
      // asking for the status is what makes core re-read usage; the answer arrives on the stream
      onOpen={() => void api.status(conv.id)}
      onCompact={member && choices?.compact ? () => void compact() : undefined}
      dense={dense}
    />
  );
}
