import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Query } from "@anthropic-ai/claude-agent-sdk";
import type { Quota, QuotaWindow } from "@roster/adapter-api";

/** Where a person sees the same limits on claude.ai. */
const USAGE_PAGE = "https://claude.ai/settings/usage";
const USAGE_ENDPOINT = "https://api.anthropic.com/api/oauth/usage";
const KEYCHAIN_SERVICE = "Claude Code-credentials";
const CREDENTIAL_TIMEOUT_MS = 5_000;
const USAGE_TIMEOUT_MS = 10_000;

const record = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

/** epoch ms from the ISO timestamp the usage endpoint answers with */
function resetOf(v: unknown): number | undefined {
  const at = typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isFinite(at) ? at : undefined;
}

function windowOf(kind: QuotaWindow["kind"], percent: unknown, resets: unknown, scope?: string): QuotaWindow | undefined {
  if (typeof percent !== "number" || !Number.isFinite(percent)) return undefined;
  const resetsAt = resetOf(resets);
  return {
    kind,
    ...(scope ? { scope } : {}),
    usedPercent: Math.min(100, Math.max(0, percent)),
    ...(resetsAt !== undefined ? { resetsAt } : {}),
  };
}

/** The list the endpoint answers with now, where a model-scoped week names its model. */
function fromLimits(limits: unknown[]): QuotaWindow[] {
  return limits.flatMap((entry) => {
    const l = record(entry);
    if (!l) return [];
    const w =
      l["kind"] === "session"
        ? windowOf("session", l["percent"], l["resets_at"])
        : l["kind"] === "weekly_all"
          ? windowOf("weekly", l["percent"], l["resets_at"])
          : l["kind"] === "weekly_scoped"
            ? scopedWindow(l)
            : undefined;
    return w ? [w] : [];
  });
}

function scopedWindow(l: Record<string, unknown>): QuotaWindow | undefined {
  const name = record(record(l["scope"])?.["model"])?.["display_name"];
  return typeof name === "string" && name.trim() ? windowOf("weekly", l["percent"], l["resets_at"], name.trim()) : undefined;
}

/** The fixed fields an endpoint without the list still answers with. */
function fromFields(v: Record<string, unknown>): QuotaWindow[] {
  const at = (key: string) => record(v[key]);
  const fields: Array<[string, QuotaWindow["kind"], string?]> = [
    ["five_hour", "session"],
    ["seven_day", "weekly"],
    ["seven_day_opus", "weekly", "Opus"],
    ["seven_day_sonnet", "weekly", "Sonnet"],
  ];
  return fields.flatMap(([key, kind, scope]) => {
    const w = windowOf(kind, at(key)?.["utilization"], at(key)?.["resets_at"], scope);
    return w ? [w] : [];
  });
}

/** A plan's limits from the claude.ai usage endpoint's answer; null when it has none to show. */
export function quotaOf(plan: string | null, rateLimits: unknown): Quota | null {
  const v = record(rateLimits);
  if (!v) return null;
  const windows = Array.isArray(v["limits"]) ? fromLimits(v["limits"]) : fromFields(v);
  return windows.length > 0 ? { plan: plan?.trim() || null, windows, url: USAGE_PAGE } : null;
}

type UsageReader = Pick<Query, "usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET">;

/** The data behind the CLI's own /usage. A CLI that cannot answer it is read around, through its sign-in. */
export async function planUsage(q: UsageReader): Promise<Quota | null> {
  const usage = await q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }).catch(() => undefined);
  if (usage === undefined) return planUsageFromCredentials();
  return usage.rate_limits_available ? quotaOf(usage.subscription_type, usage.rate_limits) : null;
}

function keychain(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("/usr/bin/security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"], { timeout: CREDENTIAL_TIMEOUT_MS }, (err, stdout) =>
      resolve(err ? null : stdout.trim() || null),
    );
  });
}

/** The CLI's sign-in where it keeps it: the login keychain on macOS, a file under ~/.claude elsewhere and in older versions. */
async function readCredentials(): Promise<{ accessToken: string; plan: string | null; expiresAt?: number } | null> {
  const stored =
    (process.platform === "darwin" ? await keychain() : null) ??
    (await readFile(join(homedir(), ".claude", ".credentials.json"), "utf8").catch(() => null));
  if (!stored) return null;
  try {
    const oauth = record(record(JSON.parse(stored))?.["claudeAiOauth"]);
    const token = oauth?.["accessToken"];
    if (typeof token !== "string" || !token) return null;
    const plan = oauth?.["subscriptionType"];
    const expiresAt = oauth?.["expiresAt"];
    return { accessToken: token, plan: typeof plan === "string" ? plan : null, ...(typeof expiresAt === "number" ? { expiresAt } : {}) };
  } catch {
    return null;
  }
}

/**
 * The usage endpoint asked directly with the CLI's own token. The token never
 * leaves this function: it is not logged, cached or handed on.
 */
export async function planUsageFromCredentials(): Promise<Quota | null> {
  const creds = await readCredentials();
  // an expired token is the CLI's to refresh; refreshing it here would race the CLI over the same credentials
  if (!creds || (creds.expiresAt !== undefined && creds.expiresAt <= Date.now())) return null;
  const res = await fetch(USAGE_ENDPOINT, {
    headers: { authorization: `Bearer ${creds.accessToken}`, "anthropic-beta": "oauth-2025-04-20" },
    signal: AbortSignal.timeout(USAGE_TIMEOUT_MS),
  }).catch(() => null);
  if (!res?.ok) return null;
  return quotaOf(creds.plan, await res.json().catch(() => null));
}
