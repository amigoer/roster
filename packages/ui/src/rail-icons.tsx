/**
 * The rail's icons, drawn as one family on the same 24px grid and stroke: outline
 * at rest, solid when active. A solid icon's inner details are cut out in the
 * background colour, which is the raised tile an active icon always sits on.
 */
type IconProps = { active?: boolean; className?: string };

function Glyph({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={className}
    >
      {children}
    </svg>
  );
}

const BUBBLE = "M7 4H17A4 4 0 0 1 21 8V14A4 4 0 0 1 17 18H11.5L8.1 20.55C7.6 20.93 7 20.6 7 20V18A4 4 0 0 1 3 14V8A4 4 0 0 1 7 4Z";
const CARD = "M8 3H16A4 4 0 0 1 20 7V17A4 4 0 0 1 16 21H8A4 4 0 0 1 4 17V7A4 4 0 0 1 8 3Z";
/** six teeth: tip and root arcs joined by straight flanks */
const GEAR =
  "M9.42 5.28L10 2.61A9.6 9.6 0 0 1 14 2.61L14.58 5.28A7.2 7.2 0 0 1 16.53 6.4L19.13 5.58A9.6 9.6 0 0 1 21.13 9.03L19.11 10.87A7.2 7.2 0 0 1 19.11 13.13L21.13 14.97A9.6 9.6 0 0 1 19.13 18.42L16.53 17.6A7.2 7.2 0 0 1 14.58 18.72L14 21.39A9.6 9.6 0 0 1 10 21.39L9.42 18.72A7.2 7.2 0 0 1 7.47 17.6L4.87 18.42A9.6 9.6 0 0 1 2.87 14.97L4.89 13.13A7.2 7.2 0 0 1 4.89 10.87L2.87 9.03A9.6 9.6 0 0 1 4.87 5.58L7.47 6.4A7.2 7.2 0 0 1 9.42 5.28Z";

const cut = "stroke-background";

export function MessagesIcon({ active, className }: IconProps) {
  return (
    <Glyph className={className}>
      <path d={BUBBLE} fill={active ? "currentColor" : "none"} />
      <path d="M8 9.5H16M8 13H12.5" className={active ? cut : undefined} />
    </Glyph>
  );
}

export function ContactsIcon({ active, className }: IconProps) {
  const person = active ? "fill-background stroke-background" : undefined;
  return (
    <Glyph className={className}>
      <path d={CARD} fill={active ? "currentColor" : "none"} />
      <circle cx="12" cy="10" r="2.75" className={person} />
      <path d={`M7.75 17C8.2 14.9 9.9 13.75 12 13.75S15.8 14.9 16.25 17${active ? "Z" : ""}`} className={person} />
    </Glyph>
  );
}

export function SettingsIcon({ active, className }: IconProps) {
  return (
    <Glyph className={className}>
      <path d={GEAR} fill={active ? "currentColor" : "none"} />
      <circle cx="12" cy="12" r={active ? 2.6 : 3} className={active ? "fill-background stroke-background" : undefined} />
    </Glyph>
  );
}
