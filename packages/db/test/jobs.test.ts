import { describe, expect, test } from "bun:test";

import {
  appendJobEvent,
  claimJobItem,
  completeJobItem,
  createDb,
  enqueueCrawlUrl,
  enqueueJob,
  failJob,
  failJobItem,
  getJob,
  getJobEvents,
  getJobItems,
  heartbeatJobItem,
  JobQueueFullError,
  migrateDb,
  recoverExpiredJobItems,
  requestJobCancellation,
  StaleJobLeaseError,
} from "../src";

const limits = { maxItems: 1000, timeoutMs: 120_000 };

async function setup(urls = ["https://one.example"]) {
  const db = createDb({ DATABASE_URL: ":memory:" });
  await migrateDb(db);
  const enqueued = await enqueueJob(db, {
    submission: {
      type: "batch_scrape",
      requests: urls.map((url) => ({ url })),
    },
    limits,
    now: new Date("2026-01-01T00:00:00.000Z"),
  });
  return { db, ...enqueued };
}

describe("job repository", () => {
  test("atomically enqueues a job, ordered items, and its first event", async () => {
    const { db, job, items } = await setup(["https://one.example", "https://two.example"]);

    expect(job.state).toBe("queued");
    expect(job.progress).toEqual({
      total: 2,
      queued: 2,
      running: 0,
      succeeded: 0,
      failed: 0,
      cancelled: 0,
    });
    expect(items.map((item) => item.index)).toEqual([0, 1]);
    expect(await getJobEvents(db, job.id)).toMatchObject([
      { sequence: 1, type: "state_changed", payload: { state: "queued" } },
    ]);
  });

  test("does not partially enqueue a duplicate job", async () => {
    const { db, job } = await setup();

    await expect(
      enqueueJob(db, {
        id: job.id,
        submission: {
          type: "batch_scrape",
          requests: [{ url: "https://two.example" }, { url: "https://three.example" }],
        },
        limits,
      }),
    ).rejects.toThrow();

    expect(await getJobItems(db, job.id)).toHaveLength(1);
    expect(await getJobEvents(db, job.id)).toHaveLength(1);
  });

  test("enforces queue capacity inside the enqueue transaction", async () => {
    const { db } = await setup();
    await db.run(`DROP TRIGGER job_items_pending_limit`);
    await db.run(`CREATE TRIGGER job_items_pending_limit BEFORE INSERT ON job_items
      WHEN NEW.state IN ('queued', 'running') AND
        (SELECT count(*) FROM job_items WHERE state IN ('queued', 'running')) >= 2
      BEGIN SELECT RAISE(ABORT, 'BATCH_QUEUE_FULL'); END`);
    await expect(
      enqueueJob(db, {
        submission: {
          type: "batch_scrape",
          requests: [{ url: "https://two.example" }, { url: "https://three.example" }],
        },
        limits,
      }),
    ).rejects.toBeInstanceOf(JobQueueFullError);
    const jobs = await db.all<{ count: number }>("SELECT count(*) AS count FROM jobs");
    expect(Number(jobs[0]?.count)).toBe(1);
  });

  test("allows only one worker to claim a single queued item", async () => {
    const { db } = await setup();
    const now = new Date("2026-01-01T00:00:01.000Z");

    const claims = await Promise.all([
      claimJobItem(db, { workerId: "worker-a", leaseMs: 10_000, now }),
      claimJobItem(db, { workerId: "worker-b", leaseMs: 10_000, now }),
    ]);

    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(claims.find(Boolean)).toMatchObject({ state: "running", attempts: 1, leaseVersion: 1 });
  });

  test("heartbeats active leases and rejects stale workers", async () => {
    const { db } = await setup();
    const claimed = await claimJobItem(db, {
      workerId: "worker-a",
      leaseMs: 1000,
      now: new Date("2026-01-01T00:00:01.000Z"),
    });
    expect(claimed).toBeDefined();
    if (!claimed) return;

    const heartbeat = await heartbeatJobItem(
      db,
      claimed.id,
      "worker-a",
      claimed.leaseVersion,
      5000,
      new Date("2026-01-01T00:00:01.500Z"),
    );
    expect(heartbeat.leaseExpiresAt).toEqual(new Date("2026-01-01T00:00:06.500Z"));
    await expect(
      heartbeatJobItem(db, claimed.id, "worker-b", claimed.leaseVersion, 5000),
    ).rejects.toBeInstanceOf(StaleJobLeaseError);
  });

  test("makes completion idempotent for its lease and rejects a stale lease", async () => {
    const { db, job } = await setup();
    const claimed = await claimJobItem(db, { workerId: "worker-a", leaseMs: 10_000 });
    expect(claimed).toBeDefined();
    if (!claimed) return;
    const result = { markdown: "# done" };

    const completed = await completeJobItem(
      db,
      claimed.id,
      "worker-a",
      claimed.leaseVersion,
      result,
    );
    const repeated = await completeJobItem(
      db,
      claimed.id,
      "worker-a",
      claimed.leaseVersion,
      result,
    );

    expect(completed.state).toBe("completed");
    expect(repeated.id).toBe(completed.id);
    await expect(
      completeJobItem(db, claimed.id, "worker-b", claimed.leaseVersion, result),
    ).rejects.toBeInstanceOf(StaleJobLeaseError);
    expect(await getJob(db, job.id)).toMatchObject({
      state: "completed",
      progress: { succeeded: 1, failed: 0 },
    });
  });

  test("supports partial success without failing the parent job", async () => {
    const { db, job } = await setup(["https://one.example", "https://two.example"]);
    const first = await claimJobItem(db, { workerId: "worker-a", leaseMs: 10_000 });
    expect(first).toBeDefined();
    if (!first) return;
    await completeJobItem(db, first.id, "worker-a", first.leaseVersion, { ok: true });

    const second = await claimJobItem(db, { workerId: "worker-b", leaseMs: 10_000 });
    expect(second).toBeDefined();
    if (!second) return;
    await failJobItem(db, second.id, "worker-b", second.leaseVersion, {
      code: "FETCH_FAILED",
      message: "Fetch failed",
      retryable: true,
    });

    expect(await getJob(db, job.id)).toMatchObject({
      state: "completed",
      progress: { total: 2, succeeded: 1, failed: 1 },
    });
  });

  test("durably cancels queued work and finishes after active work stops", async () => {
    const { db, job } = await setup(["https://one.example", "https://two.example"]);
    const claimed = await claimJobItem(db, { workerId: "worker-a", leaseMs: 10_000 });
    expect(claimed).toBeDefined();
    if (!claimed) return;

    expect(await requestJobCancellation(db, job.id)).toMatchObject({ state: "cancelling" });
    expect((await getJobItems(db, job.id)).map((item) => item.state).sort()).toEqual([
      "cancelled",
      "running",
    ]);
    await completeJobItem(db, claimed.id, "worker-a", claimed.leaseVersion, { ok: true });
    expect(await getJob(db, job.id)).toMatchObject({
      state: "cancelled",
      progress: { succeeded: 1, cancelled: 1 },
    });
  });

  test("recovers expired leases and increments the lease version on reclaim", async () => {
    const { db } = await setup();
    const claimed = await claimJobItem(db, {
      workerId: "worker-a",
      leaseMs: 1000,
      now: new Date("2026-01-01T00:00:01.000Z"),
    });
    expect(claimed).toBeDefined();
    if (!claimed) return;

    expect(await recoverExpiredJobItems(db, new Date("2026-01-01T00:00:03.000Z"))).toHaveLength(1);
    const reclaimed = await claimJobItem(db, {
      workerId: "worker-b",
      leaseMs: 1000,
      now: new Date("2026-01-01T00:00:04.000Z"),
    });
    expect(reclaimed).toMatchObject({ leaseOwner: "worker-b", leaseVersion: 2, attempts: 2 });
    await expect(
      completeJobItem(db, claimed.id, "worker-a", claimed.leaseVersion, { stale: true }),
    ).rejects.toBeInstanceOf(StaleJobLeaseError);
  });
});

describe("job event ordering", () => {
  const terminalLast = async (db: Awaited<ReturnType<typeof setup>>["db"], jobId: string) => {
    const events = await getJobEvents(db, jobId);
    return { events, last: events.at(-1) };
  };

  test("never appends events after a terminal state_changed", async () => {
    const { db, job } = await setup();
    const claimed = (await claimJobItem(db, { workerId: "worker", leaseMs: 10_000 }))!;
    await completeJobItem(db, claimed.id, "worker", claimed.leaseVersion, { ok: true });
    const before = await getJobEvents(db, job.id);
    expect(before.at(-1)).toMatchObject({ type: "state_changed", payload: { state: "completed" } });

    await appendJobEvent(db, job.id, "progress", { progress: {} }, new Date());
    await appendJobEvent(db, job.id, "state_changed", { state: "failed" }, new Date());
    expect(await getJobEvents(db, job.id)).toEqual(before);
  });

  test("keeps the final progress written between the terminal commit and its event", async () => {
    const { db, job } = await setup();
    // requestJobCancellation commits "cancelled" before appending progress and state_changed.
    await requestJobCancellation(db, job.id);
    const types = (await getJobEvents(db, job.id)).map((event) => [event.type, event.payload]);
    expect(types.slice(-2)).toEqual([
      ["progress", { progress: expect.objectContaining({ cancelled: 1 }) }],
      ["state_changed", { state: "cancelled" }],
    ]);
  });

  test("only emits progress when it changes", async () => {
    const { db, job } = await setup(["https://one.example", "https://two.example"]);
    const claimed = (await claimJobItem(db, { workerId: "worker", leaseMs: 10_000 }))!;
    await completeJobItem(db, claimed.id, "worker", claimed.leaseVersion, { ok: true });
    const progress = (await getJobEvents(db, job.id))
      .filter((event) => event.type === "progress")
      .map((event) => JSON.stringify(event.payload));
    expect(new Set(progress).size).toBe(progress.length);
  });

  test("crawl jobs report frontier progress and end on their terminal state", async () => {
    const db = createDb({ DATABASE_URL: ":memory:" });
    await migrateDb(db);
    const { job } = await enqueueJob(db, {
      submission: { type: "crawl", url: "https://site.example" },
      limits,
    });
    const crawlLimits = { maxDepth: 2, maxPages: 10, maxBytes: 1000, maxElapsedMs: 60_000 };
    for (const path of ["/", "/a"])
      await enqueueCrawlUrl(
        db,
        job.id,
        { url: `https://site.example${path}`, origin: "https://site.example", depth: 0 },
        crawlLimits,
      );
    const kickoff = (await claimJobItem(db, { workerId: "worker", leaseMs: 10_000 }))!;
    await failJob(db, job.id, { code: "DISCOVERY_FAILED", message: "boom", retryable: false });
    await failJobItem(db, kickoff.id, "worker", kickoff.leaseVersion, {
      code: "DISCOVERY_FAILED",
      message: "boom",
      retryable: false,
    });

    const { events, last } = await terminalLast(db, job.id);
    expect(last).toMatchObject({ type: "state_changed", payload: { state: "failed" } });
    // The internal kickoff item is not a user-visible item.
    expect(events.some((event) => event.type === "item_completed")).toBe(false);
    // Progress counts pages (2 queued), never the single kickoff item.
    for (const event of events.filter((event) => event.type === "progress"))
      expect((event.payload as { progress: { total: number } }).progress.total).not.toBe(1);
  });
});
