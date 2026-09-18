import { useRef, useState } from "react";
import {
  Archive,
  ArchiveRestore,
  MessageSquareCheck,
  MessageSquareDot,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Trash2,
} from "lucide-react";
import { api, type Conversation } from "./api";
import { useI18n } from "./i18n";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

export interface ConversationActions {
  conv: Conversation;
  /** the sessions a bot's row stands for; marking the row read reads every one of them */
  sessions?: Conversation[];
  onRename: () => void;
  /** archived or deleted: the caller decides what to select next */
  onGone: (id: string) => void;
  /** a direct chat can start another session with the same bot */
  onNewSession?: () => void;
}

/** The ... menu and the right-click menu list the same actions; each lends the parts that belong to it. */
interface Kit {
  Item: React.ComponentType<{ onSelect?: () => void; variant?: "default" | "destructive"; children: React.ReactNode }>;
  Separator: React.ComponentType;
}

const DROPDOWN: Kit = { Item: DropdownMenuItem, Separator: DropdownMenuSeparator };
const CONTEXT: Kit = { Item: ContextMenuItem, Separator: ContextMenuSeparator };

function useActions({ conv, sessions, onRename, onGone, onNewSession }: ConversationActions) {
  const [confirming, setConfirming] = useState(false);
  // a bot's row moves on to its next session once one is deleted; the dialog fading out still names the one it asked about
  const [asked, setAsked] = useState(conv);
  const { t } = useI18n();
  // a pick that puts the caret somewhere runs once the menu has closed: run at once, the closing menu pulls focus back to where it was
  const pending = useRef<(() => void) | null>(null);
  const later = (fn: () => void) => () => {
    pending.current = fn;
  };
  const onCloseAutoFocus = (e: Event) => {
    const fn = pending.current;
    pending.current = null;
    if (!fn) return;
    e.preventDefault();
    fn();
  };

  const archive = async () => {
    await api.archive(conv.id, !conv.archived);
    if (!conv.archived) onGone(conv.id);
  };

  // what reading clears; a pending approval or a stuck run is not settled by looking at it
  const readable = (sessions ?? [conv]).filter(
    (c) => c.attention === "waiting_input" || c.attention === "error" || c.attention === "unread",
  );

  const items = ({ Item, Separator }: Kit) => (
    <>
      {onNewSession && (
        <>
          <Item onSelect={later(onNewSession)}>
            <Plus className="size-3.5" />
            {t("session.new")}
          </Item>
          <Separator />
        </>
      )}
      {/* an archived conversation is out of the list these two arrange */}
      {!conv.archived && (
        <>
          <Item onSelect={() => void api.pin(conv.id, !conv.pinned)}>
            {conv.pinned ? (
              <>
                <PinOff className="size-3.5" />
                {t("conversation.unpin")}
              </>
            ) : (
              <>
                <Pin className="size-3.5" />
                {t("conversation.pin")}
              </>
            )}
          </Item>
          <Item
            onSelect={() => {
              if (readable.length > 0) for (const c of readable) void api.markRead(c.id);
              else void api.markUnread(conv.id);
            }}
          >
            {readable.length > 0 ? (
              <>
                <MessageSquareCheck className="size-3.5" />
                {t("conversation.markRead")}
              </>
            ) : (
              <>
                <MessageSquareDot className="size-3.5" />
                {t("conversation.markUnread")}
              </>
            )}
          </Item>
          <Separator />
        </>
      )}
      <Item onSelect={later(onRename)}>
        <Pencil className="size-3.5" />
        {t("common.rename")}
      </Item>
      <Item onSelect={() => void archive()}>
        {conv.archived ? (
          <>
            <ArchiveRestore className="size-3.5" />
            {t("common.unarchive")}
          </>
        ) : (
          <>
            <Archive className="size-3.5" />
            {t("common.archive")}
          </>
        )}
      </Item>
      <Separator />
      <Item
        variant="destructive"
        onSelect={() => {
          setAsked(conv);
          setConfirming(true);
        }}
      >
        <Trash2 className="size-3.5" />
        {t("common.delete")}
      </Item>
    </>
  );

  const dialog = <DeleteConversation conv={asked} open={confirming} onOpenChange={setConfirming} onDeleted={onGone} />;
  return { items, onCloseAutoFocus, dialog };
}

export function ConversationMenu({ className, ...actions }: ConversationActions & { className?: string }) {
  const menu = useActions(actions);
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            // the row is a button; without this the click selects the conversation
            onClick={(e) => e.stopPropagation()}
            className={cn(
              "text-muted-foreground hover:bg-background hover:text-foreground size-6 shrink-0 rounded-md opacity-0 transition-opacity group-hover/item:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100",
              className,
            )}
          >
            <MoreHorizontal className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()} onCloseAutoFocus={menu.onCloseAutoFocus}>
          {menu.items(DROPDOWN)}
        </DropdownMenuContent>
      </DropdownMenu>

      {menu.dialog}
    </>
  );
}

/** A right click anywhere on the row opens the ... menu's actions at the pointer, without opening the conversation. */
export function ConversationContextMenu({ children, ...actions }: ConversationActions & { children: React.ReactElement }) {
  const menu = useActions(actions);
  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger
          asChild
          // React bubbles through portals: a right click on the row's own open ... menu or dialog must not open this one too
          onContextMenu={(e) => {
            if (!e.currentTarget.contains(e.target as Node)) e.preventDefault();
          }}
        >
          {children}
        </ContextMenuTrigger>
        <ContextMenuContent onCloseAutoFocus={menu.onCloseAutoFocus}>
          {menu.items(CONTEXT)}
        </ContextMenuContent>
      </ContextMenu>

      {menu.dialog}
    </>
  );
}

export function DeleteConversation({
  conv,
  open,
  onOpenChange,
  onDeleted,
}: {
  conv: Conversation;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDeleted: (id: string) => void;
}) {
  const { t } = useI18n();
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent onClick={(e) => e.stopPropagation()}>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("conversation.deleteTitle", { title: conv.title })}</AlertDialogTitle>
          <AlertDialogDescription>{t("conversation.deleteBody")}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={() => {
              void api.remove(conv.id);
              onDeleted(conv.id);
            }}
          >
            {t("common.delete")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** Enter or leaving the field saves; Escape keeps the old title. */
export function RenameInput({
  conv,
  onDone,
  className,
  style,
}: {
  conv: Conversation;
  onDone: () => void;
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <input
      autoFocus
      defaultValue={conv.title}
      style={style}
      // field-sizing keeps the box the width of the text, so whatever sits beside it is not shoved away
      className={cn(
        "border-ring/60 ring-ring/20 field-sizing-content max-w-full min-w-24 rounded border px-1.5 py-0.5 font-semibold ring-[3px] outline-none",
        className,
      )}
      onFocus={(e) => e.currentTarget.select()}
      onBlur={(e) => {
        const v = e.currentTarget.value.trim();
        if (v && v !== conv.title) void api.rename(conv.id, v);
        onDone();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !e.nativeEvent.isComposing) e.currentTarget.blur();
        if (e.key === "Escape") {
          e.currentTarget.value = conv.title;
          e.currentTarget.blur();
        }
      }}
    />
  );
}
