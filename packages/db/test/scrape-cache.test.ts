import { describe, expect, test } from "bun:test";
import { MAX_CACHE_AGE_MS, type ScrapeDocument } from "@buncrawl/contracts";

import {
  createDb,
  getCachedScrape,
  MAX_CACHED_DOCUMENT_BYTES,
  migrateDb,
  pruneScrapeCache,
  putCachedScrape,
} from "../src";

const document = (markdown: string): ScrapeDocument => ({
  markdown,
  metadata: {
    sourceURL: "https://example.com",
    finalURL: "https://example.com/",
    statusCode: 200,
    renderer: "fetch",
  },
});

async function setup() {
  const db = createDb({ DATABASE_URL: ":memory:" });
  await migrateDb(db);
  return db;
}

describe("scrape cache repository", () => {
  test("serves an entry only while it is younger than maxAge", async () => {
    const db = await setup();
    const storedAt = new Date("2026-01-01T00:00:00Z");
    await putCachedScrape(db, "k", "https://example.com", document("# Hi"), storedAt);
    const at = (ms: number) => new Date(storedAt.getTime() + ms);

    expect(await getCachedScrape(db, "k", 60_000, at(59_000))).toEqual({
      document: document("# Hi"),
      cachedAt: storedAt,
    });
    expect(await getCachedScrape(db, "k", 60_000, at(61_000))).toBeUndefined();
    expect(await getCachedScrape(db, "k", 0, at(0))).toBeUndefined();
    expect(await getCachedScrape(db, "missing", 60_000, at(0))).toBeUndefined();
  });

  test("replaces an older result for the same key", async () => {
    const db = await setup();
    await putCachedScrape(db, "k", "https://example.com", document("old"), new Date(1_000));
    await putCachedScrape(db, "k", "https://example.com", document("new"), new Date(2_000));
    const hit = await getCachedScrape(db, "k", 10_000, new Date(3_000));
    expect(hit?.document.markdown).toBe("new");
    expect(hit?.cachedAt).toEqual(new Date(2_000));
  });

  test("does not store documents larger than the size limit", async () => {
    const db = await setup();
    const huge = document("x".repeat(MAX_CACHED_DOCUMENT_BYTES + 1));
    expect(await putCachedScrape(db, "k", "https://example.com", huge)).toBe(false);
    expect(await getCachedScrape(db, "k", 60_000)).toBeUndefined();
  });

  test("prunes entries past the maximum age, then the oldest beyond the entry cap", async () => {
    const db = await setup();
    const now = new Date("2026-02-01T00:00:00Z");
    const ago = (ms: number) => new Date(now.getTime() - ms);
    await putCachedScrape(db, "expired", "u", document("e"), ago(MAX_CACHE_AGE_MS + 1));
    await putCachedScrape(db, "old", "u", document("o"), ago(3_000));
    await putCachedScrape(db, "mid", "u", document("m"), ago(2_000));
    await putCachedScrape(db, "new", "u", document("n"), ago(1_000));

    await pruneScrapeCache(db, now, 2);
    const remaining = [];
    for (const key of ["expired", "old", "mid", "new"])
      if (await getCachedScrape(db, key, MAX_CACHE_AGE_MS * 2, now)) remaining.push(key);
    expect(remaining).toEqual(["mid", "new"]);
  });
});
