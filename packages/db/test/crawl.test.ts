import { expect, test } from "bun:test";
import {
  claimCrawlUrl,
  createDb,
  enqueueCrawlUrl,
  enqueueJob,
  finishCrawlUrl,
  getCrawlFrontier,
  getCrawlHost,
  migrateDb,
  recoverCrawlLeases,
  scheduleCrawlHost,
} from "../src";

const limits = { maxDepth: 2, maxPages: 3, maxBytes: 100, maxElapsedMs: 60_000 };

async function setup() {
  const db = createDb({ DATABASE_URL: ":memory:" });
  await migrateDb(db);
  const { job } = await enqueueJob(db, {
    submission: { type: "map", url: "https://site.example" },
    limits: { maxItems: 3, timeoutMs: 60_000 },
  });
  return { db, id: job.id };
}

test("atomically deduplicates URLs, obeys page/byte/time budgets and host delay", async () => {
  const { db, id } = await setup();
  const first = { url: "https://site.example/a", origin: "https://site.example", depth: 0 };
  await scheduleCrawlHost(db, id, first.origin, { minDelayMs: 100, maxConcurrency: 1 });
  expect(await enqueueCrawlUrl(db, id, first, limits)).toBe(true);
  expect(
    await enqueueCrawlUrl(db, id, { ...first, url: "https://site.example/deep", depth: 3 }, limits),
  ).toBe(false);
  expect(await enqueueCrawlUrl(db, id, first, limits)).toBe(false);
  expect((await getCrawlHost(db, id, first.origin))?.minDelayMs).toBe(100);
  for (const [name, depth] of [
    ["b", 1],
    ["c", 2],
  ] as const)
    expect(
      await enqueueCrawlUrl(
        db,
        id,
        { ...first, url: `https://site.example/${name}`, depth },
        limits,
      ),
    ).toBe(true);
  expect(await enqueueCrawlUrl(db, id, { ...first, url: "https://site.example/d" }, limits)).toBe(
    false,
  );
  const now = new Date();
  const [a, other] = await Promise.all([
    claimCrawlUrl(db, id, "worker-a", 1000, limits, now),
    claimCrawlUrl(db, id, "worker-b", 1000, limits, now),
  ]);
  expect([a, other].filter(Boolean)).toHaveLength(1);
  const lease = a ?? other!;
  expect((await getCrawlHost(db, id, first.origin))?.active).toBe(1);
  expect(
    await claimCrawlUrl(db, id, "worker-c", 1000, limits, new Date(now.getTime() + 200)),
  ).toBeUndefined();
  expect(
    await finishCrawlUrl(
      db,
      lease,
      { state: "completed", byteSize: 100 },
      new Date(now.getTime() + 200),
    ),
  ).toBe(true);
  expect((await getCrawlHost(db, id, first.origin))?.active).toBe(0);
  expect(
    await enqueueCrawlUrl(
      db,
      id,
      { ...first, url: "https://site.example/e" },
      { ...limits, maxPages: 5 },
      new Date(now.getTime() + 201),
    ),
  ).toBe(false);
  expect(
    await enqueueCrawlUrl(
      db,
      id,
      { ...first, url: "https://site.example/e" },
      { ...limits, maxPages: 5, maxBytes: 200 },
      new Date(now.getTime() + 60_001),
    ),
  ).toBe(false);
});

test("recovers expired host slots, fences old workers and deduplicates redirect targets", async () => {
  const { db, id } = await setup();
  const now = new Date();
  const origin = "https://site.example";
  await enqueueCrawlUrl(db, id, { url: `${origin}/old`, origin, depth: 0 }, limits, now);
  await enqueueCrawlUrl(db, id, { url: `${origin}/new`, origin, depth: 1 }, limits, now);
  const first = (await claimCrawlUrl(db, id, "old-worker", 100, limits, now))!;
  expect(await recoverCrawlLeases(db, new Date(now.getTime() + 101))).toBe(1);
  expect((await getCrawlHost(db, id, origin))?.active).toBe(0);
  const replacement = (await claimCrawlUrl(
    db,
    id,
    "new-worker",
    1000,
    limits,
    new Date(now.getTime() + 102),
  ))!;
  expect(replacement.leaseVersion).toBe(2);
  expect(
    await finishCrawlUrl(
      db,
      first,
      { state: "completed", byteSize: 1 },
      new Date(now.getTime() + 103),
    ),
  ).toBe(false);
  expect(
    await finishCrawlUrl(
      db,
      replacement,
      { state: "completed", byteSize: 12, finalUrl: `${origin}/new` },
      new Date(now.getTime() + 104),
    ),
  ).toBe(true);
  expect((await getCrawlFrontier(db, id)).map((row) => [row.url, row.state])).toEqual([
    [`${origin}/old`, "completed"],
    [`${origin}/new`, "completed"],
  ]);
});

test("reserves the global byte budget across hosts and enforces the robots delay", async () => {
  const { db, id } = await setup();
  const now = new Date();
  const budget = { ...limits, maxBytes: 100 };
  const urls = ["https://a.example/a", "https://b.example/b"];
  for (const url of urls)
    await enqueueCrawlUrl(db, id, { url, origin: new URL(url).origin, depth: 0 }, budget, now);
  await scheduleCrawlHost(db, id, "https://a.example", { minDelayMs: 200 });
  const first = (await claimCrawlUrl(db, id, "a", 1000, budget, now))!;
  expect(first.byteBudget).toBe(100);
  expect(await claimCrawlUrl(db, id, "b", 1000, budget, now)).toBeUndefined();
  expect(
    await finishCrawlUrl(
      db,
      first,
      { state: "completed", byteSize: 20 },
      new Date(now.getTime() + 1),
    ),
  ).toBe(true);
  expect(await claimCrawlUrl(db, id, "b", 1000, budget, new Date(now.getTime() + 2))).toMatchObject(
    { url: urls[1], byteBudget: 80 },
  );
});

test("does not claim another page on a host before its delay expires", async () => {
  const { db, id } = await setup();
  const now = new Date();
  const origin = "https://site.example";
  const hostLimits = { ...limits, maxBytes: 30_000_000 };
  await scheduleCrawlHost(db, id, origin, { minDelayMs: 500, maxConcurrency: 2 });
  for (const path of ["/a", "/b"])
    await enqueueCrawlUrl(db, id, { url: `${origin}${path}`, origin, depth: 0 }, hostLimits, now);
  const first = (await claimCrawlUrl(db, id, "worker-a", 1000, hostLimits, now))!;
  expect(
    await claimCrawlUrl(db, id, "worker-b", 1000, hostLimits, new Date(now.getTime() + 499)),
  ).toBeUndefined();
  expect(
    await claimCrawlUrl(db, id, "worker-b", 1000, hostLimits, new Date(now.getTime() + 500)),
  ).toMatchObject({ url: `${origin}/b` });
  expect((await getCrawlHost(db, id, origin))?.active).toBe(2);
  expect(first.url).toBe(`${origin}/a`);
});
