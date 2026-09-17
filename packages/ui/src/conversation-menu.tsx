import { useState } from "react";
import { Archive, ArchiveRestore, MoreHorizontal, Pencil, Trash2 } from "lucide-react";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

export function ConversationMenu({
  conv,
  className,
  onRename,
  onGone,
}: {
  conv: Conversation;
  className?: string;
  onRename: () => void;
  /** archived or deleted: the caller decides what to select next */
  onGone: (id: string) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const { t } = useI18n();

  const archive = async () => {
    await api.archive(conv.id, !conv.archived);
    if (!conv.archived) onGone(conv.id);
  };

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
        <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
          <DropdownMenuItem onSelect={onRename}>
            <Pencil className="size-3.5" />
            {t("common.rename")}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => void archive()}>
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
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onSelect={() => setConfirming(true)}>
            <Trash2 className="size-3.5" />
            {t("common.delete")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <DeleteConversation conv={conv} open={confirming} onOpenChange={setConfirming} onDeleted={onGone} />
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
