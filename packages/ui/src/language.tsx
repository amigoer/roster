import { toast } from "sonner";
import { api } from "./api";
import { LOCALES, useI18n, type Locale, type LocalePreference } from "./i18n";
import { Choice } from "./settings";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { RadioGroup } from "@/components/ui/radio-group";
import { ScrollArea } from "@/components/ui/scroll-area";

const nameOf = (id: Locale) => LOCALES.find((l) => l.id === id)?.name ?? id;

/**
 * Applies on click, like appearance. Core keeps the choice rather than this
 * window, since notices, errors and what agents are told are written in it too.
 */
export function LanguagePanel() {
  const { t, locale, preference, sync } = useI18n();

  const choose = async (next: LocalePreference) => {
    if (next === preference) return;
    const before = { preference, resolved: locale };
    // a language picked by name shows at once; what the system is in is core's to work out
    if (next !== "system") sync({ preference: next, resolved: next });
    const r = await api.setLocale(next).catch((e: unknown) => ({ error: String(e), locale: undefined }));
    if (r.locale && !r.error) return sync(r.locale);
    sync(before);
    toast.error(t("language.failed"), { description: r.error });
  };

  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="mx-auto max-w-2xl space-y-6 px-8 py-8">
        <h2 className="text-lg font-semibold">{t("settings.language")}</h2>
        <Field>
          <FieldLabel>{t("language.label")}</FieldLabel>
          <RadioGroup value={preference} onValueChange={(v) => void choose(v as LocalePreference)} className="grid gap-2 sm:grid-cols-3">
            <Choice value="system" selected={preference === "system"}>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium">{t("language.system")}</span>
                <span className="text-muted-foreground block text-xs">
                  {preference === "system" ? t("language.systemNow", { language: nameOf(locale) }) : t("language.systemHint")}
                </span>
              </span>
            </Choice>
            {/* each language in its own words, so it can be found by someone who cannot read the one showing now */}
            {LOCALES.map((l) => (
              <Choice key={l.id} value={l.id} selected={preference === l.id}>
                <span lang={l.id} className="text-sm font-medium">
                  {l.name}
                </span>
              </Choice>
            ))}
          </RadioGroup>
          <FieldDescription>{t("language.hint")}</FieldDescription>
        </Field>
      </div>
    </ScrollArea>
  );
}
