import { useState } from "react";
import { ChevronLeft, Cpu, Info, KeyRound, Languages, Puzzle, SunMoon } from "lucide-react";
import type { Bot, ExecutorSettings, ExtensionsView } from "../api";
import { DRAG, NO_DRAG } from "../app-region";
import { LOCALES, useI18n, type Translate } from "../i18n";
import { LIST_BODY, ROW, rowState, SectionLabel } from "../list";
import { PAGE_IN } from "../motion";
import type { Theme } from "../theme";
import { SettingTile } from "../tiles";
import { fontLabel, sizeLabel, type TextSize, type Typography } from "../typography";
import { AboutPanel, coreOutdated, type AboutState } from "./about";
import { AgentEditor, AgentOverview } from "./agent";
import { AppearancePanel } from "./appearance";
import { HarnessOverview, HarnessPanel } from "./harness";
import { LanguagePanel } from "./language";
import { ProviderEditor, ProviderOverview } from "./provider";
import { Page, WARN_TEXT, type SettingsRoute } from "./shared";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

export type { SettingsRoute } from "./shared";

/**
 * Settings keeps the three columns, but the list column holds pages, not
 * things: six rows that stay six however many harnesses, agents and model APIs
 * there are. Each page lists its own collection, and an item opens inside it.
 */

/** The page before anyone picked one: a fresh install needs a harness first; otherwise the first row. */
export function resolveRoute(route: SettingsRoute | null, view: ExecutorSettings | null): SettingsRoute | null {
  if (route) return route;
  if (!view) return null;
  return view.executors.length === 0 ? { page: "harness" } : { page: "appearance" };
}

function Row({
  icon,
  title,
  line,
  warn,
  selected,
  onClick,
}: {
  icon: React.ReactNode;
  title: string;
  /** null while the summary waits on core */
  line: string | null;
  /** the summary reads amber: something on the page needs attention */
  warn?: boolean;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button type="button" onClick={onClick} className={cn(ROW, rowState(selected))}>
      <SettingTile>{icon}</SettingTile>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{title}</div>
        {line === null ? (
          <Skeleton className="mt-1 h-3 w-16" />
        ) : (
          <div className={cn("truncate text-xs", warn ? WARN_TEXT : "text-muted-foreground")}>{line}</div>
        )}
      </div>
    </button>
  );
}

export function SettingsList({
  view,
  ext,
  theme,
  typography,
  about,
  route,
  onRoute,
}: {
  view: ExecutorSettings | null;
  ext: ExtensionsView | null;
  theme: Theme;
  typography: Typography;
  about: AboutState;
  route: SettingsRoute | null;
  onRoute: (r: SettingsRoute) => void;
}) {
  const { t, locale, preference } = useI18n();
  const current = resolveRoute(route, view)?.page;
  const outdated = coreOutdated(about);
  const localeName = LOCALES.find((l) => l.id === locale)?.name ?? locale;
  const usable = ext ? ext.harnesses.filter((h) => h.state.usable).length : null;
  const broken = view?.executors.filter((e) => e.problem !== null).length ?? 0;
  const agentLine = view
    ? view.executors.length === 0
      ? t("settings.agentNone")
      : [t("settings.agentSummary", { count: view.executors.length }), broken > 0 ? t("settings.agentBroken", { count: broken }) : ""]
          .filter(Boolean)
          .join(" · ")
    : null;
  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className={LIST_BODY}>
        {/* Roster's own preferences come first and never wait on core */}
        <SectionLabel>{t("settings.general")}</SectionLabel>
        <Row
          icon={<SunMoon />}
          title={t("settings.appearance")}
          // the theme always; font and size only once they differ from the default
          line={[t(`theme.${theme}`), fontLabel(t, typography), sizeLabel(t, typography)].filter(Boolean).join(" · ")}
          selected={current === "appearance"}
          onClick={() => onRoute({ page: "appearance" })}
        />
        <Row
          icon={<Languages />}
          title={t("settings.language")}
          line={preference === "system" ? t("language.systemRow", { language: localeName }) : localeName}
          selected={current === "language"}
          onClick={() => onRoute({ page: "language" })}
        />
        <Row
          icon={<Info />}
          title={t("settings.about")}
          // a stale core is easy to miss, so the row says so without the page being opened
          line={outdated ? t("settings.aboutStale") : about && "version" in about ? t("about.version", { version: about.version }) : t("settings.aboutHint")}
          warn={outdated}
          selected={current === "about"}
          onClick={() => onRoute({ page: "about" })}
        />

        <SectionLabel>{t("settings.agentsAndModels")}</SectionLabel>
        <Row
          icon={<Puzzle />}
          title={t("settings.harnesses")}
          line={usable === null ? null : usable > 0 ? t("settings.harnessSummary", { count: usable }) : t("settings.harnessNone")}
          warn={usable === 0}
          selected={current === "harness"}
          onClick={() => onRoute({ page: "harness" })}
        />
        <Row
          icon={<Cpu />}
          title={t("settings.agent")}
          line={agentLine}
          warn={broken > 0}
          selected={current === "agent"}
          onClick={() => onRoute({ page: "agent" })}
        />
        <Row
          icon={<KeyRound />}
          title={t("settings.provider")}
          line={view ? (view.providers.length > 0 ? t("settings.providerSummary", { count: view.providers.length }) : t("settings.providerNone")) : null}
          selected={current === "provider"}
          onClick={() => onRoute({ page: "provider" })}
        />
      </div>
    </ScrollArea>
  );
}

/** What the header says: the page, or the item with the page to go back to. */
function crumbOf(
  t: Translate,
  r: SettingsRoute | null,
  view: ExecutorSettings | null,
  ext: ExtensionsView | null,
): { parent?: { label: string; to: SettingsRoute }; title: string } {
  if (!r) return { title: t("nav.settings") };
  switch (r.page) {
    case "appearance":
      return { title: t("settings.appearance") };
    case "language":
      return { title: t("settings.language") };
    case "about":
      return { title: t("settings.about") };
    case "harness": {
      const parent = { label: t("settings.harnesses"), to: { page: "harness" } as const };
      if (r.id === undefined) return { title: parent.label };
      const id = r.id;
      return { parent, title: ext?.harnesses.find((h) => h.id === id)?.label ?? view?.types.find((x) => x.type === id)?.label ?? id };
    }
    case "agent": {
      const parent = { label: t("settings.agent"), to: { page: "agent" } as const };
      if (r.id === undefined) return { title: parent.label };
      if (r.id === null) return { parent, title: t("agent.new") };
      const id = r.id;
      return { parent, title: view?.executors.find((e) => e.id === id)?.name ?? parent.label };
    }
    case "provider": {
      const parent = { label: t("settings.provider"), to: { page: "provider" } as const };
      if (r.id === undefined) return { title: parent.label };
      if (r.id === null) return { parent, title: t("provider.add") };
      const id = r.id;
      return { parent, title: view?.providers.find((p) => p.id === id)?.name ?? parent.label };
    }
  }
}

/** The pages that list what core keeps have nothing to draw until it answers. */
function Loading() {
  return (
    <Page>
      <div className="space-y-2">
        <Skeleton className="h-5 w-32" />
        <Skeleton className="h-3.5 w-2/3" />
      </div>
      <div className="space-y-2">
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex items-center gap-3 rounded-xl border px-4 py-3">
            <Skeleton className="size-9 rounded-[23%]" />
            <div className="flex-1 space-y-1.5">
              <Skeleton className="h-3.5 w-1/3" />
              <Skeleton className="h-3 w-3/5" />
            </div>
          </div>
        ))}
      </div>
    </Page>
  );
}

/** The detail column of settings: a header that can go back, and the page the route names. */
export function SettingsPage({
  route,
  onRoute,
  view,
  ext,
  bots,
  about,
  theme,
  onTheme,
  typography,
  onFont,
  onCustomFont,
  onSize,
  onReload,
  onRefresh,
  onExtensions,
  onReloadExtensions,
}: {
  route: SettingsRoute | null;
  onRoute: (r: SettingsRoute) => void;
  view: ExecutorSettings | null;
  ext: ExtensionsView | null;
  bots: readonly Bot[];
  about: AboutState;
  theme: Theme;
  onTheme: (theme: Theme) => void;
  typography: Typography;
  onFont: (font: string) => void;
  onCustomFont: (name: string) => void;
  onSize: (size: TextSize) => void;
  /** fetch agents, harnesses and model APIs again, then go to the route once the list has its row */
  onReload: (next: SettingsRoute) => void;
  /** fetch them again in place */
  onRefresh: () => void;
  /** what an install call answered, shown before the next fetch */
  onExtensions: (ext: ExtensionsView) => void;
  onReloadExtensions: () => void;
}) {
  const { t } = useI18n();
  const r = resolveRoute(route, view);
  const crumb = crumbOf(t, r, view, ext);
  const onChanged = () => {
    onReloadExtensions();
    onRefresh();
  };

  // where the page is and how it got there: an item opens from the right, its overview comes back from the left
  const item = r && "id" in r && r.id !== undefined ? (r.id ?? "new") : null;
  const key = r ? `${r.page}:${item ?? ""}` : "";
  const depth = item === null ? 0 : 1;
  const [trail, setTrail] = useState({ key, depth, motion: PAGE_IN });
  if (trail.key !== key) {
    const from = depth > trail.depth ? "slide-in-from-right-2" : depth < trail.depth ? "slide-in-from-left-2" : "slide-in-from-bottom-1";
    setTrail({ key, depth, motion: `animate-in fade-in-0 ${from} duration-200 ease-soft` });
  }

  const body = () => {
    if (!r) return <Loading />;
    switch (r.page) {
      case "appearance":
        return <AppearancePanel theme={theme} onChange={onTheme} typography={typography} onFont={onFont} onCustomFont={onCustomFont} onSize={onSize} />;
      case "language":
        return <LanguagePanel />;
      case "about":
        return <AboutPanel about={about} />;
    }
    if (!view) return <Loading />;
    if (r.page === "harness") {
      const id = r.id;
      if (id === undefined) {
        return <HarnessOverview view={view} ext={ext} intro={view.executors.length === 0} onExtensions={onExtensions} onChanged={onChanged} onRoute={onRoute} />;
      }
      return (
        <HarnessPanel
          key={id}
          id={id}
          view={view}
          ext={ext}
          onSaved={() => onReload({ page: "harness", id })}
          onChanged={onChanged}
          onCancel={() => onRoute({ page: "harness" })}
          onRoute={onRoute}
        />
      );
    }
    if (r.page === "agent") {
      if (r.id === undefined) return <AgentOverview view={view} ext={ext} bots={bots} onRoute={onRoute} />;
      const from = r.type;
      return (
        <AgentEditor
          key={r.id ?? `new-${from ?? ""}`}
          view={view}
          executor={view.executors.find((e) => e.id === r.id) ?? null}
          type={from}
          ext={ext}
          bots={bots}
          onSaved={(e) => onReload({ page: "agent", id: e.id })}
          // a new agent opened from a harness's page goes back to that page
          onCancel={() => onRoute(from ? { page: "harness", id: from } : { page: "agent" })}
          onDeleted={() => onReload({ page: "agent" })}
          onRoute={onRoute}
        />
      );
    }
    if (r.id === undefined) return <ProviderOverview view={view} env={ext?.environment ?? null} onRoute={onRoute} />;
    return (
      <ProviderEditor
        key={r.id ?? `new-${r.preset ?? ""}`}
        view={view}
        provider={view.providers.find((p) => p.id === r.id) ?? null}
        start={r.preset ? { preset: r.preset, keyEnv: r.keyEnv } : undefined}
        env={ext?.environment ?? null}
        onSaved={(p) => onReload({ page: "provider", id: p.id })}
        onCancel={() => onRoute({ page: "provider" })}
        onDeleted={() => onReload({ page: "provider" })}
      />
    );
  };

  return (
    <>
      <header className="flex h-13 shrink-0 items-center gap-2 px-5" style={DRAG}>
        {crumb.parent && (
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground -ml-2.5 h-7 px-1.5"
            style={NO_DRAG}
            onClick={() => onRoute(crumb.parent!.to)}
          >
            <ChevronLeft className="size-4" />
            {crumb.parent.label}
          </Button>
        )}
        <span className="truncate text-sm font-semibold">{crumb.title}</span>
      </header>
      <div key={key} className={cn("flex min-h-0 flex-1 flex-col", trail.motion)}>
        {body()}
      </div>
    </>
  );
}
