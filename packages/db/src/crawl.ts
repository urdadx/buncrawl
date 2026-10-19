import { sql } from "drizzle-orm";
import type { JobError, JobProgress, ScrapeDocument } from "@buncrawl/contracts";

import type { Database } from "./index";
import { crawlFrontier, crawlHosts, jobs } from "./schema";

export interface CrawlLimits {
  maxDepth: number;
  maxPages: number;
  maxBytes: number;
  maxElapsedMs: number;
}

export interface CrawlUrl {
  url: string;
  origin: string;
  depth: number;
}

export interface CrawlLease {
  jobId: string;
  url: string;
  origin: string;
  depth: number;
  leaseVersion: number;
  leaseOwner: string;
  leaseExpiresAt: Date;
  byteBudget: number;
}

export async function scheduleCrawlHost(
  db: Database,
  jobId: string,
  origin: string,
  options: { maxConcurrency?: number; minDelayMs?: number } = {},
): Promise<void> {
  const maxConcurrency = options.maxConcurrency ?? 1;
  const minDelayMs = options.minDelayMs ?? 0;
  if (
    !Number.isSafeInteger(maxConcurrency) ||
    maxConcurrency < 1 ||
    !Number.isSafeInteger(minDelayMs) ||
    minDelayMs < 0
  )
    throw new TypeError("Invalid host limits");
  await db.run(sql`INSERT INTO crawl_hosts (job_id, origin, max_concurrency, min_delay_ms)
    VALUES (${jobId}, ${origin}, ${maxConcurrency}, ${minDelayMs})
    ON CONFLICT(job_id, origin) DO NOTHING`);
  if (options.maxConcurrency !== undefined || options.minDelayMs !== undefined)
    await db.run(sql`UPDATE crawl_hosts SET
      max_concurrency = ${maxConcurrency}, min_delay_ms = max(min_delay_ms, ${minDelayMs})
      WHERE job_id = ${jobId} AND origin = ${origin}`);
}

/** Each conditional INSERT is atomic: duplicate URLs and page/byte/time limits are checked at insertion. */
export async function enqueueCrawlUrl(
  db: Database,
  jobId: string,
  entry: CrawlUrl,
  limits: CrawlLimits,
  now = new Date(),
): Promise<boolean> {
  if (
    !Number.isSafeInteger(entry.depth) ||
    entry.depth < 0 ||
    !Number.isSafeInteger(limits.maxDepth) ||
    limits.maxDepth < 0 ||
    ![limits.maxPages, limits.maxBytes, limits.maxElapsedMs].every(
      (n) => Number.isSafeInteger(n) && n > 0,
    )
  )
    throw new TypeError("Invalid crawl limits or depth");
  if (entry.depth > limits.maxDepth) return false;
  const parsed = new URL(entry.url);
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.origin !== entry.origin ||
    parsed.hash
  )
    throw new TypeError("Frontier URLs must be canonical HTTP(S) URLs matching their host");
  await scheduleCrawlHost(db, jobId, entry.origin);
  const result = await db.run(sql`
    INSERT OR IGNORE INTO crawl_frontier (job_id, url, origin, depth, state, created_at, updated_at)
    SELECT ${jobId}, ${entry.url}, ${entry.origin}, ${entry.depth}, 'queued', ${now.getTime()}, ${now.getTime()}
    WHERE EXISTS (SELECT 1 FROM jobs WHERE id = ${jobId} AND state IN ('queued', 'running')
      AND created_at + ${limits.maxElapsedMs} > ${now.getTime()})
      AND (SELECT count(*) FROM crawl_frontier WHERE job_id = ${jobId}) < ${limits.maxPages}
      AND (SELECT coalesce(sum(byte_size + reserved_bytes), 0) FROM crawl_frontier WHERE job_id = ${jobId}) < ${limits.maxBytes}
  `);
  return Number("rowsAffected" in result ? result.rowsAffected : result.changes) > 0;
}

/** One UPDATE atomically checks the host slot and delay and fences the winning lease. */
export async function claimCrawlUrl(
  db: Database,
  jobId: string,
  workerId: string,
  leaseMs: number,
  limits: CrawlLimits,
  now = new Date(),
): Promise<CrawlLease | undefined> {
  if (!workerId || !Number.isSafeInteger(leaseMs) || leaseMs < 1)
    throw new TypeError("Invalid crawl lease");
  const [row] = await db
    .update(crawlFrontier)
    .set({
      state: "running",
      leaseOwner: workerId,
      leaseExpiresAt: new Date(now.getTime() + leaseMs),
      leaseVersion: sql`${crawlFrontier.leaseVersion} + 1`,
      reservedBytes: sql`min(10485760, ${limits.maxBytes} -
      (SELECT coalesce(sum(byte_size + reserved_bytes), 0) FROM crawl_frontier WHERE job_id = ${jobId}))`,
      attempts: sql`${crawlFrontier.attempts} + 1`,
      updatedAt: now,
    })
    .where(sql`${crawlFrontier.jobId} = ${jobId} AND ${crawlFrontier.url} = (
    SELECT f.url FROM crawl_frontier f
    JOIN crawl_hosts h ON h.job_id = f.job_id AND h.origin = f.origin
    JOIN jobs j ON j.id = f.job_id
    WHERE f.job_id = ${jobId} AND f.state = 'queued' AND j.state IN ('queued', 'running')
      AND j.created_at + ${limits.maxElapsedMs} > ${now.getTime()}
      AND (SELECT count(*) FROM crawl_frontier WHERE job_id = ${jobId} AND state = 'completed') < ${limits.maxPages}
      AND (SELECT coalesce(sum(byte_size + reserved_bytes), 0) FROM crawl_frontier WHERE job_id = ${jobId}) < ${limits.maxBytes}
      AND h.active < h.max_concurrency AND h.next_allowed_at <= ${now.getTime()}
    ORDER BY f.depth, f.created_at, f.url LIMIT 1
  )`)
    .returning();
  if (!row) return;
  return {
    jobId,
    url: row.url,
    origin: row.origin,
    depth: row.depth,
    leaseVersion: row.leaseVersion,
    leaseOwner: workerId,
    leaseExpiresAt: row.leaseExpiresAt!,
    byteBudget: row.reservedBytes,
  };
}

export async function heartbeatCrawlUrl(
  db: Database,
  lease: CrawlLease,
  leaseMs: number,
  now = new Date(),
): Promise<boolean> {
  const [row] = await db
    .update(crawlFrontier)
    .set({ leaseExpiresAt: new Date(now.getTime() + leaseMs), updatedAt: now })
    .where(activeCrawlLease(lease, now))
    .returning({ url: crawlFrontier.url });
  return Boolean(row);
}

export async function finishCrawlUrl(
  db: Database,
  lease: CrawlLease,
  result: {
    state: "completed" | "failed";
    byteSize: number;
    finalUrl?: string;
    document?: ScrapeDocument;
    error?: JobError;
  },
  now = new Date(),
): Promise<boolean> {
  if (!Number.isSafeInteger(result.byteSize) || result.byteSize < 0)
    throw new TypeError("Invalid byte size");
  if (result.byteSize > lease.byteBudget)
    throw new TypeError("Page exceeds its reserved byte budget");
  const finalOrigin = result.finalUrl ? new URL(result.finalUrl).origin : null;
  if (finalOrigin && finalOrigin !== lease.origin)
    await scheduleCrawlHost(db, lease.jobId, finalOrigin);
  const [row] = await db
    .update(crawlFrontier)
    .set({
      state: result.state,
      byteSize: result.byteSize,
      finalUrl: result.finalUrl,
      finalOrigin,
      document: result.document,
      error: result.error,
      leaseOwner: null,
      leaseExpiresAt: null,
      reservedBytes: 0,
      updatedAt: now,
    })
    .where(activeCrawlLease(lease, now))
    .returning({ url: crawlFrontier.url });
  return Boolean(row);
}

export async function recoverCrawlLeases(db: Database, now = new Date()): Promise<number> {
  const rows = await db
    .update(crawlFrontier)
    .set({
      state: sql`CASE WHEN EXISTS (SELECT 1 FROM jobs WHERE id = ${crawlFrontier.jobId} AND state IN ('cancelling', 'cancelled')) THEN 'cancelled' ELSE 'queued' END`,
      leaseOwner: null,
      leaseExpiresAt: null,
      reservedBytes: 0,
      updatedAt: now,
    })
    .where(
      sql`${crawlFrontier.state} = 'running' AND ${crawlFrontier.leaseExpiresAt} <= ${now.getTime()}`,
    )
    .returning({ url: crawlFrontier.url });
  return rows.length;
}

export async function cancelRunningCrawlUrl(
  db: Database,
  lease: CrawlLease,
  now = new Date(),
): Promise<boolean> {
  const [row] = await db
    .update(crawlFrontier)
    .set({
      state: "cancelled",
      leaseOwner: null,
      leaseExpiresAt: null,
      reservedBytes: 0,
      updatedAt: now,
    })
    .where(sql`${activeCrawlLease(lease, now)} AND EXISTS (
    SELECT 1 FROM jobs WHERE id = ${lease.jobId} AND state IN ('cancelling', 'cancelled')
  )`)
    .returning({ url: crawlFrontier.url });
  return Boolean(row);
}

export async function getCrawlFrontier(db: Database, jobId: string) {
  return db
    .select()
    .from(crawlFrontier)
    .where(sql`${crawlFrontier.jobId} = ${jobId}`)
    .orderBy(crawlFrontier.depth, crawlFrontier.createdAt);
}

export async function getCrawlFrontierPage(
  db: Database,
  jobId: string,
  offset: number,
  limit: number,
) {
  return db
    .select()
    .from(crawlFrontier)
    .where(sql`${crawlFrontier.jobId} = ${jobId}`)
    .orderBy(crawlFrontier.createdAt, crawlFrontier.url)
    .limit(limit + 1)
    .offset(offset);
}

export async function getCrawlProgress(db: Database, jobId: string): Promise<JobProgress> {
  const counts = await db.all<{ state: string; count: number }>(sql`
    SELECT state, count(*) AS count FROM crawl_frontier WHERE job_id = ${jobId} GROUP BY state`);
  const byState = new Map(counts.map((row) => [row.state, Number(row.count)]));
  const progress: JobProgress = {
    total: [...byState.values()].reduce((sum, count) => sum + count, 0),
    queued: byState.get("queued") ?? 0,
    running: byState.get("running") ?? 0,
    succeeded: byState.get("completed") ?? 0,
    failed: byState.get("failed") ?? 0,
    cancelled: byState.get("cancelled") ?? 0,
  };
  return progress;
}

export async function syncCrawlProgress(db: Database, jobId: string): Promise<JobProgress> {
  const progress = await getCrawlProgress(db, jobId);
  await db
    .update(jobs)
    .set({ progress, updatedAt: new Date() })
    .where(sql`${jobs.id} = ${jobId}`);
  return progress;
}

export async function cancelQueuedCrawlUrls(db: Database, jobId: string): Promise<void> {
  await db
    .update(crawlFrontier)
    .set({ state: "cancelled", updatedAt: new Date() })
    .where(sql`${crawlFrontier.jobId} = ${jobId} AND ${crawlFrontier.state} = 'queued'`);
  await syncCrawlProgress(db, jobId);
}

export async function getCrawlHost(db: Database, jobId: string, origin: string) {
  const [host] = await db
    .select()
    .from(crawlHosts)
    .where(sql`${crawlHosts.jobId} = ${jobId} AND ${crawlHosts.origin} = ${origin}`)
    .limit(1);
  return host;
}

export async function remainingCrawlBytes(
  db: Database,
  jobId: string,
  maxBytes: number,
): Promise<number> {
  const rows = await db.all<{ used: number }>(
    sql`SELECT coalesce(sum(byte_size + reserved_bytes), 0) AS used FROM crawl_frontier WHERE job_id = ${jobId}`,
  );
  return Math.max(0, maxBytes - Number(rows[0]?.used ?? 0));
}

export async function crawlLimitsExhausted(
  db: Database,
  jobId: string,
  limits: CrawlLimits,
  now = new Date(),
): Promise<boolean> {
  const [row] = await db.all<{ pages: number; bytes: number; createdAt: number }>(sql`
    SELECT (SELECT count(*) FROM crawl_frontier WHERE job_id = ${jobId} AND state = 'completed') AS pages,
      (SELECT coalesce(sum(byte_size), 0) FROM crawl_frontier WHERE job_id = ${jobId}) AS bytes,
      created_at AS createdAt FROM jobs WHERE id = ${jobId}`);
  return (
    !row ||
    Number(row.pages) >= limits.maxPages ||
    Number(row.bytes) >= limits.maxBytes ||
    Number(row.createdAt) + limits.maxElapsedMs <= now.getTime()
  );
}

export async function saveCrawlRobots(
  db: Database,
  jobId: string,
  origin: string,
  body: string,
  crawlDelayMs: number,
  now = new Date(),
): Promise<void> {
  await db.run(sql`UPDATE crawl_hosts SET robots_body = ${body}, robots_fetched_at = ${now.getTime()},
    min_delay_ms = max(min_delay_ms, ${crawlDelayMs}),
    next_allowed_at = CASE WHEN active > 0 THEN max(next_allowed_at, ${now.getTime()} + ${crawlDelayMs}) ELSE next_allowed_at END
    WHERE job_id = ${jobId} AND origin = ${origin}`);
}

function activeCrawlLease(lease: CrawlLease, now: Date) {
  return sql`${crawlFrontier.jobId} = ${lease.jobId} AND ${crawlFrontier.url} = ${lease.url}
    AND ${crawlFrontier.state} = 'running' AND ${crawlFrontier.leaseOwner} = ${lease.leaseOwner}
    AND ${crawlFrontier.leaseVersion} = ${lease.leaseVersion}
    AND ${crawlFrontier.leaseExpiresAt} > ${now.getTime()}`;
}
