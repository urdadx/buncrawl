import { describe, expect, test } from "bun:test";
import { createDb, enqueueJob, migrateDb } from "@buncrawl/db";

import { loadRobots, robotsAllows } from "../src";

async function setup() {
  const db = createDb({ DATABASE_URL: ":memory:" });
  await migrateDb(db);
  const job = async () =>
    (
      await enqueueJob(db, {
        submission: { type: "crawl", url: "https://site.example" },
        limits: { maxItems: 10, timeoutMs: 60_000 },
      })
    ).job.id;
  return { db, job };
}

function robotsServer(body = "User-agent: *\nDisallow: /secret") {
  let fetches = 0;
  let failNext = false;
  return {
    get fetches() {
      return fetches;
    },
    failOnce() {
      failNext = true;
    },
    options: {
      resolver: async () => ["93.184.216.34"],
      fetchImpl: async () => {
        fetches++;
        await Bun.sleep(10);
        if (failNext) {
          failNext = false;
          throw new Error("connection reset");
        }
        return new Response(body, { status: 200 });
      },
    },
  };
}

const origin = "https://site.example";

describe("robots.txt in-memory cache", () => {
  test("concurrent first lookups for a host share a single fetch", async () => {
    const { db, job } = await setup();
    const jobId = await job();
    const server = robotsServer();
    const files = await Promise.all(
      Array.from({ length: 5 }, () => loadRobots(db, jobId, origin, "Buncrawl", server.options)),
    );
    expect(server.fetches).toBe(1);
    expect(files.every((file) => !robotsAllows(file, `${origin}/secret`, "Buncrawl"))).toBe(true);
  });

  test("does not remember a failed load", async () => {
    const { db, job } = await setup();
    const jobId = await job();
    const server = robotsServer();
    server.failOnce();
    await expect(loadRobots(db, jobId, origin, "Buncrawl", server.options)).rejects.toThrow();
    const file = await loadRobots(db, jobId, origin, "Buncrawl", server.options);
    expect(robotsAllows(file, `${origin}/secret`, "Buncrawl")).toBe(false);
    expect(server.fetches).toBe(2);
  });

  test("fetches again once the TTL has passed", async () => {
    const { db, job } = await setup();
    const jobId = await job();
    const server = robotsServer();
    const at = (ms: number) => ({ ...server.options, now: new Date(1_000_000 + ms), ttlMs: 1_000 });
    await loadRobots(db, jobId, origin, "Buncrawl", at(0));
    await loadRobots(db, jobId, origin, "Buncrawl", at(500));
    expect(server.fetches).toBe(1);
    await loadRobots(db, jobId, origin, "Buncrawl", at(1_500));
    expect(server.fetches).toBe(2);
  });

  test("keeps rules separate per job", async () => {
    const { db, job } = await setup();
    const [first, second] = [await job(), await job()];
    const strict = robotsServer("User-agent: *\nDisallow: /");
    const open = robotsServer("User-agent: *\nAllow: /");
    const strictFile = await loadRobots(db, first, origin, "Buncrawl", strict.options);
    const openFile = await loadRobots(db, second, origin, "Buncrawl", open.options);
    expect(robotsAllows(strictFile, `${origin}/page`, "Buncrawl")).toBe(false);
    expect(robotsAllows(openFile, `${origin}/page`, "Buncrawl")).toBe(true);
  });
});
