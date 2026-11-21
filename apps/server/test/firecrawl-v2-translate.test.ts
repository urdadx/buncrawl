import { describe, expect, test } from "bun:test";

import {
  createIssues,
  issuesResponse,
  toFirecrawlDocument,
  toFirecrawlError,
  toFirecrawlJobStatus,
  toFirecrawlStatus,
  translateBatchScrapeRequest,
  translateCrawlRequest,
  translateMapRequest,
  translateScrapeRequest,
  translateWebhook,
} from "../src/routes/v2/translate";

const secret = "s".repeat(16);

function scrape(body: Record<string, unknown>) {
  const issues = createIssues();
  return {
    request: translateScrapeRequest({ url: "https://site.example", ...body }, issues),
    issues,
  };
}

describe("scrape request translation", () => {
  test("applies Firecrawl defaults explicitly", () => {
    const { request, issues } = scrape({});
    expect(issues).toEqual({ invalid: [], unsupported: [] });
    expect(request).toEqual({
      url: "https://site.example",
      formats: ["markdown"],
      onlyMainContent: true,
    });
  });

  test("maps string and object formats, including branding and screenshots", () => {
    const { request, issues } = scrape({
      formats: [
        "markdown",
        { type: "html" },
        "rawHtml",
        "links",
        { type: "branding", mode: "fast" },
        { type: "screenshot", fullPage: true, viewport: { width: 800, height: 600 } },
      ],
    });
    expect(issues).toEqual({ invalid: [], unsupported: [] });
    expect(request.formats).toEqual([
      "markdown",
      "html",
      "rawHtml",
      "links",
      "branding",
      { type: "screenshot", fullPage: true, viewport: { width: 800, height: 600 } },
    ]);
    expect(scrape({ formats: ["screenshot"] }).request.formats).toEqual([{ type: "screenshot" }]);
  });

  test("renames timing and cache options", () => {
    const { request } = scrape({
      onlyMainContent: false,
      timeout: 15_000,
      waitFor: 500,
      maxAge: 60_000,
      storeInCache: false,
    });
    expect(request).toMatchObject({
      onlyMainContent: false,
      timeout: 15_000,
      waitForMs: 500,
      maxAge: 60_000,
      storeInCache: false,
    });
    expect(scrape({ waitFor: 0 }).request).not.toHaveProperty("waitForMs");
  });

  test("accepts Firecrawl defaults and no-op options", () => {
    const { issues } = scrape({
      mobile: false,
      proxy: "auto",
      blockAds: false,
      removeBase64Images: true,
      skipTlsVerification: false,
      headers: {},
      actions: [],
      origin: "js-sdk@4",
      integration: null,
      zeroDataRetention: false,
      __experimental_omce: false,
    });
    expect(issues).toEqual({ invalid: [], unsupported: [] });
  });

  test.each([
    ["actions", { actions: [{ type: "click", selector: "a" }] }, "actions"],
    ["json extraction", { formats: [{ type: "json", prompt: "x" }] }, "formats[json]"],
    ["summary", { formats: ["summary"] }, "formats[summary]"],
    [
      "change tracking",
      { formats: ["markdown", { type: "changeTracking" }] },
      "formats[changeTracking]",
    ],
    ["images", { formats: ["images"] }, "formats[images]"],
    [
      "screenshot quality",
      { formats: [{ type: "screenshot", quality: 50 }] },
      "formats[screenshot].quality",
    ],
    ["custom headers", { headers: { cookie: "a" } }, "headers"],
    ["tag filters", { includeTags: ["main"] }, "includeTags"],
    ["mobile", { mobile: true }, "mobile"],
    ["stealth proxy", { proxy: "stealth" }, "proxy"],
    ["location", { location: { country: "DE" } }, "location"],
    ["parsers", { parsers: ["pdf"] }, "parsers"],
    ["zero data retention", { zeroDataRetention: true }, "zeroDataRetention"],
    ["experimental flags", { __experimental_engpicker: true }, "__experimental_engpicker"],
  ])("reports %s as unsupported", (_name, body, option) => {
    const { issues } = scrape(body);
    expect(issues.invalid).toEqual([]);
    expect(issues.unsupported).toEqual([option]);
  });

  test("rejects unknown keys and formats as invalid", () => {
    expect(scrape({ bogus: 1 }).issues.invalid).toEqual(["Unrecognized key: bogus"]);
    expect(scrape({ formats: ["pdf"] }).issues.invalid).toEqual(["Unknown format: pdf"]);
    expect(scrape({ formats: "markdown" }).issues.invalid).toEqual(["formats must be an array"]);
    const missing = createIssues();
    translateScrapeRequest({}, missing);
    expect(missing.invalid).toEqual(["url is required"]);
  });
});

describe("webhook translation", () => {
  test("maps Firecrawl events to canonical events per job type", () => {
    const issues = createIssues();
    expect(translateWebhook("https://hook.example", "item_completed", secret, issues)).toEqual({
      url: "https://hook.example",
      secret,
      events: ["state_changed", "item_completed", "error"],
    });
    expect(
      translateWebhook(
        { url: "https://hook.example", events: ["page"], headers: {}, metadata: {} },
        "page_completed",
        secret,
        issues,
      ),
    ).toEqual({ url: "https://hook.example", secret, events: ["page_completed"] });
    expect(
      translateWebhook(
        { url: "https://hook.example", events: ["completed"] },
        "page_completed",
        secret,
        issues,
      )?.events,
    ).toEqual(["state_changed"]);
    expect(issues).toEqual({ invalid: [], unsupported: [] });
  });

  test("reports custom headers, metadata, and a missing server secret", () => {
    const issues = createIssues();
    translateWebhook(
      { url: "https://hook.example", headers: { a: "b" }, metadata: { run: "1" } },
      "page_completed",
      secret,
      issues,
    );
    expect(issues.unsupported).toEqual(["webhook.headers", "webhook.metadata"]);
    const noSecret = createIssues();
    expect(translateWebhook("https://hook.example", "page_completed", undefined, noSecret)).toBe(
      undefined,
    );
    expect(noSecret.unsupported[0]).toContain("BUNCRAWL_WEBHOOK_SECRET");
    const badEvent = createIssues();
    translateWebhook(
      { url: "https://hook.example", events: ["done"] },
      "page_completed",
      secret,
      badEvent,
    );
    expect(badEvent.invalid).toContain("Unknown webhook event: done");
  });
});

describe("job request translation", () => {
  test("batch scrape shares scrape options and reports invalid URLs", () => {
    const issues = createIssues();
    const { submission, invalidURLs } = translateBatchScrapeRequest(
      {
        urls: ["https://a.example", "ftp://b.example", "not a url"],
        formats: ["branding"],
        maxConcurrency: 2,
        webhook: { url: "https://hook.example", events: ["page"] },
      },
      secret,
      issues,
    );
    expect(issues).toEqual({ invalid: [], unsupported: [] });
    expect(invalidURLs).toEqual(["ftp://b.example", "not a url"]);
    expect(submission).toEqual({
      requests: [{ url: "https://a.example", formats: ["branding"], onlyMainContent: true }],
      webhook: { url: "https://hook.example", secret, events: ["item_completed"] },
    });

    const strict = createIssues();
    const result = translateBatchScrapeRequest(
      { urls: ["https://a.example", "nope"], ignoreInvalidURLs: false },
      secret,
      strict,
    );
    expect(result.invalidURLs).toBeUndefined();
    expect(strict.invalid).toEqual(["Invalid URLs: nope"]);

    const append = createIssues();
    translateBatchScrapeRequest({ urls: ["https://a.example"], appendToId: "x" }, secret, append);
    expect(append.unsupported).toEqual(["appendToId"]);
  });

  test("crawl maps limits, scope, and nested scrape options", () => {
    const issues = createIssues();
    expect(translateCrawlRequest({ url: "https://site.example/docs" }, secret, issues)).toEqual({
      url: "https://site.example/docs",
      maxPages: 10_000,
      scrapeOptions: { formats: ["markdown"], onlyMainContent: true },
    });
    expect(
      translateCrawlRequest(
        {
          url: "https://site.example",
          limit: 20,
          allowSubdomains: true,
          crawlEntireDomain: true,
          sitemap: "include",
          includePaths: [],
          scrapeOptions: { formats: ["markdown", "branding"], waitFor: 100 },
        },
        secret,
        issues,
      ),
    ).toEqual({
      url: "https://site.example",
      maxPages: 20,
      includeSubdomains: true,
      pathPrefix: false,
      scrapeOptions: { formats: ["markdown", "branding"], onlyMainContent: true, waitForMs: 100 },
    });
    expect(issues).toEqual({ invalid: [], unsupported: [] });
  });

  test("crawl reports unsupported crawler and nested scrape options", () => {
    const issues = createIssues();
    translateCrawlRequest(
      {
        url: "https://site.example",
        includePaths: ["^/blog"],
        maxDiscoveryDepth: 2,
        allowExternalLinks: true,
        ignoreRobotsTxt: true,
        sitemap: "skip",
        delay: 1,
        prompt: "docs only",
        scrapeOptions: { actions: [{ type: "wait", milliseconds: 1 }], formats: ["summary"] },
      },
      secret,
      issues,
    );
    expect(issues.invalid).toEqual([]);
    expect(issues.unsupported).toEqual([
      "includePaths",
      "maxDiscoveryDepth",
      "allowExternalLinks",
      "ignoreRobotsTxt",
      "sitemap",
      "delay",
      "prompt",
      "scrapeOptions.actions",
      "scrapeOptions.formats[summary]",
    ]);
  });

  test("map applies Firecrawl defaults and reports unsupported options", () => {
    const issues = createIssues();
    expect(translateMapRequest({ url: "https://site.example" }, issues)).toEqual({
      url: "https://site.example",
      maxUrls: 5000,
      includeSubdomains: true,
    });
    expect(
      translateMapRequest(
        {
          url: "https://site.example",
          limit: 10,
          includeSubdomains: false,
          timeout: 5000,
          useIndex: true,
        },
        issues,
      ),
    ).toEqual({
      url: "https://site.example",
      maxUrls: 10,
      includeSubdomains: false,
      timeoutMs: 5000,
    });
    expect(issues).toEqual({ invalid: [], unsupported: [] });
    const unsupported = createIssues();
    translateMapRequest(
      { url: "https://site.example", search: "docs", sitemap: "only" },
      unsupported,
    );
    expect(unsupported.unsupported).toEqual(["search", "sitemap"]);
  });
});

describe("response translation", () => {
  test("maps canonical states to Firecrawl statuses", () => {
    expect(
      ["queued", "running", "cancelling", "completed", "failed", "cancelled"].map((state) =>
        toFirecrawlStatus(state as never),
      ),
    ).toEqual(["scraping", "scraping", "scraping", "completed", "failed", "cancelled"]);
  });

  test("renames document metadata and keeps branding untouched", () => {
    const branding = { colorScheme: "dark" as const, colors: { primary: "#ff0000" } };
    expect(
      toFirecrawlDocument(
        {
          markdown: "# Hi",
          branding,
          metadata: {
            sourceURL: "https://site.example",
            finalURL: "https://www.site.example/",
            title: "Hi",
            statusCode: 200,
            contentType: "text/html",
            renderer: "chromium",
            cacheState: "miss",
          },
        },
        "Branding could not be measured",
      ),
    ).toEqual({
      markdown: "# Hi",
      branding,
      warning: "Branding could not be measured",
      metadata: {
        title: "Hi",
        sourceURL: "https://site.example",
        url: "https://www.site.example/",
        statusCode: 200,
        contentType: "text/html",
        proxyUsed: "basic",
        cacheState: "miss",
      },
    });
  });

  test("builds Firecrawl job status, including failures", () => {
    const progress = { total: 3, queued: 0, running: 0, succeeded: 2, failed: 1, cancelled: 0 };
    expect(
      toFirecrawlJobStatus(
        {
          state: "failed",
          progress,
          createdAt: "2026-01-01T00:00:00.000Z",
          finishedAt: "2026-01-01T00:01:00.000Z",
          error: { code: "DEADLINE_EXCEEDED", message: "Crawl timed out", retryable: false },
        },
        [],
        "https://api.example/v2/crawl/x?skip=100",
      ),
    ).toEqual({
      success: false,
      status: "failed",
      completed: 2,
      total: 3,
      creditsUsed: 2,
      createdAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:01:00.000Z",
      error: "Crawl timed out",
      next: "https://api.example/v2/crawl/x?skip=100",
      data: [],
    });
  });

  test("maps canonical error codes and statuses", async () => {
    const timeout = toFirecrawlError(504, { code: "DEADLINE_EXCEEDED", error: "Timed out" });
    expect(timeout.status).toBe(408);
    expect(await timeout.json()).toEqual({
      success: false,
      code: "SCRAPE_TIMEOUT",
      error: "Timed out",
    });
    const blocked = toFirecrawlError(400, { code: "BLOCKED_DESTINATION", error: "Blocked" });
    expect(blocked.status).toBe(400);
    expect(await blocked.json()).toEqual({
      success: false,
      code: "BLOCKED_DESTINATION",
      error: "Blocked",
    });
  });

  test("prefers invalid input over unsupported options in error responses", async () => {
    expect(issuesResponse(createIssues())).toBeUndefined();
    const response = issuesResponse({ invalid: [], unsupported: ["actions", "formats[json]"] })!;
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      success: false,
      code: "UNSUPPORTED_OPTION",
      error: "Buncrawl does not support these Firecrawl options: actions, formats[json]",
      details: ["actions", "formats[json]"],
    });
    const invalid = issuesResponse({ invalid: ["url is required"], unsupported: ["actions"] })!;
    expect(((await invalid.json()) as { code: string }).code).toBe("BAD_REQUEST");
  });
});
