import { expect, test } from "bun:test";
import {
  claimCrawlUrl,
  createDb,
  enqueueCrawlUrl,
  enqueueJob,
  getCrawlFrontier,
  getJob,
  migrateDb,
} from "@buncrawl/db";
import { DiscoveryWorker } from "@buncrawl/jobs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDiscoveryHandler } from "../src/routes/v1/discovery";

const base = "http://localhost/v1";
const origin = "https://site.example";
const dispatch = { listen: async () => {}, close: () => {} };

async function until(check: () => Promise<boolean>) {
  for (let i = 0; i < 150; i++) {
    if (await check()) return;
    await Bun.sleep(20);
  }
  throw new Error("Job did not finish");
}

test("map discovers sitemap and page links, applies robots and scope, and deduplicates URLs", async () => {
  const db = createDb({ DATABASE_URL: ":memory:" });
  await migrateDb(db);
  const urls: string[] = [];
  const handler = createDiscoveryHandler(db, "map", async () => {});
  const worker = new DiscoveryWorker({
    db,
    dispatch,
    pollMs: 20,
    pageConcurrency: 2,
    resolver: async () => ["8.8.8.8"],
    fetchImpl: async (input) => {
      const url = String(input);
      urls.push(url);
      if (url.endsWith("/robots.txt"))
        return new Response(
          "User-agent: *\nDisallow: /private\nSitemap: https://site.example/sitemap.xml",
        );
      if (url.endsWith("/sitemap.xml"))
        return new Response(
          `<urlset><url><loc>${origin}/seed</loc></url><url><loc>${origin}/private</loc></url></urlset>`,
        );
      if (url === `${origin}/`)
        return new Response(
          '<a href="/a#one">a</a><a href="/private">blocked</a><a href="https://other.example/out">offsite</a>',
          { headers: { "content-type": "text/html" } },
        );
      if (url === `${origin}/a`)
        return new Response('<a href="/seed">already known</a>', {
          headers: { "content-type": "text/html" },
        });
      return new Response("ok", { headers: { "content-type": "text/html" } });
    },
  });
  try {
    const submitted = await handler(
      new Request(`${base}/map`, {
        method: "POST",
        body: JSON.stringify({ url: origin, maxUrls: 10, maxDepth: 2 }),
      }),
    );
    expect(submitted.status).toBe(202);
    const { jobId } = (await submitted.json()) as { jobId: string };
    await worker.start();
    await until(
      async () =>
        (
          (await (await handler(new Request(`${base}/map/${jobId}`), jobId)).json()) as {
            state: string;
          }
        ).state === "completed",
    );
    const status = (await (await handler(new Request(`${base}/map/${jobId}`), jobId)).json()) as {
      urls: string[];
      progress: { succeeded: number; failed: number };
    };
    expect(status.urls).toEqual(
      expect.arrayContaining([`${origin}/`, `${origin}/seed`, `${origin}/a`]),
    );
    expect(status.urls).not.toContain(`${origin}/private`);
    expect(status.progress).toMatchObject({ succeeded: 3, failed: 0 });
    expect(urls).not.toContain(`${origin}/private`);
  } finally {
    await worker.stop();
  }
});

test("crawl scrapes accepted pages and returns persisted document metadata", async () => {
  const db = createDb({ DATABASE_URL: ":memory:" });
  await migrateDb(db);
  const handler = createDiscoveryHandler(db, "crawl", async () => {});
  const scrapes: string[] = [];
  const worker = new DiscoveryWorker({
    db,
    dispatch,
    pollMs: 20,
    resolver: async () => ["8.8.8.8"],
    fetchImpl: async (input) => {
      const url = String(input);
      if (url.endsWith("robots.txt")) return new Response("User-agent: *");
      if (url.endsWith("sitemap.xml")) return new Response("", { status: 404 });
      return new Response(
        url.endsWith("/docs")
          ? '<a href="/docs/child">child</a><a href="/elsewhere">outside path</a>'
          : "child",
        { headers: { "content-type": "text/html" } },
      );
    },
    scrapeItem: async (request) => {
      scrapes.push(request.url);
      return {
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
      };
    },
    persistDocument: async (document) => ({
      ...document,
      markdown: `artifact://stored-${document.metadata.sourceURL.split("/").at(-1)}`,
    }),
  });
  try {
    const submitted = await handler(
      new Request(`${base}/crawl`, {
        method: "POST",
        body: JSON.stringify({ url: `${origin}/docs`, maxPages: 5, maxDepth: 1 }),
      }),
    );
    expect(submitted.status).toBe(202);
    const { jobId } = (await submitted.json()) as { jobId: string };
    await worker.start();
    await until(
      async () =>
        (
          (await (await handler(new Request(`${base}/crawl/${jobId}`), jobId)).json()) as {
            state: string;
          }
        ).state === "completed",
    );
    const result = (await (await handler(new Request(`${base}/crawl/${jobId}`), jobId)).json()) as {
      documents: { markdown?: string }[];
      progress: { succeeded: number };
    };
    expect(scrapes).toEqual(expect.arrayContaining([`${origin}/docs`, `${origin}/docs/child`]));
    expect(scrapes).not.toContain(`${origin}/elsewhere`);
    expect(result.progress.succeeded).toBe(2);
    expect(result.documents.every((document) => document.markdown?.startsWith("artifact://"))).toBe(
      true,
    );
  } finally {
    await worker.stop();
  }
});

test("preserves completed map URLs when a discovered page fails", async () => {
  const db = createDb({ DATABASE_URL: ":memory:" });
  await migrateDb(db);
  const handler = createDiscoveryHandler(db, "map", async () => {});
  const worker = new DiscoveryWorker({
    db,
    dispatch,
    pollMs: 20,
    resolver: async () => ["8.8.8.8"],
    fetchImpl: async (input) => {
      const url = String(input);
      if (url.endsWith("robots.txt")) return new Response("User-agent: *");
      if (url.endsWith("sitemap.xml")) return new Response("", { status: 404 });
      if (url.endsWith("/bad")) return new Response("Not found", { status: 404 });
      return new Response('<a href="/bad">bad</a>', { headers: { "content-type": "text/html" } });
    },
  });
  try {
    const submission = await handler(
      new Request(`${base}/map`, {
        method: "POST",
        body: JSON.stringify({ url: origin, maxDepth: 1 }),
      }),
    );
    const { jobId } = (await submission.json()) as { jobId: string };
    await worker.start();
    await until(async () => (await getJob(db, jobId))?.state === "completed");
    const status = (await (await handler(new Request(`${base}/map/${jobId}`), jobId)).json()) as {
      progress: { succeeded: number; failed: number };
      items: { error?: { code: string } }[];
    };
    expect(status.progress).toMatchObject({ succeeded: 1, failed: 1 });
    expect(status.items.some((item) => item.error?.code === "HTTP_ERROR")).toBe(true);
  } finally {
    await worker.stop();
  }
});

test("cancels a running crawl and leaves its frontier terminal", async () => {
  const db = createDb({ DATABASE_URL: ":memory:" });
  await migrateDb(db);
  const handler = createDiscoveryHandler(db, "crawl", async () => {});
  const worker = new DiscoveryWorker({
    db,
    dispatch,
    pollMs: 20,
    leaseMs: 300,
    resolver: async () => ["8.8.8.8"],
    fetchImpl: async (input, init) => {
      const url = String(input);
      if (url.endsWith("robots.txt")) return new Response("User-agent: *");
      if (url.endsWith("sitemap.xml")) return new Response("", { status: 404 });
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("cancelled")), {
          once: true,
        });
      });
    },
  });
  try {
    const submitted = await handler(
      new Request(`${base}/crawl`, { method: "POST", body: JSON.stringify({ url: origin }) }),
    );
    const { jobId } = (await submitted.json()) as { jobId: string };
    await worker.start();
    await until(async () =>
      (await getCrawlFrontier(db, jobId)).some((entry) => entry.state === "running"),
    );
    const response = await handler(
      new Request(`${base}/crawl/${jobId}`, { method: "DELETE" }),
      jobId,
    );
    expect(response.status).toBe(200);
    await until(async () => (await getJob(db, jobId))?.state === "cancelled");
    expect((await getCrawlFrontier(db, jobId)).every((entry) => entry.state === "cancelled")).toBe(
      true,
    );
  } finally {
    await worker.stop();
  }
});

test("recovers expired frontier and parent leases through a fresh database connection", async () => {
  const root = await mkdtemp(join(tmpdir(), "buncrawl-discovery-restart-"));
  let worker: DiscoveryWorker | undefined;
  try {
    const url = `file:${join(root, "jobs.db")}`;
    const first = createDb({ DATABASE_URL: url });
    await migrateDb(first);
    const { job } = await enqueueJob(first, {
      submission: { type: "map", url: origin, maxDepth: 0 },
      limits: { maxItems: 1, timeoutMs: 60_000 },
    });
    const staleAt = new Date(Date.now() - 1000);
    const { claimJobItem } = await import("@buncrawl/db");
    await claimJobItem(first, { workerId: "dead", leaseMs: 100, now: staleAt, type: "map" });
    await enqueueCrawlUrl(
      first,
      job.id,
      { url: `${origin}/`, origin, depth: 0 },
      { maxPages: 1, maxDepth: 0, maxBytes: 1000, maxElapsedMs: 60_000 },
    );
    await claimCrawlUrl(
      first,
      job.id,
      "dead",
      100,
      { maxPages: 1, maxDepth: 0, maxBytes: 1000, maxElapsedMs: 60_000 },
      staleAt,
    );
    first.$client.close();
    const reopened = createDb({ DATABASE_URL: url });
    worker = new DiscoveryWorker({
      db: reopened,
      dispatch,
      pollMs: 20,
      pageConcurrency: 1,
      resolver: async () => ["8.8.8.8"],
      fetchImpl: async (input) =>
        String(input).endsWith("robots.txt")
          ? new Response("User-agent: *")
          : String(input).endsWith("sitemap.xml")
            ? new Response("", { status: 404 })
            : new Response("ok", { headers: { "content-type": "text/html" } }),
    });
    await worker.start();
    await until(async () => (await getJob(reopened, job.id))?.state === "completed");
    expect((await getCrawlFrontier(reopened, job.id))[0]).toMatchObject({
      state: "completed",
      attempts: 2,
    });
  } finally {
    await worker?.stop();
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);

test("deduplicates sitemap URLs that are already redirect targets and pages map results", async () => {
  const db = createDb({ DATABASE_URL: ":memory:" });
  await migrateDb(db);
  const handler = createDiscoveryHandler(db, "map", async () => {});
  const fetched: string[] = [];
  const worker = new DiscoveryWorker({
    db,
    dispatch,
    pollMs: 20,
    resolver: async () => ["8.8.8.8"],
    fetchImpl: async (input) => {
      const url = String(input);
      fetched.push(url);
      if (url.endsWith("robots.txt")) return new Response("User-agent: *");
      if (url.endsWith("sitemap.xml"))
        return new Response(`<urlset><url><loc>${origin}/canonical</loc></url></urlset>`);
      if (url === `${origin}/`)
        return new Response(null, { status: 302, headers: { location: "/canonical" } });
      return new Response("ok", { headers: { "content-type": "text/html" } });
    },
  });
  try {
    const submitted = await handler(
      new Request(`${base}/map`, {
        method: "POST",
        body: JSON.stringify({ url: origin, maxUrls: 2, maxDepth: 0 }),
      }),
    );
    const { jobId } = (await submitted.json()) as { jobId: string };
    await worker.start();
    await until(async () => (await getJob(db, jobId))?.state === "completed");
    const first = (await (
      await handler(new Request(`${base}/map/${jobId}?limit=1`), jobId)
    ).json()) as { next?: string; urls: string[] };
    const second = (await (await handler(new Request(first.next!), jobId)).json()) as {
      urls: string[];
    };
    expect([...new Set([...first.urls, ...second.urls])]).toEqual([`${origin}/canonical`]);
    expect(fetched.filter((url) => url === `${origin}/canonical`)).toHaveLength(1);
  } finally {
    await worker.stop();
  }
});

test("rejects invalid discovery requests and never follows an out-of-scope redirect", async () => {
  const db = createDb({ DATABASE_URL: ":memory:" });
  await migrateDb(db);
  const handler = createDiscoveryHandler(db, "crawl", async () => {});
  for (const payload of [
    { url: "file:///tmp/x" },
    { url: "https://user:secret@site.example" },
    { url: origin, unknown: true },
  ]) {
    const response = await handler(
      new Request(`${base}/crawl`, { method: "POST", body: JSON.stringify(payload) }),
    );
    expect(response.status).toBe(400);
  }
  const submitted = await handler(
    new Request(`${base}/crawl`, { method: "POST", body: JSON.stringify({ url: origin }) }),
  );
  const { jobId } = (await submitted.json()) as { jobId: string };
  const fetched: string[] = [];
  const worker = new DiscoveryWorker({
    db,
    dispatch,
    pollMs: 20,
    resolver: async () => ["8.8.8.8"],
    fetchImpl: async (input) => {
      const url = String(input);
      fetched.push(url);
      if (url.endsWith("robots.txt")) return new Response("User-agent: *");
      if (url.endsWith("sitemap.xml")) return new Response("", { status: 404 });
      return new Response(null, {
        status: 302,
        headers: { location: "https://other.example/private" },
      });
    },
  });
  try {
    await worker.start();
    await until(async () => (await getJob(db, jobId))?.state === "completed");
    const status = (await (await handler(new Request(`${base}/crawl/${jobId}`), jobId)).json()) as {
      progress: { failed: number };
      items: { error?: { code: string } }[];
    };
    expect(status.progress.failed).toBe(1);
    expect(status.items[0]?.error?.code).toBe("OUT_OF_SCOPE");
    expect(fetched).not.toContain("https://other.example/private");
  } finally {
    await worker.stop();
  }
});

test("crawl runs the existing scrape orchestrator on safely fetched content", async () => {
  const db = createDb({ DATABASE_URL: ":memory:" });
  await migrateDb(db);
  const handler = createDiscoveryHandler(db, "crawl", async () => {});
  const worker = new DiscoveryWorker({
    db,
    dispatch,
    pollMs: 20,
    resolver: async () => ["8.8.8.8"],
    fetchImpl: async (input) => {
      const url = String(input);
      if (url.endsWith("robots.txt")) return new Response("User-agent: *");
      if (url.endsWith("sitemap.xml")) return new Response("", { status: 404 });
      return new Response(
        "<html><body><main><h1>Fetched page</h1><p>Content from the native fetch path.</p></main></body></html>",
        { headers: { "content-type": "text/html" } },
      );
    },
  });
  try {
    const submission = await handler(
      new Request(`${base}/crawl`, {
        method: "POST",
        body: JSON.stringify({
          url: origin,
          maxPages: 1,
          maxDepth: 0,
          scrapeOptions: { renderJs: false },
        }),
      }),
    );
    const { jobId } = (await submission.json()) as { jobId: string };
    await worker.start();
    await until(async () => (await getJob(db, jobId))?.state === "completed");
    const result = (await (await handler(new Request(`${base}/crawl/${jobId}`), jobId)).json()) as {
      documents: { markdown?: string; metadata: { renderer: string } }[];
    };
    expect(result.documents[0]?.markdown).toContain("Fetched page");
    expect(result.documents[0]?.metadata.renderer).toBe("fetch");
  } finally {
    await worker.stop();
  }
});

test("enforces the page byte cap and returns a stable per-page failure", async () => {
  const db = createDb({ DATABASE_URL: ":memory:" });
  await migrateDb(db);
  const handler = createDiscoveryHandler(db, "map", async () => {});
  const worker = new DiscoveryWorker({
    db,
    dispatch,
    pollMs: 20,
    resolver: async () => ["8.8.8.8"],
    fetchImpl: async (input) =>
      String(input).endsWith("robots.txt")
        ? new Response("User-agent: *")
        : String(input).endsWith("sitemap.xml")
          ? new Response("", { status: 404 })
          : new Response("This page exceeds the limit"),
  });
  try {
    const submitted = await handler(
      new Request(`${base}/map`, {
        method: "POST",
        body: JSON.stringify({ url: origin, maxDepth: 0, maxBytes: 10 }),
      }),
    );
    const { jobId } = (await submitted.json()) as { jobId: string };
    await worker.start();
    await until(async () => (await getJob(db, jobId))?.state === "completed");
    const status = (await (await handler(new Request(`${base}/map/${jobId}`), jobId)).json()) as {
      items: { error?: { code: string } }[];
    };
    expect(status.items[0]?.error?.code).toBe("RESPONSE_TOO_LARGE");
  } finally {
    await worker.stop();
  }
});

test("ends an expired crawl with a durable deadline error", async () => {
  const db = createDb({ DATABASE_URL: ":memory:" });
  await migrateDb(db);
  const handler = createDiscoveryHandler(db, "crawl", async () => {});
  const worker = new DiscoveryWorker({
    db,
    dispatch,
    pollMs: 20,
    resolver: async () => ["8.8.8.8"],
    fetchImpl: async (input, init) => {
      const url = String(input);
      if (url.endsWith("robots.txt")) return new Response("User-agent: *");
      if (url.endsWith("sitemap.xml")) return new Response("", { status: 404 });
      return new Promise<Response>((_, reject) =>
        init?.signal?.addEventListener("abort", () => reject(new Error("deadline")), {
          once: true,
        }),
      );
    },
  });
  try {
    const submitted = await handler(
      new Request(`${base}/crawl`, {
        method: "POST",
        body: JSON.stringify({ url: origin, maxPages: 1, timeoutMs: 300 }),
      }),
    );
    const { jobId } = (await submitted.json()) as { jobId: string };
    await worker.start();
    await until(async () => (await getJob(db, jobId))?.state === "failed");
    const result = (await (await handler(new Request(`${base}/crawl/${jobId}`), jobId)).json()) as {
      error?: { code: string };
    };
    expect(result.error?.code).toBe("DEADLINE_EXCEEDED");
  } finally {
    await worker.stop();
  }
});
