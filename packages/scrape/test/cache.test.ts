import { describe, expect, test } from "bun:test";
import type { ScrapeDocument, ScrapeRequest } from "@buncrawl/contracts";
import type { FetchPageResult } from "@buncrawl/fetcher";
import type { Renderer } from "@buncrawl/renderer";

import { scrape, scrapeCacheKey, type ScrapeCache, type ScrapeTimings } from "../src";

const page = `<html><body><main><h1>Fresh</h1><p>${"Article text. ".repeat(40)}</p></main></body></html>`;

function fetched(): FetchPageResult {
  return {
    sourceUrl: "https://example.com",
    finalUrl: "https://example.com/",
    statusCode: 200,
    headers: new Headers({ "content-type": "text/html" }),
    contentType: "text/html",
    charset: "utf-8",
    body: page,
    rawBody: new TextEncoder().encode(page),
    elapsedMs: 1,
    redirectCount: 0,
  };
}

class MemoryCache implements ScrapeCache {
  entries = new Map<string, { document: ScrapeDocument; cachedAt: Date }>();
  reads = 0;
  writes = 0;
  failReads = false;

  async get(key: string, maxAgeMs: number) {
    this.reads++;
    if (this.failReads) throw new Error("cache unavailable");
    const entry = this.entries.get(key);
    return entry && Date.now() - entry.cachedAt.getTime() <= maxAgeMs ? entry : undefined;
  }
  async set(key: string, _url: string, document: ScrapeDocument) {
    this.writes++;
    this.entries.set(key, { document, cachedAt: new Date() });
  }
}

/** Keeps tests offline: any request that needs a browser fails fast instead of launching one. */
const offlineRenderer: Renderer = {
  name: "offline",
  capabilities: () => ({
    available: false,
    browser: false,
    javascript: false,
    screenshots: false,
    cdp: false,
  }),
  render: async () => {
    throw new Error("no browser in unit tests");
  },
};

function harness(cache = new MemoryCache()) {
  let fetches = 0;
  const run = async (request: ScrapeRequest, fetchFails = false) => {
    let timings: ScrapeTimings | undefined;
    const response = await scrape(
      request,
      { onTimings: (value) => (timings = value) },
      {
        cache,
        renderer: offlineRenderer,
        fetch: async () => {
          fetches++;
          if (fetchFails) throw Object.assign(new Error("down"), { code: "FETCH_FAILED" });
          return fetched();
        },
      },
    );
    return { response, timings: timings! };
  };
  return { cache, run, fetches: () => fetches };
}

describe("scrape cache key", () => {
  const base: ScrapeRequest = { url: "https://example.com/a?x=1" };

  test("ignores options that do not change the result", () => {
    const key = scrapeCacheKey(base);
    expect(scrapeCacheKey({ ...base, timeout: 5_000 })).toBe(key);
    expect(scrapeCacheKey({ ...base, url: "https://example.com/a?x=1#section" })).toBe(key);
    expect(scrapeCacheKey({ ...base, formats: ["markdown"], onlyMainContent: true })).toBe(key);
    expect(scrapeCacheKey({ ...base, maxAge: 1_000, storeInCache: false })).toBe(key);
    expect(scrapeCacheKey({ ...base, formats: ["links", "markdown"] })).toBe(
      scrapeCacheKey({ ...base, formats: ["markdown", "links"] }),
    );
  });

  test("separates options that change the result", () => {
    const key = scrapeCacheKey(base);
    for (const variant of [
      { url: "https://example.com/a?x=2" },
      { formats: ["markdown", "html"] as const },
      { onlyMainContent: false },
      { renderJs: true },
      { waitForMs: 500 },
    ])
      expect(scrapeCacheKey({ ...base, ...variant } as ScrapeRequest)).not.toBe(key);
  });

  test("does not cache screenshot requests", () => {
    expect(scrapeCacheKey({ ...base, formats: ["markdown", "screenshots"] })).toBeUndefined();
    expect(
      scrapeCacheKey({ ...base, formats: [{ type: "screenshot", fullPage: true }] }),
    ).toBeUndefined();
  });
});

describe("scrape with a cache", () => {
  const url = "https://example.com";

  test("stores fresh results but only serves them when maxAge is set", async () => {
    const { run, cache, fetches } = harness();
    const first = await run({ url });
    expect(first.response.success && first.response.data.metadata.cacheState).toBeUndefined();
    expect(cache.reads).toBe(0);
    expect(cache.writes).toBe(1);

    await run({ url }); // still no maxAge: scrapes fresh again
    expect(fetches()).toBe(2);

    const hit = await run({ url, maxAge: 60_000 });
    expect(fetches()).toBe(2);
    expect(hit.timings.renderer).toBe("cache");
    if (!hit.response.success) throw new Error("expected success");
    expect(hit.response.data.metadata.cacheState).toBe("hit");
    expect(Date.parse(hit.response.data.metadata.cachedAt!)).not.toBeNaN();
    expect(hit.response.data.markdown).toContain("# Fresh");
  });

  test("reports a miss and stores the result when nothing fresh enough exists", async () => {
    const { run, cache, fetches } = harness();
    const miss = await run({ url, maxAge: 60_000 });
    expect(fetches()).toBe(1);
    expect(miss.response.success && miss.response.data.metadata.cacheState).toBe("miss");
    // The stored copy is clean: cache state belongs to a response, not to the document.
    expect([...cache.entries.values()][0]!.document.metadata.cacheState).toBeUndefined();
  });

  test("respects storeInCache: false", async () => {
    const { run, cache } = harness();
    await run({ url, storeInCache: false });
    expect(cache.writes).toBe(0);
  });

  test("never caches failures", async () => {
    const { run, cache } = harness();
    const failed = await run({ url, maxAge: 60_000 }, true);
    expect(failed.response.success).toBe(false);
    expect(cache.writes).toBe(0);
  });

  test("scrapes fresh when the cache cannot be read", async () => {
    const cache = new MemoryCache();
    cache.failReads = true;
    const { run, fetches } = harness(cache);
    const response = await run({ url, maxAge: 60_000 });
    expect(response.response.success).toBe(true);
    expect(fetches()).toBe(1);
  });

  test("does not use the cache for screenshot requests", async () => {
    const { run, cache } = harness();
    const { response } = await run({
      url,
      maxAge: 60_000,
      formats: ["markdown", "screenshots"],
      renderJs: true,
    });
    expect(response.success).toBe(false); // no browser here; the point is the cache was skipped
    expect(cache.reads + cache.writes).toBe(0);
  });
});
