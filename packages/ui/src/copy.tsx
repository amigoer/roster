import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "@/lib/utils";

/** http://127.0.0.1 counts as a secure context, but a denied permission still throws. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.append(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

/** Shows the result for a moment: a copy button with no feedback feels broken. */
export function useCopy() {
  const [copied, setCopied] = useState(false);
  const copy = async (text: string) => {
    if (await copyText(text)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    }
  };
  return { copied, copy };
}

export function CopyIcon({ copied, className }: { copied: boolean; className?: string }) {
  return copied ? (
    <Check className={cn("size-3.5", className)} />
  ) : (
    <Copy className={cn("size-3.5", className)} />
  );
}
