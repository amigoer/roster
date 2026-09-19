// Runs against dist: `pnpm --filter @roster/core test` builds first.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { describe, test } from "node:test";
import { Favicons, pickIcon, siteOf } from "../dist/favicons.js";

/** A throwaway site on loopback; pages maps a path to [status, headers, body]. */
async function site(pages) {
  const hits = [];
  const server = createServer((req, res) => {
    hits.push(req.url);
    const [status, headers, body] = pages[req.url] ?? [404, {}, ""];
    res.writeHead(status, headers).end(body);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { origin: `http://127.0.0.1:${server.address().port}`, hits, close: () => server.close() };
}

const html = (head) => [200, { "content-type": "text/html; charset=utf-8" }, `<!doctype html><html><head>${head}</head><body></body></html>`];

describe("favicons", () => {
  test("only a website on the internet is a site to ask", () => {
    assert.equal(siteOf("https://github.com/amigoer/mq-studio?tab=readme#top"), "https://github.com");
    assert.equal(siteOf("http://mq-studio.amigoer.com:8080/docs"), "http://mq-studio.amigoer.com:8080");
    for (const local of [
      "http://localhost:5173",
      "http://127.0.0.1:7788/api/state",
      "http://[::1]/",
      "http://192.168.1.1/admin",
      "http://intranet/",
      "http://printer.local/",
      "http://app.localhost/",
      "file:///etc/hosts",
      "mailto:a@example.com",
      "src/main.ts",
    ]) {
      assert.equal(siteOf(local), null, local);
    }
  });

  test("a page's declared icons are ranked: vector, then the smallest sharp raster, then touch tiles", () => {
    const base = "https://example.com/docs/";
    assert.equal(
      pickIcon(
        `<link rel="apple-touch-icon" href="/touch.png">
         <link rel="icon" type="image/png" sizes="16x16" href="/16.png">
         <link rel="icon" href="/plain.ico">
         <link rel="icon" type="image/png" sizes="192x192" href="/192.png">
         <link rel="icon" type="image/png" sizes="32x32" href="/32.png">
         <link rel="icon" type="image/svg+xml" href="icon.svg">`,
        base,
      ),
      "https://example.com/docs/icon.svg",
    );
    assert.equal(pickIcon(`<link rel="icon" sizes="16x16" href="/16.png"><link rel="shortcut icon" href="/plain.ico">`, base), "https://example.com/plain.ico");
    assert.equal(pickIcon(`<link rel="apple-touch-icon" href="/touch.png"><link rel="icon" sizes="16x16" href="/16.png">`, base), "https://example.com/16.png");
    assert.equal(pickIcon(`<LINK HREF='/touch.png' REL='apple-touch-icon'>`, base), "https://example.com/touch.png");
    // neither a monochrome pinned-tab mask, a hi-res tile, a commented-out icon nor an inline one can stand in
    assert.equal(
      pickIcon(
        `<link rel="mask-icon" href="/mask.svg"><link rel="fluid-icon" href="/fluid.png">
         <!-- <link rel="icon" href="/old.ico"> --><link rel="icon" href="data:image/png;base64,AAAA">`,
        base,
      ),
      null,
    );
    assert.equal(pickIcon(`<link rel=icon href=/i.png?v=2&amp;s=32>`, base), "https://example.com/i.png?v=2&s=32");
  });

  test("the icon comes from the page a site sends one to, and each site is asked once", async () => {
    const s = await site({
      "/": [301, { location: "/en/" }, ""],
      "/en/": html(`<link rel="icon" href="favicon.svg">`),
    });
    try {
      const favicons = new Favicons();
      const [a, b] = await Promise.all([favicons.find(s.origin), favicons.find(s.origin)]);
      assert.deepEqual(a, { url: `${s.origin}/en/favicon.svg`, guessed: false });
      assert.equal(b, a);
      assert.deepEqual(await favicons.find(s.origin), a);
      assert.deepEqual(s.hits, ["/", "/en/"]);
    } finally {
      s.close();
    }
  });

  test("a page without icons leaves the default place, and an unreadable one is only a guess", async () => {
    const plain = await site({ "/": html(`<title>no icons</title>`) });
    const broken = await site({ "/": [500, {}, "down"] });
    try {
      const favicons = new Favicons();
      assert.deepEqual(await favicons.find(plain.origin), { url: `${plain.origin}/favicon.ico`, guessed: false });
      assert.deepEqual(await favicons.find(broken.origin), { url: `${broken.origin}/favicon.ico`, guessed: true });
    } finally {
      plain.close();
      broken.close();
    }
  });

  test("a site cannot redirect core to a machine on the local network", async () => {
    const inside = await site({ "/": html(`<link rel="icon" href="/secret.png">`) });
    const outside = await site({ "/": [302, { location: `${inside.origin}/` }, ""] });
    try {
      assert.deepEqual(await new Favicons().find(outside.origin), { url: `${outside.origin}/favicon.ico`, guessed: true });
      assert.deepEqual(inside.hits, []);
    } finally {
      inside.close();
      outside.close();
    }
  });
});
