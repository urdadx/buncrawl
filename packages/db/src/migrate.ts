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
}
