import { expect, test } from "bun:test";
import type { ScrapeRequest, ScrapeResponse } from "@buncrawl/contracts";
import {
  claimJobItem,
  completeJobItem,
  createDb,
  failJobItem,
  getJob,
  migrateDb,
} from "@buncrawl/db";
import { DiscoveryWorker } from "@buncrawl/jobs";

import { createBatchScrapeHandler } from "../src/routes/v1/batch-scrape";
import { createDiscoveryHandler } from "../src/routes/v1/discovery";
import { createScrapeHandler } from "../src/routes/v1/scrape";
import { createFirecrawlV2Handlers } from "../src/routes/v2/firecrawl";

const base = "http://localhost/v2";
const origin = "https://site.example";
const secret = "s".repeat(16);
const dispatch = { listen: async () => {}, close: () => {} };
const branding = {
  colorScheme: "light" as const,
  brandName: "Site",
  colors: { primary: "#0055ff", background: "#ffffff" },
  typography: { fontFamilies: { primary: "Inter" } },
};

async function setup(scrape?: (request: ScrapeRequest) => Promise<ScrapeResponse>) {
  const db = createDb({ DATABASE_URL: ":memory:" });
  await migrateDb(db);
  const scraped: ScrapeRequest[] = [];
  const v2 = createFirecrawlV2Handlers({
    scrape: createScrapeHandler(async (request) => {
      scraped.push(request);
      return scrape
        ? scrape(request)
        : {
            success: true,
            data: {
              markdown: "# Site",
              branding,
              metadata: {
                sourceURL: request.url,
                finalURL: `${request.url}/`,
                title: "Site",
                statusCode: 200,
                contentType: "text/html",
                renderer: "chromium",
              },
            },
          };
    }),
    batchScrape: createBatchScrapeHandler(db, async () => {}),
    crawl: createDiscoveryHandler(db, "crawl", async () => {}),
    map: createDiscoveryHandler(db, "map", async () => {}),
    webhookSecret: secret,
    mapPollMs: 10,
  });
  return { db, v2, scraped };
}

function post(path: string, body: unknown) {
  return new Request(`${base}${path}`, { method: "POST", body: JSON.stringify(body) });
}

test("POST /v2/scrape returns a Firecrawl-shaped document with branding", async () => {
  const { v2, scraped } = await setup();
  const response = await v2.scrape(
    post("/scrape", { url: origin, formats: ["markdown", { type: "branding" }], waitFor: 200 }),
  );
  expect(response.status).toBe(200);
  expect(scraped).toEqual([
    { url: origin, formats: ["markdown", "branding"], onlyMainContent: true, waitForMs: 200 },
  ]);
  expect(await response.json()).toEqual({
    success: true,
    data: {
      markdown: "# Site",
      branding,
      metadata: {
        title: "Site",
        sourceURL: origin,
        url: `${origin}/`,
        statusCode: 200,
        contentType: "text/html",
        proxyUsed: "basic",
      },
    },
  });
});

test("POST /v2/scrape rejects unsupported options before scraping", async () => {
  const { v2, scraped } = await setup();
  const response = await v2.scrape(
    post("/scrape", {
      url: origin,
      formats: [{ type: "json", prompt: "x" }],
      actions: [{ type: "scroll" }],
    }),
  );
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({
    success: false,
    code: "UNSUPPORTED_OPTION",
    details: ["actions", "formats[json]"],
  });
  expect(scraped).toEqual([]);

  const invalid = await v2.scrape(post("/scrape", { url: origin, timeout: 999_999 }));
  expect(invalid.status).toBe(400);
  expect(await invalid.json()).toMatchObject({ success: false, code: "INVALID_REQUEST" });

  const notJson = await v2.scrape(new Request(`${base}/scrape`, { method: "POST", body: "{" }));
  expect(notJson.status).toBe(400);
  expect((await v2.scrape(new Request(`${base}/scrape`))).status).toBe(405);
});

test("POST /v2/scrape translates canonical failures and warnings", async () => {
  const timedOut = await setup(async () => ({
    success: false,
    code: "DEADLINE_EXCEEDED",
    error: "Scrape timed out",
  }));
  const failure = await timedOut.v2.scrape(post("/scrape", { url: origin }));
  expect(failure.status).toBe(408);
  expect(await failure.json()).toEqual({
    success: false,
    code: "SCRAPE_TIMEOUT",
    error: "Scrape timed out",
  });

  const warned = await setup(async (request) => ({
    success: true,
    warning: "Branding could not be measured",
    data: {
      markdown: "x",
      metadata: {
        sourceURL: request.url,
        finalURL: request.url,
        statusCode: 200,
        renderer: "chromium",
      },
    },
  }));
  expect(await (await warned.v2.scrape(post("/scrape", { url: origin }))).json()).toMatchObject({
    success: true,
    warning: "Branding could not be measured",
    data: { warning: "Branding could not be measured" },
  });
});

test("batch scrape submits, pages status, lists errors, and cancels", async () => {
  const { db, v2 } = await setup();
  const submitted = await v2.batchScrape(
    post("/batch/scrape", {
      urls: [`${origin}/a`, `${origin}/b`, "mailto:x@site.example"],
      formats: ["markdown", "branding"],
      webhook: { url: "https://hook.example/in", events: ["page", "completed"] },
    }),
  );
  expect(submitted.status).toBe(200);
  const body = (await submitted.json()) as { id: string; url: string; invalidURLs: string[] };
  expect(body).toMatchObject({ success: true, invalidURLs: ["mailto:x@site.example"] });
  expect(body.url).toBe(`${base}/batch/scrape/${body.id}`);
  expect((await getJob(db, body.id))?.request).toEqual({
    type: "batch_scrape",
    requests: [
      { url: `${origin}/a`, formats: ["markdown", "branding"], onlyMainContent: true },
      { url: `${origin}/b`, formats: ["markdown", "branding"], onlyMainContent: true },
    ],
    webhook: {
      url: "https://hook.example/in",
      secret,
      events: ["item_completed", "state_changed"],
    },
  });

  const running = await v2.batchScrape(new Request(`${base}/batch/scrape/${body.id}`), body.id);
  expect(await running.json()).toMatchObject({
    success: true,
    status: "scraping",
    completed: 0,
    total: 2,
    data: [],
  });

  const first = await claimJobItem(db, { workerId: "w", leaseMs: 30_000 });
  await completeJobItem(db, first!.id, "w", first!.leaseVersion, {
    markdown: "# A",
    branding,
    metadata: {
      sourceURL: `${origin}/a`,
      finalURL: `${origin}/a`,
      statusCode: 200,
      renderer: "chromium",
    },
  });
  const second = await claimJobItem(db, { workerId: "w", leaseMs: 30_000 });
  await failJobItem(db, second!.id, "w", second!.leaseVersion, {
    code: "FETCH_FAILED",
    message: "Unavailable",
    retryable: false,
  });

  const page = await v2.batchScrape(
    new Request(`${base}/batch/scrape/${body.id}?limit=1`),
    body.id,
  );
  const pageBody = (await page.json()) as Record<string, unknown>;
  expect(pageBody).toMatchObject({
    success: true,
    status: "completed",
    completed: 1,
    total: 2,
    creditsUsed: 1,
    next: `${base}/batch/scrape/${body.id}?skip=1&limit=1`,
    data: [{ markdown: "# A", branding, metadata: { url: `${origin}/a`, proxyUsed: "basic" } }],
  });
  expect(pageBody.completedAt).toEqual(expect.any(String));
  const rest = await v2.batchScrape(new Request(pageBody.next as string), body.id);
  expect(await rest.json()).toMatchObject({ status: "completed", data: [] });

  const errors = await v2.batchScrapeErrors(
    new Request(`${base}/batch/scrape/${body.id}/errors`),
    body.id,
  );
  expect(await errors.json()).toEqual({
    errors: [{ id: second!.id, url: `${origin}/b`, code: "FETCH_FAILED", error: "Unavailable" }],
    robotsBlocked: [],
  });

  const finished = await v2.batchScrape(
    new Request(`${base}/batch/scrape/${body.id}`, { method: "DELETE" }),
    body.id,
  );
  expect(finished.status).toBe(409);

  const queued = (await (
    await v2.batchScrape(post("/batch/scrape", { urls: [`${origin}/c`] }))
  ).json()) as { id: string };
  const cancelled = await v2.batchScrape(
    new Request(`${base}/batch/scrape/${queued.id}`, { method: "DELETE" }),
    queued.id,
  );
  expect(await cancelled.json()).toEqual({ success: true, status: "cancelled" });
  expect(
    await (
      await v2.batchScrape(new Request(`${base}/batch/scrape/${queued.id}`), queued.id)
    ).json(),
  ).toMatchObject({ status: "cancelled" });
});

test("batch scrape rejects unsupported options and reports missing jobs", async () => {
  const { v2 } = await setup();
  const unsupported = await v2.batchScrape(
    post("/batch/scrape", { urls: [origin], formats: ["changeTracking"], appendToId: "x" }),
  );
  expect(await unsupported.json()).toMatchObject({
    code: "UNSUPPORTED_OPTION",
    details: ["appendToId", "formats[changeTracking]"],
  });
  const strict = await v2.batchScrape(
    post("/batch/scrape", { urls: [origin, "nope"], ignoreInvalidURLs: false }),
  );
  expect(strict.status).toBe(400);
  const missingId = `job_${"0".repeat(32)}`;
  const missing = await v2.batchScrape(new Request(`${base}/batch/scrape/${missingId}`), missingId);
  expect(missing.status).toBe(404);
  expect(await missing.json()).toEqual({
    success: false,
    code: "JOB_NOT_FOUND",
    error: "Job not found",
  });
  const invalidId = await v2.crawl(new Request(`${base}/crawl/abc`), "abc");
  expect(invalidId.status).toBe(400);
});

test("crawl and map run on canonical discovery jobs", async () => {
  const { db, v2 } = await setup();
  const worker = new DiscoveryWorker({
    db,
    dispatch,
    pollMs: 10,
    resolver: async () => ["8.8.8.8"],
    fetchImpl: async (input) => {
      const url = String(input);
      if (url.endsWith("robots.txt")) return new Response("User-agent: *\nDisallow: /docs/private");
      if (url.endsWith("sitemap.xml")) return new Response("", { status: 404 });
      if (url.endsWith("/docs"))
        return new Response('<a href="/docs/child">child</a><a href="/docs/private">x</a>', {
          headers: { "content-type": "text/html" },
        });
      return new Response("child", { headers: { "content-type": "text/html" } });
    },
    scrapeItem: async (request) => ({
      success: true,
      data: {
        markdown: `# ${request.url}`,
        metadata: {
          sourceURL: request.url,
          finalURL: request.url,
          statusCode: 200,
          renderer: "fetch",
        },
      },
    }),
  });
  await worker.start();
  try {
    const submitted = await v2.crawl(
      post("/crawl", { url: `${origin}/docs`, limit: 5, scrapeOptions: { formats: ["markdown"] } }),
    );
    const { id, url } = (await submitted.json()) as { id: string; url: string };
    expect(url).toBe(`${base}/crawl/${id}`);
    expect((await getJob(db, id))?.request).toMatchObject({
      type: "crawl",
      maxPages: 5,
      scrapeOptions: { formats: ["markdown"], onlyMainContent: true },
    });
    let status: { status: string; data: { markdown: string; metadata: { url: string } }[] };
    for (let i = 0; ; i++) {
      status = (await (
        await v2.crawl(new Request(`${base}/crawl/${id}`), id)
      ).json()) as typeof status;
      if (status.status !== "scraping" || i > 200) break;
      await Bun.sleep(10);
    }
    expect(status.status).toBe("completed");
    expect(status.data.map((document) => document.metadata.url).sort()).toEqual([
      `${origin}/docs`,
      `${origin}/docs/child`,
    ]);

    expect(
      await (await v2.crawlErrors(new Request(`${base}/crawl/${id}/errors`), id)).json(),
    ).toEqual({ errors: [], robotsBlocked: [] });
    const mapped = await v2.map(post("/map", { url: `${origin}/docs`, limit: 10 }));
    expect(mapped.status).toBe(200);
    const mapBody = (await mapped.json()) as { success: boolean; links: { url: string }[] };
    expect(mapBody.success).toBe(true);
    expect(mapBody.links.map((link) => link.url).sort()).toEqual([
      `${origin}/docs`,
      `${origin}/docs/child`,
    ]);

    const unsupportedMap = await v2.map(post("/map", { url: origin, search: "docs" }));
    expect(await unsupportedMap.json()).toMatchObject({
      code: "UNSUPPORTED_OPTION",
      details: ["search"],
    });
    const unsupportedCrawl = await v2.crawl(post("/crawl", { url: origin, ignoreRobotsTxt: true }));
    expect(unsupportedCrawl.status).toBe(400);
  } finally {
    await worker.stop();
  }
});

test("crawl errors read every canonical page and separate robots-blocked URLs", async () => {
  const id = `job_${"1".repeat(32)}`;
  const failed = (url: string, code: string) => ({
    url,
    state: "failed",
    error: { code, message: `${code} message`, retryable: false },
  });
  const pages: Record<string, unknown> = {
    "0": {
      items: [failed(`${origin}/a`, "FETCH_FAILED")],
      next: `http://localhost/v1/crawl/${id}?cursor=1&limit=100`,
    },
    "1": {
      items: [{ url: `${origin}/b`, state: "completed" }, failed(`${origin}/c`, "ROBOTS_BLOCKED")],
    },
  };
  const cursors: string[] = [];
  const unused = async () => new Response(null, { status: 500 });
  const v2 = createFirecrawlV2Handlers({
    scrape: unused,
    batchScrape: unused,
    map: unused,
    crawl: async (request) => {
      const cursor = new URL(request.url).searchParams.get("cursor")!;
      cursors.push(cursor);
      return Response.json(pages[cursor]);
    },
  });
  const response = await v2.crawlErrors(new Request(`${base}/crawl/${id}/errors`), id);
  expect(cursors).toEqual(["0", "1"]);
  expect(await response.json()).toEqual({
    errors: [
      {
        id: `${origin}/a`,
        url: `${origin}/a`,
        code: "FETCH_FAILED",
        error: "FETCH_FAILED message",
      },
    ],
    robotsBlocked: [`${origin}/c`],
  });
});

test("crawl status resolves artifact references the Firecrawl way", async () => {
  const key = `${"c".repeat(32)}`;
  const document = {
    metadata: { sourceURL: origin, finalURL: origin, statusCode: 200, renderer: "webview" },
    markdown: `artifact://${key}.md`,
    screenshot: `artifact://${key}.png`,
  };
  const unused = async () => new Response(null, { status: 500 });
  const v2 = createFirecrawlV2Handlers({
    scrape: unused,
    batchScrape: unused,
    map: unused,
    crawl: async () =>
      Response.json({
        state: "completed",
        progress: { total: 1, queued: 0, running: 0, succeeded: 1, failed: 0, cancelled: 0 },
        createdAt: "2026-11-23T00:00:00.000Z",
        items: [{ url: origin, state: "completed", document }],
        documents: [document],
      }),
    readArtifact: async (requested) =>
      requested === `${key}.md`
        ? { data: new TextEncoder().encode("# Large page"), contentType: "text/markdown" }
        : undefined,
  });
  const response = await v2.crawl(
    new Request(`${base}/crawl/job_${"0".repeat(32)}`),
    `job_${"0".repeat(32)}`,
  );
  const body = (await response.json()) as { data: { markdown: string; screenshot: string }[] };
  // Large text comes back inline; a screenshot becomes a URL clients can download.
  expect(body.data[0]!.markdown).toBe("# Large page");
  expect(body.data[0]!.screenshot).toBe(new URL(`/v1/artifacts/${key}.png`, base).href);
});

test("crawl webhooks need the server secret", async () => {
  const unused = async () => new Response(null, { status: 500 });
  const v2 = createFirecrawlV2Handlers({
    scrape: unused,
    batchScrape: unused,
    map: unused,
    crawl: unused,
  });
  const response = await v2.crawl(post("/crawl", { url: origin, webhook: "https://hook.example" }));
  expect(response.status).toBe(400);
  expect(((await response.json()) as { error: string }).error).toContain("BUNCRAWL_WEBHOOK_SECRET");
});

test("unimplemented Firecrawl endpoints return a clear error", async () => {
  const { v2 } = await setup();
  const response = v2.unsupported(new Request(`${base}/extract`, { method: "POST" }));
  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({
    success: false,
    code: "UNSUPPORTED_ENDPOINT",
    error: "Buncrawl does not implement the Firecrawl endpoint POST /v2/extract",
  });
});
