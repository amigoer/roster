import { isIP } from "node:net";

/** Where a site's icon is. guessed: the page could not be read, so this is only where browsers look by default. */
export interface Icon {
  url: string;
  guessed: boolean;
}

const TIMEOUT_MS = 4_000;
/** icons are declared in the head, which comes first; the rest of a page can run to megabytes */
const HEAD_BYTES = 256 * 1024;
const REDIRECTS = 5;
const REMEMBERED = 500;
const FOUND_MS = 86_400_000;
const GUESSED_MS = 600_000;

/**
 * The site a link points at, as an origin, or null for an address core should
 * not reach out to: not http, an IP, or a name only the local network knows.
 */
export function siteOf(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const host = url.hostname.replace(/\.$/, "");
  if (isIP(host.replace(/^\[|\]$/g, "")) || !host.includes(".")) return null;
  if (/\.(local|localhost|internal|lan|home\.arpa)$/i.test(host)) return null;
  return url.origin;
}

const LINK = /<link\b[^>]*>/gi;
const ATTR = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;

/**
 * The best icon a page declares, resolved against the address it was served
 * from. An SVG is sharp at any size, a raster wants 32px for a 1em slot on a
 * 2x screen, and a touch icon is a padded tile, so it comes last.
 */
export function pickIcon(html: string, base: string): string | null {
  let best: { url: string; rank: number } | null = null;
  for (const [tag] of html.replace(/<!--[\s\S]*?-->/g, "").matchAll(LINK)) {
    const attrs = new Map<string, string>();
    for (const m of tag.slice(5).matchAll(ATTR)) attrs.set(m[1]!.toLowerCase(), m[2] ?? m[3] ?? m[4] ?? "");
    const rel = (attrs.get("rel") ?? "").toLowerCase().split(/\s+/);
    const touch = rel.includes("apple-touch-icon") || rel.includes("apple-touch-icon-precomposed");
    const href = attrs.get("href")?.trim();
    if (!href || !(touch || rel.includes("icon"))) continue;
    let url: URL;
    try {
      url = new URL(href.replace(/&amp;/g, "&"), base);
    } catch {
      continue;
    }
    // the window is redirected to it, and a redirect can only lead to a web address
    if (url.protocol !== "https:" && url.protocol !== "http:") continue;
    const rank = touch ? 40_000 : iconRank(attrs.get("type") ?? "", attrs.get("sizes") ?? "", url.pathname);
    if (!best || rank < best.rank) best = { url: url.href, rank };
  }
  return best?.url ?? null;
}

function iconRank(type: string, sizes: string, path: string): number {
  if (/svg/i.test(type) || /\.svg$/i.test(path) || /\bany\b/i.test(sizes)) return 0;
  const px = Math.max(0, ...sizes.split(/\s+/).map((s) => parseInt(s, 10) || 0));
  // among the sharp enough, the smallest; an undeclared size is often a multi-size .ico
  if (px >= 32) return 10_000 + px;
  return px === 0 ? 20_000 : 30_000 - px;
}

async function readHead(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let html = "";
  try {
    for (let read = 0; read < HEAD_BYTES; ) {
      const { done, value } = await reader.read();
      if (done) break;
      read += value.byteLength;
      html += decoder.decode(value, { stream: true });
      if (/<\/head\s*>/i.test(html.slice(-(value.byteLength + 8)))) break;
    }
  } finally {
    void reader.cancel().catch(() => {});
  }
  return html;
}

async function discover(site: string): Promise<Icon> {
  try {
    let page = new URL(`${site}/`);
    for (let hop = 0; hop <= REDIRECTS; hop++) {
      const res = await fetch(page, {
        redirect: "manual",
        headers: { accept: "text/html", "user-agent": "Mozilla/5.0 (compatible; Roster)" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const location = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && location) {
        void res.body?.cancel().catch(() => {});
        const next = new URL(location, page);
        // followed by hand, so a public site cannot send core on to a machine on this network
        if (next.origin !== page.origin && !siteOf(next.href)) break;
        page = next;
        continue;
      }
      if (!res.ok || !/html/i.test(res.headers.get("content-type") ?? "")) {
        void res.body?.cancel().catch(() => {});
        break;
      }
      const url = pickIcon(await readHead(res), page.href);
      return { url: url ?? new URL("/favicon.ico", page).href, guessed: false };
    }
  } catch {
    // core could not reach it; the window may still, through a proxy core does not use
  }
  return { url: `${site}/favicon.ico`, guessed: true };
}

/**
 * The icons of the sites replies link to. The window cannot read another
 * site's HTML, so core reads the page for its icon; the window then loads the
 * image itself, through whatever proxy the system sets.
 */
export class Favicons {
  private readonly known = new Map<string, { icon: Promise<Icon>; until: number }>();

  /** site is an origin, as siteOf returns it. */
  find(site: string): Promise<Icon> {
    const hit = this.known.get(site);
    if (hit && hit.until > Date.now()) return hit.icon;
    this.known.delete(site);
    // a Map keeps insertion order, so the first key is the oldest
    if (this.known.size >= REMEMBERED) this.known.delete(this.known.keys().next().value!);
    const icon = discover(site);
    // discover never rejects, so an entry in flight is settled before it can go stale
    const entry = { icon, until: Infinity };
    this.known.set(site, entry);
    void icon.then((found) => (entry.until = Date.now() + (found.guessed ? GUESSED_MS : FOUND_MS)));
    return icon;
  }
}

/** How long the window may keep the answer: a guess is asked again sooner, in case the site becomes reachable. */
export const iconMaxAge = (icon: Icon): number => (icon.guessed ? GUESSED_MS : FOUND_MS) / 1000;
