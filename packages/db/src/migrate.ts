import { sql } from "drizzle-orm";

import type { Database } from "./index";

// Kept in code so standalone Bun executables do not depend on a migration directory at runtime.
export async function migrateDb(db: Database): Promise<void> {
  await db.run(sql`
    CREATE TABLE IF NOT EXISTS artifacts (
      key TEXT PRIMARY KEY NOT NULL,
      backend TEXT NOT NULL CHECK (backend IN ('filesystem', 'r2')),
      content_type TEXT NOT NULL,
      byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
      checksum TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER
    )
  `);
  await db.run(sql`CREATE INDEX IF NOT EXISTS artifacts_expires_at_idx ON artifacts (expires_at)`);
  await db.run(sql`
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('batch_scrape', 'map', 'crawl')),
      state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'completed', 'failed', 'cancelling', 'cancelled')),
      request_json TEXT NOT NULL,
      result_json TEXT,
      error_json TEXT,
      progress_json TEXT NOT NULL,
      limits_json TEXT NOT NULL,
      cancellation_requested_at INTEGER,
      lease_owner TEXT,
      lease_expires_at INTEGER,
      lease_version INTEGER NOT NULL DEFAULT 0 CHECK (lease_version >= 0),
      attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      started_at INTEGER,
      finished_at INTEGER
    )
  `);
  await db.run(
    sql`CREATE INDEX IF NOT EXISTS jobs_state_created_at_idx ON jobs (state, created_at)`,
  );
  await db.run(
    sql`CREATE INDEX IF NOT EXISTS jobs_lease_expires_at_idx ON jobs (lease_expires_at)`,
  );
  await db.run(sql`
    CREATE TABLE IF NOT EXISTS job_items (
      id TEXT PRIMARY KEY NOT NULL,
      job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      "index" INTEGER NOT NULL CHECK ("index" >= 0),
      state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
      request_json TEXT NOT NULL,
      result_json TEXT,
      error_json TEXT,
      attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      lease_owner TEXT,
      lease_expires_at INTEGER,
      lease_version INTEGER NOT NULL DEFAULT 0 CHECK (lease_version >= 0),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      started_at INTEGER,
      finished_at INTEGER
    )
  `);
  await db.run(
    sql`CREATE UNIQUE INDEX IF NOT EXISTS job_items_job_id_index_uidx ON job_items (job_id, "index")`,
  );
  await db.run(
    sql`CREATE INDEX IF NOT EXISTS job_items_claim_idx ON job_items (state, lease_expires_at, created_at)`,
  );
  await db.run(
    sql`CREATE INDEX IF NOT EXISTS job_items_job_id_state_idx ON job_items (job_id, state)`,
  );
  await db.run(sql`
    CREATE TRIGGER IF NOT EXISTS job_items_pending_limit
    BEFORE INSERT ON job_items
    WHEN NEW.state IN ('queued', 'running')
      AND (SELECT count(*) FROM job_items WHERE state IN ('queued', 'running')) >= 10000
    BEGIN
      SELECT RAISE(ABORT, 'BATCH_QUEUE_FULL');
    END
  `);
  await db.run(sql`
    CREATE TABLE IF NOT EXISTS job_events (
      job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      sequence INTEGER NOT NULL CHECK (sequence > 0),
      type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (job_id, sequence)
    )
  `);
  await db.run(
    sql`CREATE INDEX IF NOT EXISTS job_events_created_at_idx ON job_events (created_at)`,
  );
  await db.run(sql`
    CREATE TABLE IF NOT EXISTS crawl_hosts (
      job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      origin TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 0 CHECK (active >= 0),
      max_concurrency INTEGER NOT NULL DEFAULT 1 CHECK (max_concurrency > 0),
      min_delay_ms INTEGER NOT NULL DEFAULT 0 CHECK (min_delay_ms >= 0),
      next_allowed_at INTEGER NOT NULL DEFAULT 0,
      robots_fetched_at INTEGER,
      robots_body TEXT,
      PRIMARY KEY (job_id, origin)
    )
  `);
  await db.run(sql`
    CREATE TABLE IF NOT EXISTS crawl_frontier (
      job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      url TEXT NOT NULL,
      origin TEXT NOT NULL,
      depth INTEGER NOT NULL CHECK (depth >= 0),
      state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
      final_url TEXT,
      final_origin TEXT,
      document_json TEXT,
      error_json TEXT,
      byte_size INTEGER NOT NULL DEFAULT 0 CHECK (byte_size >= 0),
      reserved_bytes INTEGER NOT NULL DEFAULT 0 CHECK (reserved_bytes >= 0),
      lease_owner TEXT,
      lease_expires_at INTEGER,
      lease_version INTEGER NOT NULL DEFAULT 0,
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (job_id, url)
    )
  `);
  await db.run(
    sql`CREATE INDEX IF NOT EXISTS crawl_frontier_claim_idx ON crawl_frontier (state, created_at)`,
  );
  await db.run(
    sql`CREATE INDEX IF NOT EXISTS crawl_frontier_host_idx ON crawl_frontier (job_id, origin, state)`,
  );
  await db.run(sql`
    CREATE TRIGGER IF NOT EXISTS crawl_frontier_started AFTER UPDATE OF state ON crawl_frontier
    WHEN OLD.state != 'running' AND NEW.state = 'running'
    BEGIN
      UPDATE crawl_hosts SET active = active + 1,
        next_allowed_at = NEW.updated_at + min_delay_ms
      WHERE job_id = NEW.job_id AND origin = NEW.origin;
    END
  `);
  await db.run(sql`
    CREATE TRIGGER IF NOT EXISTS crawl_frontier_released AFTER UPDATE OF state ON crawl_frontier
    WHEN OLD.state = 'running' AND NEW.state != 'running'
    BEGIN
      UPDATE crawl_hosts SET active = active - 1
      WHERE job_id = OLD.job_id AND origin = OLD.origin;
    END
  `);
  await db.run(sql`
    CREATE TRIGGER IF NOT EXISTS crawl_redirect_dedup AFTER UPDATE OF state ON crawl_frontier
    WHEN NEW.state = 'completed' AND NEW.final_url IS NOT NULL AND NEW.final_url != NEW.url
    BEGIN
      INSERT INTO crawl_frontier (job_id, url, origin, depth, state, created_at, updated_at)
      VALUES (NEW.job_id, NEW.final_url, NEW.final_origin, NEW.depth, 'completed', NEW.updated_at, NEW.updated_at)
      ON CONFLICT(job_id, url) DO UPDATE SET state = 'completed', updated_at = NEW.updated_at
        WHERE state = 'queued';
    END
  `);
}
