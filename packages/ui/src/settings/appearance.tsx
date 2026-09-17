import { useI18n } from "../i18n";
import { Collapse } from "../motion";
import { Choice } from "./shared";
import { THEMES, type Theme } from "../theme";
import {
  CUSTOM_FONT,
  FONT_OPTIONS,
  SYSTEM_FONT,
  TEXT_SIZES,
  chosenFamily,
  cleanFamily,
  fontInstalled,
  installedFamily,
  type TextSize,
  type Typography,
} from "../typography";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { RadioGroup } from "@/components/ui/radio-group";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

const CARD = "flex-col items-stretch gap-2 p-2";

/** Applies on click; unlike the executor and endpoint editors there is nothing to save. */
export function AppearancePanel({
  theme,
  onChange,
  typography,
  onFont,
  onCustomFont,
  onSize,
}: {
  theme: Theme;
  onChange: (theme: Theme) => void;
  typography: Typography;
  onFont: (font: string) => void;
  onCustomFont: (name: string) => void;
  onSize: (size: TextSize) => void;
}) {
  const { t } = useI18n();
  // a card for a font this machine does not have would pick nothing
  const fonts = FONT_OPTIONS.map((o) => ({ ...o, family: installedFamily(o) })).filter((o) => o.family);
  const custom = cleanFamily(typography.customFont);
  const chosen = chosenFamily(typography);
  const sample = t("appearance.fontSample");
  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="mx-auto max-w-2xl space-y-6 px-8 py-8">
        <h2 className="text-lg font-semibold">{t("settings.appearance")}</h2>
        <Field>
          <FieldLabel>{t("appearance.theme")}</FieldLabel>
          <RadioGroup value={theme} onValueChange={(v) => onChange(v as Theme)} className="grid grid-cols-3 gap-3">
            {THEMES.map((option) => (
              <Choice key={option} value={option} selected={theme === option} className={CARD}>
                <Preview theme={option} />
                <span className="text-center text-sm">{t(`theme.${option}`)}</span>
              </Choice>
            ))}
          </RadioGroup>
          <FieldDescription>{t("appearance.themeHint")}</FieldDescription>
        </Field>

        <Field>
          <FieldLabel>{t("appearance.font")}</FieldLabel>
          <RadioGroup value={typography.font} onValueChange={onFont} className="grid grid-cols-3 gap-3">
            <FontChoice
              value={SYSTEM_FONT}
              selected={typography.font === SYSTEM_FONT}
              label={t("appearance.systemFont")}
              family="var(--font-default)"
              sample={sample}
            />
            {fonts.map((o) => (
              <FontChoice
                key={o.id}
                value={o.id}
                selected={typography.font === o.id}
                label={t(`font.${o.id}`)}
                family={`"${o.family}", var(--font-default)`}
                sample={sample}
              />
            ))}
            <FontChoice
              value={CUSTOM_FONT}
              selected={typography.font === CUSTOM_FONT}
              label={t("appearance.otherFont")}
              family={custom ? `"${custom}", var(--font-default)` : "var(--font-default)"}
              sample={sample}
            />
          </RadioGroup>
          <Collapse open={typography.font === CUSTOM_FONT} className="-mt-3">
            {typography.font === CUSTOM_FONT && (
              <div className="space-y-1.5 pt-3">
                <Input
                  value={typography.customFont}
                  onChange={(e) => onCustomFont(e.target.value)}
                  placeholder={t("appearance.fontPlaceholder")}
                  autoFocus
                  spellCheck={false}
                />
                {/* the name is applied as typed; say when nothing on this machine answers to it */}
                {custom && (
                  <p className={cn("text-xs", fontInstalled(custom) ? "text-muted-foreground" : "text-amber-600 dark:text-amber-400")}>
                    {fontInstalled(custom) ? t("appearance.fontFound", { font: custom }) : t("appearance.fontMissing", { font: custom })}
                  </p>
                )}
              </div>
            )}
          </Collapse>
          <FieldDescription>
            {t("appearance.fontHint")}
            {chosen ? t("appearance.fontNow", { font: chosen }) : t("appearance.fontDefault")}
          </FieldDescription>
        </Field>

        <Field>
          <FieldLabel>{t("appearance.size")}</FieldLabel>
          <RadioGroup value={typography.size} onValueChange={(v) => onSize(v as TextSize)} className="grid grid-cols-4 gap-3">
            {TEXT_SIZES.map((s) => (
              <Choice key={s.id} value={s.id} selected={typography.size === s.id} className={CARD}>
                <span className="flex h-12 items-center justify-center leading-none whitespace-nowrap" style={{ fontSize: s.px }}>
                  {t("appearance.sizeSample")}
                </span>
                <span className="text-center text-sm">{t(`size.${s.id}`)}</span>
              </Choice>
            ))}
          </RadioGroup>
          <FieldDescription>{t("appearance.sizeHint")}</FieldDescription>
        </Field>
      </div>
    </ScrollArea>
  );
}

/** The name in the interface font under a line set in the font itself, so the card shows what it offers. */
function FontChoice({
  value,
  selected,
  label,
  family,
  sample,
}: {
  value: string;
  selected: boolean;
  label: string;
  family: string;
  sample: string;
}) {
  return (
    <Choice value={value} selected={selected} className={CARD}>
      <span className="flex h-12 items-center justify-center text-[15px] leading-none whitespace-nowrap" style={{ fontFamily: family }}>
        {sample}
      </span>
      <span className="text-center text-sm">{label}</span>
    </Choice>
  );
}

function Preview({ theme }: { theme: Theme }) {
  return (
    <div aria-hidden className="ring-border relative aspect-[16/10] overflow-hidden rounded-lg ring-1">
      <Window scheme={theme === "dark" ? "dark" : "light"} />
      {/* split on a diagonal between the two looks the system switches between */}
      {theme === "system" && (
        <Window scheme="dark" className="absolute inset-0 [clip-path:polygon(62%_0,100%_0,100%_100%,38%_100%)]" />
      )}
    </div>
  );
}

/** The window in miniature: rail, list, conversation. */
function Window({ scheme, className }: { scheme: "light" | "dark"; className?: string }) {
  return (
    // the scheme class re-declares the tokens, so each preview paints the same whichever theme is on
    <div className={cn(scheme, "bg-sidebar flex size-full gap-1 p-1", className)}>
      <div className="flex w-2.5 shrink-0 flex-col items-center gap-1 pt-2">
        <span className="bg-primary size-1.5 rounded-full" />
        <span className="bg-muted-foreground/35 size-1.5 rounded-full" />
        <span className="bg-muted-foreground/35 size-1.5 rounded-full" />
      </div>
      <div className="bg-background shadow-panel flex w-[32%] shrink-0 flex-col gap-1 rounded-[4px] p-1">
        <span className="bg-selected h-3 rounded-[3px]" />
        <span className="bg-muted h-3 rounded-[3px]" />
        <span className="bg-muted h-3 rounded-[3px]" />
      </div>
      <div className="bg-background shadow-panel flex min-w-0 flex-1 flex-col justify-end gap-1 rounded-[4px] p-1.5">
        <span className="bg-muted h-2 w-3/5 rounded-full" />
        <span className="bg-primary h-2 w-2/5 self-end rounded-full" />
        <span className="border-border mt-0.5 h-3 rounded-[3px] border" />
      </div>
    </div>
  );
}
