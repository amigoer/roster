import type { Presence } from "./api";
import type { Translate } from "./i18n";
import { toolLabel } from "./steps";

/** What a member is doing, in words; the strip and a bot's card read it the same way. */
export function presenceLabel(t: Translate, p: Presence): string {
  switch (p.state) {
    case "starting":
      return t("presence.starting");
    case "thinking":
      return t("presence.thinking");
    case "writing":
      return t("presence.writing");
    case "tool":
      return p.detail ? t("presence.toolNamed", { tool: toolLabel(t, p.detail) }) : t("presence.tool");
    case "waiting_permission":
      return p.detail ? t("presence.permissionNamed", { tool: toolLabel(t, p.detail) }) : t("presence.permission");
    case "waiting_lock":
      return p.detail ? t("presence.lockNamed", { name: p.detail }) : t("presence.lock");
    case "compacting":
      return t("presence.compacting");
  }
}
