import { expect, test } from "bun:test";
import { Deadline } from "@buncrawl/core";
import { createDb, enqueueJob, getCrawlFrontier, getCrawlHost, migrateDb } from "@buncrawl/db";

import {
  canonicalCrawlUrl,
  discoveredCrawlUrls,
  discoverSitemapUrls,
  fetchCrawlPage,
  loadRobots,
  parseRobots,
  parseSitemap,
  queueDiscoveredLinks,
  robotsAllows,
  robotsCrawlDelay,
  withinCrawlScope,
} from "../src";

test("canonicalizes discovered URLs and enforces origin and path scope", () => {
  const scope = { url: "https://site.example/docs", pathPrefix: true };
  expect(canonicalCrawlUrl("/docs/a#heading", scope.url)).toBe("https://site.example/docs/a");
  expect(
    discoveredCrawlUrls(
      [
        "#top",
        "/docs/a#one",
        "/docs/a#two",
        "mailto:test@example.com",
        "https://evil.example/docs/a",
        "/other",
      ],
      scope.url,
      scope,
      0,
      2,
    ),
  ).toEqual(["https://site.example/docs/a"]);
  expect(discoveredCrawlUrls(["/docs/a"], scope.url, scope, 2, 2)).toEqual([]);
  expect(withinCrawlScope("https://site.example/docs-extra", scope)).toBe(false);
  expect(
    withinCrawlScope("https://badsite.example/docs", { ...scope, includeSubdomains: true }),
  ).toBe(false);
});

test("selects the most specific robots group and allows equal-length allow rules", () => {
  const file = parseRobots(
    "Sitemap: https://site.example/sitemap.xml\nUser-agent: *\nDisallow: /private\nUser-agent: Buncrawl\nDisallow: /private\nAllow: /private/ok\nCrawl-delay: 0.5",
  );
  expect(robotsAllows(file, "https://site.example/private/ok", "BuncrawlBot")).toBe(true);
  expect(robotsAllows(file, "https://site.example/private/no", "BuncrawlBot")).toBe(false);
  expect(robotsAllows(file, "https://site.example/private/no", "otherbot")).toBe(false);
  expect(robotsCrawlDelay(file, "BuncrawlBot")).toBe(500);
  expect(file.sitemaps).toEqual(["https://site.example/sitemap.xml"]);
});

test("loads and caches robots through bounded safe fetch and persists crawl delay", async () => {
  const db = createDb({ DATABASE_URL: ":memory:" });
  await migrateDb(db);
  const { job } = await enqueueJob(db, {
    submission: { type: "crawl", url: "https://site.example" },
    limits: { maxItems: 10, timeoutMs: 60_000 },
  });
  let fetched = 0;
  const options = {
    resolver: async () => ["8.8.8.8"],
    fetchImpl: async () => {
      fetched++;
      return new Response("User-agent: *\nDisallow: /secret\nCrawl-delay: 1", { status: 200 });
    },
  };
  const first = await loadRobots(db, job.id, "https://site.example", "Buncrawl", options);
  const second = await loadRobots(db, job.id, "https://site.example", "Buncrawl", options);
  expect(fetched).toBe(1);
  expect(robotsAllows(first, "https://site.example/secret", "Buncrawl")).toBe(false);
  expect(second).toEqual(first);
  expect((await getCrawlHost(db, job.id, "https://site.example"))?.minDelayMs).toBe(1000);
});

test("bounds sitemap indexes, deduplicates cycles and filters off-origin URLs", async () => {
  const docs = new Map([
    [
      "https://site.example/sitemap.xml",
      "<sitemapindex><sitemap><loc>https://site.example/child.xml</loc></sitemap></sitemapindex>",
    ],
    [
      "https://site.example/child.xml",
      "<urlset><url><loc>https://site.example/docs/a?x=1&amp;y=2</loc></url><url><loc>https://evil.example/skip</loc></url></urlset>",
    ],
  ]);
  const options = {
    deadline: new Deadline(5000),
    resolver: async () => ["8.8.8.8"],
    fetchImpl: async (url: string | URL | Request) =>
      new Response(docs.get(String(url)) ?? "", { status: docs.has(String(url)) ? 200 : 404 }),
  };
  expect(
    await discoverSitemapUrls(
      ["https://site.example/sitemap.xml", "https://site.example/sitemap.xml"],
      { url: "https://site.example/docs", pathPrefix: true },
      options,
    ),
  ).toEqual(["https://site.example/docs/a?x=1&y=2"]);
  expect(() => parseSitemap("<!DOCTYPE foo><urlset></urlset>")).toThrow();
  expect(() =>
    parseSitemap("<urlset><url><loc>a</loc></url><url><loc>b</loc></url></urlset>", 1),
  ).toThrow();
  await expect(
    discoverSitemapUrls(
      ["https://site.example/sitemap.xml"],
      { url: "https://site.example" },
      { ...options, maxDepth: 1, maxSitemaps: 1 },
    ),
  ).rejects.toThrow("Sitemap file limit exceeded");
});

test("checks robots before redirects, enforces scope, and caps fetched page bytes", async () => {
  const db = createDb({ DATABASE_URL: ":memory:" });
  await migrateDb(db);
  const { job } = await enqueueJob(db, {
    submission: { type: "map", url: "https://site.example" },
    limits: { maxItems: 5, timeoutMs: 60_000 },
  });
  const visited: string[] = [];
  const fetchImpl = async (input: string | URL | Request) => {
    const url = String(input);
    visited.push(url);
    if (url.endsWith("robots.txt"))
      return new Response("User-agent: *\nDisallow: /blocked", { status: 200 });
    if (url.endsWith("/start"))
      return new Response(null, { status: 302, headers: { Location: "/blocked" } });
    return new Response('<a href="/next#part">next</a>', {
      status: 200,
      headers: { "content-type": "text/html" },
    });
  };
  const options = {
    deadline: new Deadline(5000),
    scope: { url: "https://site.example" },
    depth: 0,
    userAgent: "Buncrawl",
    resolver: async () => ["8.8.8.8"],
    fetchImpl,
    limits: { maxDepth: 1, maxPages: 5, maxBytes: 1000, maxElapsedMs: 5000 },
  };
  await expect(fetchCrawlPage(db, job.id, "https://site.example/start", options)).rejects.toThrow(
    "Blocked by robots.txt",
  );
  expect(visited).not.toContain("https://site.example/blocked");
  const page = await fetchCrawlPage(db, job.id, "https://site.example/allowed", options);
  expect(page.links).toEqual(["https://site.example/next"]);
  await expect(
    fetchCrawlPage(db, job.id, "https://site.example/allowed", {
      ...options,
      limits: { ...options.limits, maxBytes: 3 },
    }),
  ).rejects.toThrow("Response");
});

test("queues only in-scope robots-allowed links and atomically deduplicates cycles", async () => {
  const db = createDb({ DATABASE_URL: ":memory:" });
  await migrateDb(db);
  const { job } = await enqueueJob(db, {
    submission: { type: "crawl", url: "https://site.example" },
    limits: { maxItems: 5, timeoutMs: 60_000 },
  });
  const options = {
    deadline: new Deadline(5000),
    scope: { url: "https://site.example" },
    depth: 0,
    limits: { maxDepth: 2, maxPages: 5, maxBytes: 1000, maxElapsedMs: 5000 },
    userAgent: "Buncrawl",
    resolver: async () => ["8.8.8.8"],
    fetchImpl: async () => new Response("User-agent: *\nDisallow: /private"),
  };
  const links = ["/a#one", "/a#two", "/private", "mailto:x@y.com", "https://evil.example/a"];
  expect(await queueDiscoveredLinks(db, job.id, links, "https://site.example", 0, options)).toEqual(
    ["https://site.example/a"],
  );
  expect(
    await queueDiscoveredLinks(db, job.id, links, "https://site.example/a", 1, options),
  ).toEqual([]);
  expect((await getCrawlFrontier(db, job.id)).map(({ url }) => url)).toEqual([
    "https://site.example/a",
  ]);
});
