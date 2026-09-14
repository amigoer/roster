import { useState } from "react";
import { Check, Copy, TriangleAlert } from "lucide-react";
import type { About } from "./api";
import { LogoImage, useLogos } from "./bot-avatar";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/** null while loading; an error when core could not answer */
export type AboutState = About | { error: string } | null;

/** A core started before /api/about existed answers it as an unknown route. */
export const coreOutdated = (about: AboutState): boolean =>
  about !== null && ("error" in about ? about.error === "not found" : about.stale);

const OS: Record<string, string> = { darwin: "macOS", win32: "Windows", linux: "Linux" };

const when = (ms: number) =>
  new Date(ms).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });

const runtimeLine = (r: About["runtime"]) =>
  [r.electron && `Electron ${r.electron}`, `Node ${r.node}`, r.chrome && `Chromium ${r.chrome}`].filter(Boolean).join(" · ");

const systemLine = (r: About["runtime"]) =>
  [OS[r.platform] ?? r.platform, r.platform === "darwin" ? `Darwin ${r.release}` : r.release, r.arch].join(" · ");

const tilde = (path: string, home: string) => (home && (path === home || path.startsWith(`${home}/`)) ? `~${path.slice(home.length)}` : path);

function CopyButton({ text, label }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="ghost"
      size={label ? "sm" : "icon-sm"}
      className="text-muted-foreground shrink-0"
      title="复制"
      aria-label={label ?? "复制"}
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {copied ? <Check className="text-emerald-600" /> : <Copy />}
      {label && (copied ? "已复制" : label)}
    </Button>
  );
}

function Row({ label, children, action }: { label: string; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="flex min-h-11 items-center gap-3 px-4 py-1.5">
      <dt className="text-muted-foreground w-20 shrink-0 text-xs">{label}</dt>
      <dd className="min-w-0 flex-1 truncate">{children}</dd>
      {action}
    </div>
  );
}

function Placeholder({ rows }: { rows: number }) {
  return (
    <div className="space-y-2.5 rounded-xl border px-4 py-3.5">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className={cn("h-3.5", i % 2 ? "w-1/2" : "w-2/3")} />
      ))}
    </div>
  );
}

/**
 * What this is, which build of it is running and where it keeps its data.
 * Credits for what it is built on live in CREDITS.md, not here. The
 * header is a handful of the bots' own faces: in Roster an agent is a
 * contact, and that is the whole idea.
 */
export function AboutPanel({ about }: { about: AboutState }) {
  const logos = useLogos();
  // spread across the set, so the row shows a mix rather than five neighbours
  const faces = logos.length > 0 ? [0, 7, 14, 21, 28].map((i) => logos[i % logos.length]!) : [];
  const info = about && "version" in about ? about : null;
  const failed = about && "error" in about ? about.error : null;

  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="mx-auto max-w-2xl space-y-8 px-8 py-10">
        <header className="space-y-4">
          <div className="flex" aria-hidden>
            {faces.map((logo, i) => (
              <LogoImage key={`${logo.id}-${i}`} logo={logo} className={cn("ring-background size-11 ring-[3px]", i > 0 && "-ml-2.5")} />
            ))}
          </div>
          <div>
            <h2 className="text-2xl font-semibold tracking-tight">Roster</h2>
            <p className="text-muted-foreground mt-1 text-sm">把 code agent 当联系人用：单聊就是一次会话，拉个群就是一支 agent team。</p>
          </div>
          {info && (
            <div className="flex flex-wrap gap-1.5">
              <Badge variant="outline" className="font-normal">
                版本 {info.version || "未知"}
              </Badge>
              {info.fromSource && (
                <Badge variant="outline" className="font-normal">
                  从源码运行
                </Badge>
              )}
            </div>
          )}
        </header>

        {coreOutdated(about) && (
          <Alert>
            <TriangleAlert />
            <AlertTitle>core 在跑旧代码</AlertTitle>
            <AlertDescription>它启动之后代码又构建过。完全退出 Roster 再打开，新改动才会生效；只刷新界面不够。</AlertDescription>
          </Alert>
        )}
        {failed && failed !== "not found" && (
          <Alert variant="destructive">
            <AlertTitle>读不到版本信息</AlertTitle>
            <AlertDescription>{failed}</AlertDescription>
          </Alert>
        )}

        {/* with nothing read there is nothing to lay out; the alert above says why */}
        {!failed && (
          <>
            <Field>
              <div className="flex items-center justify-between gap-3">
                <FieldLabel>运行中的版本</FieldLabel>
                {info && (
                  <CopyButton
                    label="复制"
                    text={[
                      `Roster ${info.version}${info.fromSource ? "（从源码运行）" : ""}`,
                      `core 启动于 ${new Date(info.startedAt).toLocaleString("zh-CN", { hour12: false })}${info.stale ? "（之后代码又构建过）" : ""}`,
                      runtimeLine(info.runtime),
                      systemLine(info.runtime),
                    ].join("\n")}
                  />
                )}
              </div>
              {info ? (
                <dl className="divide-y rounded-xl border text-sm">
                  <Row label="Roster">
                    {info.version || "未知"}
                    {info.fromSource && <span className="text-muted-foreground"> · 从源码运行</span>}
                  </Row>
                  <Row label="core">
                    启动于 {when(info.startedAt)}
                    {info.stale && <span className="text-amber-600 dark:text-amber-400"> · 之后代码又构建过</span>}
                  </Row>
                  <Row label="运行环境">{runtimeLine(info.runtime)}</Row>
                  <Row label="系统">{systemLine(info.runtime)}</Row>
                </dl>
              ) : (
                <Placeholder rows={4} />
              )}
              <FieldDescription>报问题时附上这几行，能省掉来回问版本。</FieldDescription>
            </Field>

            <Field>
              <FieldLabel>数据存在哪</FieldLabel>
              {info ? (
                <dl className="divide-y rounded-xl border text-sm">
                  {(
                    [
                      ["数据目录", info.paths.data],
                      ["下载的 agent", info.paths.agents],
                      ["附件", info.paths.attachments],
                      ["扩展", info.paths.extensions],
                    ] as const
                  ).map(([label, path]) => (
                    <Row key={label} label={label} action={<CopyButton text={path} />}>
                      <span className="font-mono text-xs" title={path}>
                        {tilde(path, info.home)}
                      </span>
                    </Row>
                  ))}
                </dl>
              ) : (
                <Placeholder rows={3} />
              )}
              <FieldDescription>会话、bot 和模型 API 都存在数据目录里。密钥由这台机器的钥匙串加密，换到别的机器要重新填。</FieldDescription>
            </Field>
          </>
        )}
      </div>
    </ScrollArea>
  );
}
