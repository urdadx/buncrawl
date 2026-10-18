import { afterEach, expect, test } from "bun:test";
import {
  createDb,
  enqueueJob,
  getJob,
  getJobItems,
  migrateDb,
  requestJobCancellation,
} from "@buncrawl/db";
import type { ScrapeResponse } from "@buncrawl/contracts";

import { JobWorker } from "../src";

const workers: JobWorker[] = [];
afterEach(async () => {
  await Promise.all(workers.splice(0).map((worker) => worker.stop()));
});

const dispatch = { listen: async () => {}, active: async () => {}, close: () => {} };

async function setup(urls: string[]) {
  const db = createDb({ DATABASE_URL: ":memory:" });
  await migrateDb(db);
  const { job } = await enqueueJob(db, {
    submission: { type: "batch_scrape", requests: urls.map((url) => ({ url })) },
    limits: { maxItems: 100, timeoutMs: 5000 },
  });
  return { db, job };
}

async function until(check: () => Promise<boolean>) {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await Bun.sleep(20);
  }
  throw new Error("Worker did not reach expected state");
}

test("processes items with bounded concurrency and persists partial success", async () => {
  const { db, job } = await setup([
    "https://one.example",
    "https://two.example",
    "https://three.example",
  ]);
  let active = 0;
  let peak = 0;
  const worker = new JobWorker({
    db,
    dispatch,
    concurrency: 2,
    pollMs: 20,
    scrapeItem: async (request) => {
      peak = Math.max(peak, ++active);
      await Bun.sleep(30);
      active--;
      return request.url.includes("two")
        ? { success: false, code: "FETCH_FAILED", error: "Unavailable" }
        : ({
            success: true,
            data: {
              metadata: {
                sourceURL: request.url,
                finalURL: request.url,
                statusCode: 200,
                contentType: "text/html",
                renderer: "fetch",
              },
            },
          } as ScrapeResponse);
    },
  });
  workers.push(worker);
  await worker.start();
  await until(async () => (await getJob(db, job.id))?.state === "completed");
  expect(peak).toBe(2);
  expect((await getJob(db, job.id))?.progress).toMatchObject({ succeeded: 2, failed: 1 });
  expect((await getJobItems(db, job.id)).map((item) => item.state)).toEqual([
    "completed",
    "failed",
    "completed",
  ]);
});

test("uses five bounded slots by default for independent batch URLs", async () => {
  const { db, job } = await setup(Array.from({ length: 7 }, (_, i) => `https://${i}.example`));
  let active = 0;
  let peak = 0;
  const worker = new JobWorker({
    db,
    dispatch,
    pollMs: 20,
    scrapeItem: async (request) => {
      peak = Math.max(peak, ++active);
      await Bun.sleep(60);
      active--;
      return {
        success: true,
        data: {
          metadata: {
            sourceURL: request.url,
            finalURL: request.url,
            statusCode: 200,
            renderer: "fetch",
          },
        },
      };
    },
  });
  workers.push(worker);
  await worker.start();
  await until(async () => (await getJob(db, job.id))?.state === "completed");
  expect(peak).toBe(5);
  expect((await getJob(db, job.id))?.progress.succeeded).toBe(7);
});

test("observes durable cancellation and aborts an active scrape", async () => {
  const { db, job } = await setup(["https://one.example", "https://two.example"]);
  let aborted = false;
  const worker = new JobWorker({
    db,
    dispatch,
    concurrency: 1,
    leaseMs: 300,
    pollMs: 20,
    scrapeItem: (_request, signal) =>
      new Promise((resolve) => {
        signal.addEventListener(
          "abort",
          () => {
            aborted = true;
            resolve({ success: false, code: "REQUEST_CANCELLED", error: "Cancelled" });
          },
          { once: true },
        );
      }),
  });
  workers.push(worker);
  await worker.start();
  await until(async () => (await getJob(db, job.id))?.progress.running === 1);
  await requestJobCancellation(db, job.id);
  await until(async () => (await getJob(db, job.id))?.state === "cancelled");
  expect(aborted).toBe(true);
  expect((await getJobItems(db, job.id)).map((item) => item.state)).toEqual([
    "cancelled",
    "cancelled",
  ]);
});

test("recovers expired work left by a previous process", async () => {
  const { db, job } = await setup(["https://one.example"]);
  const { claimJobItem } = await import("@buncrawl/db");
  await claimJobItem(db, {
    workerId: "dead-process",
    leaseMs: 100,
    now: new Date(Date.now() - 1000),
  });
  const worker = new JobWorker({
    db,
    dispatch,
    pollMs: 20,
    scrapeItem: async (request) => ({
      success: true,
      data: {
        metadata: {
          sourceURL: request.url,
          finalURL: request.url,
          statusCode: 200,
          contentType: "text/html",
          renderer: "fetch",
        },
      },
    }),
  });
  workers.push(worker);
  await worker.start();
  await until(async () => (await getJob(db, job.id))?.state === "completed");
  expect((await getJobItems(db, job.id))[0]?.attempts).toBe(2);
});
