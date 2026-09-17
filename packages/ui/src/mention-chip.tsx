import { createContext, useContext, useMemo } from "react";
import { Users } from "lucide-react";
import type { Bot } from "./api";
import { LogoImage, logoOf, useLogos } from "./bot-avatar";
import { BotCardTrigger } from "./bot-card";
import { segments } from "./mentions";
import { cn } from "@/lib/utils";

/** Who can be addressed in the open conversation, so an @name in a message renders as them. */
export const MentionBots = createContext<readonly Bot[]>([]);

/**
 * A mention as one piece, in a message and in the composer alike: the face,
 * then the name as written. In em, so it follows the text size picked in settings.
 */
export const CHIP =
  "rounded-[0.35em] bg-sky-500/10 py-[0.1em] pr-[0.3em] pl-[0.15em] font-medium whitespace-nowrap text-sky-700 dark:text-sky-300";

const FACE = "mr-[0.2em] inline-block size-[1.15em] align-[-0.22em]";

/** The bot an @name addresses; none for an address to everyone. */
export function botOf(text: string, bots: readonly Bot[]): Bot | undefined {
  const name = text.slice(1).toLowerCase();
  return bots.find((b) => b.name.toLowerCase() === name);
}

export function MentionFace({ bot }: { bot?: Bot }) {
  const logos = useLogos();
  return bot ? (
    <LogoImage logo={logoOf(bot, logos)} className={FACE} />
  ) : (
    <span className={cn(FACE, "inline-flex items-center justify-center rounded-[23%] bg-sky-500/15")}>
      <Users className="size-[0.7em]" strokeWidth={2.5} />
    </span>
  );
}

/** A mention in a message; a click opens the card of the bot it names. */
function MentionChip({ text, bot }: { text: string; bot?: Bot }) {
  const chip = (
    <span className={cn(CHIP, bot && "hover:bg-sky-500/20 transition-colors duration-120")}>
      <MentionFace bot={bot} />
      {text}
    </span>
  );
  return bot ? (
    <BotCardTrigger bot={bot} className="rounded-[0.35em] align-baseline">
      {chip}
    </BotCardTrigger>
  ) : (
    chip
  );
}

/** Text as it was written, with the mentions in it as chips. */
export function MentionText({ text }: { text: string }) {
  const bots = useContext(MentionBots);
  const names = useMemo(() => bots.map((b) => b.name), [bots]);
  return (
    <>
      {segments(text, names).map((s, i) => (s.mention ? <MentionChip key={i} text={s.text} bot={botOf(s.text, bots)} /> : s.text))}
    </>
  );
}
