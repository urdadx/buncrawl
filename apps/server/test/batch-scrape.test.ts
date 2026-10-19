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
