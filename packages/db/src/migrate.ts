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
}
