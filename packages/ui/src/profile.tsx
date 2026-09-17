import { Fragment, useRef, useState } from "react";
import { ImagePlus, Pencil, Trash2, User } from "lucide-react";
import { toast } from "sonner";
import { DRAG } from "./app-region";
import { HumanAvatar } from "./bot-avatar";
import { Section } from "./contacts";
import { useI18n } from "./i18n";
import { PAGE_IN } from "./motion";
import { COLORS, colorOf, photoFrom, useMe, type ColorId, type Profile } from "./me";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

/** Your own page, opened from your avatar at the top of the rail: how Roster shows you, and where that changes. */
export function ProfilePanel() {
  const { t } = useI18n();
  const [editing, setEditing] = useState(false);
  return (
    <>
      <header className="flex h-13 shrink-0 items-center px-5" style={DRAG}>
        <span className="text-sm font-semibold">{editing ? t("app.editProfile") : t("nav.profile")}</span>
      </header>
      <div key={editing ? "edit" : "view"} className={cn("flex min-h-0 flex-1 flex-col", PAGE_IN)}>
        {editing ? <ProfileEditor onDone={() => setEditing(false)} /> : <ProfileView onEdit={() => setEditing(true)} />}
      </div>
    </>
  );
}

function ProfileView({ onEdit }: { onEdit: () => void }) {
  const { t } = useI18n();
  const { profile } = useMe();
  const details = [
    { label: t("me.email"), value: profile.email },
    { label: t("me.location"), value: profile.location },
  ];
  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="mx-auto max-w-2xl px-8 py-10">
        <div className="flex flex-wrap items-start gap-5">
          <HumanAvatar size="xl" />
          <div className="min-w-48 flex-1 pt-1">
            <h2 className={cn("truncate text-xl font-semibold", !profile.name && "text-muted-foreground")}>
              {profile.name || t("me.noName")}
            </h2>
            <p className="text-muted-foreground mt-0.5 text-sm">{profile.title || t("me.noTitle")}</p>
            {profile.bio && (
              <p className="mt-3 cursor-auto text-sm leading-relaxed break-words whitespace-pre-wrap select-text">{profile.bio}</p>
            )}
          </div>
        </div>

        <div className="mt-6 flex flex-wrap gap-2">
          <Button size="sm" onClick={onEdit}>
            <Pencil />
            {t("app.editProfile")}
          </Button>
        </div>

        <Section title={t("me.details")}>
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-8 gap-y-2 text-sm">
            {details.map((d) => (
              <Fragment key={d.label}>
                <dt className="text-muted-foreground">{d.label}</dt>
                <dd className={cn("truncate", d.value ? "cursor-auto select-text" : "text-muted-foreground")}>
                  {d.value || t("me.notSet")}
                </dd>
              </Fragment>
            ))}
          </dl>
        </Section>

        <Section title={t("me.storage")}>
          <p className="text-muted-foreground text-sm leading-relaxed">{t("me.storageHint")}</p>
        </Section>
      </div>
    </ScrollArea>
  );
}

/** Short enough to sit on one line wherever they show. */
const MAX = { name: 32, title: 40, bio: 120, email: 100, location: 40 } as const;

/** The plain tile first, then every colour. */
const SWATCHES: ReadonlyArray<ColorId | null> = [null, ...COLORS.map((c) => c.id)];

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function ProfileEditor({ onDone }: { onDone: () => void }) {
  const { t } = useI18n();
  const { profile, save } = useMe();
  const [form, setForm] = useState(profile);
  /** an address still being typed is not wrong yet */
  const [emailLeft, setEmailLeft] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const set = <K extends keyof Profile>(key: K, value: Profile[K]) => setForm((f) => ({ ...f, [key]: value }));
  const next: Profile = {
    ...form,
    name: form.name.trim(),
    title: form.title.trim(),
    bio: form.bio.trim(),
    email: form.email.trim(),
    location: form.location.trim(),
  };
  const badEmail = next.email !== "" && !EMAIL.test(next.email);
  const changed = (Object.keys(next) as Array<keyof Profile>).some((k) => next[k] !== profile[k]);
  const canSave = changed && !badEmail;

  const pickPhoto = async (file: File | undefined) => {
    if (!file) return;
    const photo = await photoFrom(file);
    if (photo) set("photo", photo);
    else toast.error(t("me.photoFailed"));
  };

  return (
    <form
      className="flex min-h-0 flex-1 flex-col"
      onSubmit={(e) => {
        e.preventDefault();
        if (!canSave) return;
        save(next);
        onDone();
      }}
    >
      <ScrollArea className="min-h-0 flex-1">
        <div className="@container mx-auto max-w-2xl px-8 py-8">
          <h2 className="text-lg font-semibold">{t("app.editProfile")}</h2>

          <div className="mt-7 flex flex-wrap items-center gap-5">
            <HumanAvatar profile={form} size="xl" />
            <div className="min-w-48 flex-1">
              <div className="text-sm font-medium">{t("me.avatar")}</div>
              <p className="text-muted-foreground mt-0.5 text-xs">{form.photo ? t("me.photoHint") : t("me.avatarHint")}</p>
            </div>
            <div className="flex gap-2">
              {form.photo && (
                <Button type="button" variant="ghost" size="sm" className="text-muted-foreground" onClick={() => set("photo", null)}>
                  <Trash2 />
                  {t("me.removePhoto")}
                </Button>
              )}
              <Button type="button" variant="outline" size="sm" onClick={() => fileInput.current?.click()}>
                <ImagePlus />
                {form.photo ? t("me.changePhoto") : t("me.uploadPhoto")}
              </Button>
            </div>
          </div>
          {/* a photo covers the colour, so there is nothing to pick while there is one */}
          {!form.photo && (
            <div className="mt-4 flex flex-wrap gap-2.5">
              {SWATCHES.map((id) => {
                const on = form.color === id;
                const label = id ? t(`me.color.${id}`) : t("me.color.none");
                return (
                  <button
                    key={id ?? "none"}
                    type="button"
                    onClick={() => set("color", id)}
                    title={label}
                    aria-label={label}
                    aria-pressed={on}
                    style={id ? { backgroundColor: colorOf(id) } : undefined}
                    className={cn(
                      "ring-offset-background flex size-7 items-center justify-center rounded-[23%] ring-offset-2 transition outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      !id && "bg-muted text-muted-foreground",
                      on ? "ring-foreground ring-2" : "hover:-translate-y-0.5",
                    )}
                  >
                    {!id && <User className="size-3.5" />}
                  </button>
                );
              })}
            </div>
          )}

          <div className="mt-7 grid gap-4 @md:grid-cols-2">
            <div className="grid content-start gap-2">
              <Label htmlFor="me-name">{t("me.name")}</Label>
              <Input
                id="me-name"
                value={form.name}
                maxLength={MAX.name}
                onChange={(e) => set("name", e.target.value)}
                placeholder={t("me.namePlaceholder")}
                autoFocus
              />
            </div>
            <div className="grid content-start gap-2">
              <Label htmlFor="me-title">{t("me.role")}</Label>
              <Input
                id="me-title"
                value={form.title}
                maxLength={MAX.title}
                onChange={(e) => set("title", e.target.value)}
                placeholder={t("me.rolePlaceholder")}
              />
            </div>
          </div>

          <div className="mt-5 grid gap-2">
            <div className="flex items-baseline justify-between gap-3">
              <Label htmlFor="me-bio">{t("me.bio")}</Label>
              <span className="text-muted-foreground text-xs tabular-nums">
                {form.bio.length}/{MAX.bio}
              </span>
            </div>
            <Textarea
              id="me-bio"
              value={form.bio}
              maxLength={MAX.bio}
              onChange={(e) => set("bio", e.target.value)}
              placeholder={t("me.bioPlaceholder")}
              className="min-h-20 text-sm leading-relaxed"
            />
          </div>

          <div className="mt-5 grid gap-4 @md:grid-cols-2">
            <div className="grid content-start gap-2">
              <Label htmlFor="me-email">{t("me.email")}</Label>
              {/* text, not email: an email input strips spaces as they are typed and pops its own validation bubble */}
              <Input
                id="me-email"
                value={form.email}
                maxLength={MAX.email}
                onChange={(e) => set("email", e.target.value)}
                onBlur={() => setEmailLeft(true)}
                placeholder={t("me.emailPlaceholder")}
                spellCheck={false}
                aria-invalid={emailLeft && badEmail}
              />
              {emailLeft && badEmail && <span className="text-destructive text-xs">{t("me.emailInvalid")}</span>}
            </div>
            <div className="grid content-start gap-2">
              <Label htmlFor="me-location">{t("me.location")}</Label>
              <Input
                id="me-location"
                value={form.location}
                maxLength={MAX.location}
                onChange={(e) => set("location", e.target.value)}
                placeholder={t("me.locationPlaceholder")}
              />
            </div>
          </div>
        </div>
      </ScrollArea>
      <Separator />
      <div className="flex shrink-0 items-center justify-end gap-2 px-8 py-3">
        <Button type="button" variant="outline" onClick={onDone}>
          {t("common.cancel")}
        </Button>
        <Button type="submit" disabled={!canSave}>
          {t("common.save")}
        </Button>
      </div>
      <input
        ref={fileInput}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        hidden
        onChange={(e) => {
          void pickPhoto(e.target.files?.[0]);
          // the same file picked again is a change too
          e.target.value = "";
        }}
      />
    </form>
  );
}
