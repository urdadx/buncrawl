import { describe, expect, test } from "bun:test";
import { createDb } from "@buncrawl/db";
import type { Database as SqliteDatabase } from "bun:sqlite";

import { closeReplacedDb, replaceRuntime, type ServerRuntime } from "../src/runtime";

function fakeRuntime(name: string, log: string[], db = createDb({ DATABASE_URL: ":memory:" })) {
  return {
    db,
    async stop() {
      log.push(`stop ${name}`);
      await Bun.sleep(5);
      log.push(`stopped ${name}`);
    },
  } satisfies ServerRuntime;
}

describe("hot reload runtime handoff", () => {
  test("stops the previous runtime before starting its replacement", async () => {
    const holder = {};
    const log: string[] = [];
    const first = await replaceRuntime(async (previous) => {
      log.push(`start a (previous: ${previous ? "yes" : "none"})`);
      return fakeRuntime("a", log);
    }, holder);
    await replaceRuntime(async (previous) => {
      expect(previous).toBe(first);
      log.push("start b");
      return fakeRuntime("b", log);
    }, holder);
    expect(log).toEqual(["start a (previous: none)", "stop a", "stopped a", "start b"]);
  });

  test("serializes rapid reloads so no runtime is left running", async () => {
    const holder = {};
    const log: string[] = [];
    const running = new Set<string>();
    const start = (name: string) => async () => {
      running.add(name);
      log.push(`start ${name}`);
      await Bun.sleep(5);
      return {
        ...fakeRuntime(name, log),
        async stop() {
          running.delete(name);
          log.push(`stop ${name}`);
        },
      };
    };
    // Three saves in quick succession, before any start has finished.
    await Promise.all([
      replaceRuntime(start("a"), holder),
      replaceRuntime(start("b"), holder),
      replaceRuntime(start("c"), holder),
    ]);
    expect([...running]).toEqual(["c"]);
    expect(log).toEqual(["start a", "stop a", "start b", "stop b", "start c"]);
  });

  test("still starts when the previous runtime fails to stop or start", async () => {
    const holder = {};
    await replaceRuntime(async () => {
      throw new Error("startup failed");
    }, holder).catch(() => undefined);
    const recovered = await replaceRuntime(
      async () => fakeRuntime("after-failed-start", []),
      holder,
    );
    await replaceRuntime(
      async () => ({
        ...recovered,
        stop: async () => {
          throw new Error("stop failed");
        },
      }),
      holder,
    );
    const started = await replaceRuntime(async () => fakeRuntime("after-failed-stop", []), holder);
    expect(started.db).toBeDefined();
  });

  test("closes the replaced database client only when a new one took its place", () => {
    const ping = (db: ReturnType<typeof createDb>) =>
      (db.$client as SqliteDatabase).query("SELECT 1").get();
    const shared = createDb({ DATABASE_URL: ":memory:" });
    closeReplacedDb(fakeRuntime("same", [], shared), shared);
    expect(() => ping(shared)).not.toThrow();

    const old = createDb({ DATABASE_URL: ":memory:" });
    closeReplacedDb(fakeRuntime("old", [], old), createDb({ DATABASE_URL: ":memory:" }));
    expect(() => ping(old)).toThrow();
  });
});
