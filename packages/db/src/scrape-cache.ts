import { MAX_CACHE_AGE_MS, type ScrapeDocument } from "@buncrawl/contracts";
import { sql } from "drizzle-orm";

import type { Database } from "./index";
import { scrapeCache } from "./schema";

/** Larger documents (e.g. huge rawHtml) are not worth the row size; they are simply not cached. */
export const MAX_CACHED_DOCUMENT_BYTES = 5 * 1024 * 1024;
export const DEFAULT_MAX_CACHE_ENTRIES = 10_000;

export interface CachedScrape {
  document: ScrapeDocument;
  cachedAt: Date;
}

export async function getCachedScrape(
  db: Database,
  key: string,
  maxAgeMs: number,
  now = new Date(),
): Promise<CachedScrape | undefined> {
  if (maxAgeMs <= 0) return;
  const [row] = await db
    .select()
    .from(scrapeCache)
    .where(
      sql`${scrapeCache.key} = ${key} AND ${scrapeCache.createdAt} >= ${now.getTime() - maxAgeMs}`,
    )
    .limit(1);
  return row ? { document: row.document as ScrapeDocument, cachedAt: row.createdAt } : undefined;
}

/** Stores a result, replacing any older one for the same key; returns false when it is too large. */
export async function putCachedScrape(
  db: Database,
  key: string,
  url: string,
  document: ScrapeDocument,
  now = new Date(),
): Promise<boolean> {
  const json = JSON.stringify(document);
  const byteSize = Buffer.byteLength(json);
  if (byteSize > MAX_CACHED_DOCUMENT_BYTES) return false;
  await db.run(sql`INSERT OR REPLACE INTO scrape_cache (key, url, document_json, byte_size, created_at)
    VALUES (${key}, ${url}, ${json}, ${byteSize}, ${now.getTime()})`);
  return true;
}

/** Drops entries no request may still ask for, then the oldest beyond the entry cap. */
export async function pruneScrapeCache(
  db: Database,
  now = new Date(),
  maxEntries = DEFAULT_MAX_CACHE_ENTRIES,
): Promise<void> {
  await db.run(
    sql`DELETE FROM scrape_cache WHERE created_at < ${now.getTime() - MAX_CACHE_AGE_MS}`,
  );
  await db.run(sql`DELETE FROM scrape_cache WHERE key IN (
    SELECT key FROM scrape_cache ORDER BY created_at DESC LIMIT -1 OFFSET ${maxEntries})`);
}

/** Adapts the repository to the cache interface the scrape pipeline accepts. */
export function createScrapeCache(db: Database) {
  return {
    get: (key: string, maxAgeMs: number) => getCachedScrape(db, key, maxAgeMs),
    set: (key: string, url: string, document: ScrapeDocument) =>
      putCachedScrape(db, key, url, document).then(() => undefined),
  };
}
