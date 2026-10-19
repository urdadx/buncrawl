import { expect, test } from "bun:test";
import { claimJobItem, completeJobItem, createDb, failJobItem, migrateDb } from "@buncrawl/db";

import { createBatchScrapeHandler } from "../src/routes/v1/batch-scrape";

test("batch submission, partial results, and cancellation survive status reads", async () => {
  const db = createDb({ DATABASE_URL: ":memory:" });
  await migrateDb(db);
  const notified: string[] = [];
  const handle = createBatchScrapeHandler(db, async (id) => {
    notified.push(id);
  });
  const url = "http://localhost/v1/batch/scrape";
  const post = await handle(
    new Request(url, {
      method: "POST",
      body: JSON.stringify({
        requests: [{ url: "https://one.example" }, { url: "https://two.example" }],
      }),
    }),
  );
  expect(post.status).toBe(202);
  const { jobId } = (await post.json()) as { jobId: string };
  expect(notified).toEqual([jobId]);

  const first = await claimJobItem(db, { workerId: "w", leaseMs: 30_000 });
  expect(first).toBeDefined();
  await completeJobItem(db, first!.id, "w", first!.leaseVersion, {
    metadata: {
      sourceURL: "https://one.example",
      finalURL: "https://one.example",
      statusCode: 200,
      renderer: "fetch",
    },
  });
  const second = await claimJobItem(db, { workerId: "w", leaseMs: 30_000 });
  await failJobItem(db, second!.id, "w", second!.leaseVersion, {
    code: "FETCH_FAILED",
    message: "Unavailable",
    retryable: false,
  });
  const status = await handle(new Request(`${url}/${jobId}`), jobId);
  expect(await status.json()).toMatchObject({
    state: "completed",
    progress: { succeeded: 1, failed: 1 },
    items: [
      { state: "completed", document: { metadata: { statusCode: 200 } } },
      { state: "failed", error: { code: "FETCH_FAILED" } },
    ],
  });
  const cancel = await handle(new Request(`${url}/${jobId}`, { method: "DELETE" }), jobId);
  expect(cancel.status).toBe(200);
  expect(((await cancel.json()) as { state: string }).state).toBe("completed");
});

test("batch validates input and reports missing jobs", async () => {
  const db = createDb({ DATABASE_URL: ":memory:" });
  await migrateDb(db);
  const handle = createBatchScrapeHandler(db, async () => {});
  expect(
    (
      await handle(
        new Request("http://localhost", {
          method: "POST",
          body: JSON.stringify({ requests: [{ url: "file:///etc/passwd" }] }),
        }),
      )
    ).status,
  ).toBe(400);
  expect(
    (await handle(new Request("http://localhost"), "job_00000000000000000000000000000000")).status,
  ).toBe(404);
});

test("reports a concurrent queue-capacity rejection as 429", async () => {
  const db = createDb({ DATABASE_URL: ":memory:" });
  await migrateDb(db);
  const handle = createBatchScrapeHandler(db, async () => {});
  await db.run("DROP TRIGGER job_items_pending_limit");
  await db.run(`CREATE TRIGGER job_items_pending_limit BEFORE INSERT ON job_items
    WHEN NEW.state = 'queued' AND (SELECT count(*) FROM job_items WHERE state = 'queued') >= 1
    BEGIN SELECT RAISE(ABORT, 'BATCH_QUEUE_FULL'); END`);
  const response = await handle(
    new Request("http://localhost/v1/batch/scrape", {
      method: "POST",
      body: JSON.stringify({
        requests: [{ url: "https://one.example" }, { url: "https://two.example" }],
      }),
    }),
  );
  expect(response.status).toBe(429);
  expect(await response.json()).toMatchObject({ code: "QUEUE_FULL" });
});

test("pages items by stable index with progress on every page", async () => {
  const db = createDb({ DATABASE_URL: ":memory:" });
  await migrateDb(db);
  const handle = createBatchScrapeHandler(db, async () => {});
  const base = "http://localhost/v1/batch/scrape";
  const submitted = await handle(
    new Request(base, {
      method: "POST",
      body: JSON.stringify({
        requests: Array.from({ length: 5 }, (_, i) => ({ url: `https://${i}.example` })),
      }),
    }),
  );
  const { jobId } = (await submitted.json()) as { jobId: string };
  const items: number[] = [];
  let next: string | undefined = `${base}/${jobId}?limit=2`;
  while (next) {
    const page = await handle(new Request(next), jobId);
    expect(page.status).toBe(200);
    const body = (await page.json()) as {
      next?: string;
      items: { index: number }[];
      progress: { total: number };
    };
    expect(body.progress.total).toBe(5);
    items.push(...body.items.map((item) => item.index));
    next = body.next;
  }
  expect(items).toEqual([0, 1, 2, 3, 4]);
  for (const query of [
    "?cursor=-1",
    "?cursor=1.5",
    "?limit=0",
    "?limit=101",
    "?cursor=9999999999999999999",
  ]) {
    const response = await handle(new Request(`${base}/${jobId}${query}`), jobId);
    expect(response.status).toBe(400);
  }
});

test("bounds a page by bytes and still returns an oversized single item", async () => {
  const db = createDb({ DATABASE_URL: ":memory:" });
  await migrateDb(db);
  const handle = createBatchScrapeHandler(db, async () => {});
  const base = "http://localhost/v1/batch/scrape";
  const submitted = await handle(
    new Request(base, {
      method: "POST",
      body: JSON.stringify({
        requests: [{ url: "https://one.example" }, { url: "https://two.example" }],
      }),
    }),
  );
  const { jobId } = (await submitted.json()) as { jobId: string };
  for (let i = 0; i < 2; i++) {
    const item = await claimJobItem(db, { workerId: "w", leaseMs: 30_000 });
    await completeJobItem(db, item!.id, "w", item!.leaseVersion, {
      rawHtml: "x".repeat(i === 0 ? 1_100_000 : 700_000),
      metadata: {
        sourceURL: `https://${i}.example`,
        finalURL: `https://${i}.example`,
        renderer: "fetch",
        statusCode: 200,
      },
    });
  }
  const first = (await (await handle(new Request(`${base}/${jobId}`), jobId)).json()) as {
    items: unknown[];
    next?: string;
  };
  expect(first.items).toHaveLength(1);
  expect(first.next).toContain("cursor=1");
  const second = (await (await handle(new Request(first.next!), jobId)).json()) as {
    items: unknown[];
    next?: string;
  };
  expect(second.items).toHaveLength(1);
  expect(second.next).toBeUndefined();
});
