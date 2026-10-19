import { sql } from "drizzle-orm";
import { check, index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { jobs } from "./jobs";

export const crawlHosts = sqliteTable(
  "crawl_hosts",
  {
    jobId: text("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    origin: text().notNull(),
    active: integer().notNull().default(0),
    maxConcurrency: integer("max_concurrency").notNull().default(1),
    minDelayMs: integer("min_delay_ms").notNull().default(0),
    nextAllowedAt: integer("next_allowed_at").notNull().default(0),
    robotsFetchedAt: integer("robots_fetched_at", { mode: "timestamp_ms" }),
    robotsBody: text("robots_body"),
  },
  (table) => [
    primaryKey({ columns: [table.jobId, table.origin] }),
    check("crawl_hosts_active_check", sql`${table.active} >= 0`),
    check("crawl_hosts_concurrency_check", sql`${table.maxConcurrency} > 0`),
    check("crawl_hosts_delay_check", sql`${table.minDelayMs} >= 0`),
  ],
);

export const crawlFrontier = sqliteTable(
  "crawl_frontier",
  {
    jobId: text("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    url: text().notNull(),
    origin: text().notNull(),
    depth: integer().notNull(),
    state: text()
      .$type<"queued" | "running" | "completed" | "failed" | "cancelled">()
      .notNull()
      .default("queued"),
    finalUrl: text("final_url"),
    finalOrigin: text("final_origin"),
    byteSize: integer("byte_size").notNull().default(0),
    reservedBytes: integer("reserved_bytes").notNull().default(0),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: integer("lease_expires_at", { mode: "timestamp_ms" }),
    leaseVersion: integer("lease_version").notNull().default(0),
    attempts: integer().notNull().default(0),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.jobId, table.url] }),
    index("crawl_frontier_claim_idx").on(table.state, table.createdAt),
    index("crawl_frontier_host_idx").on(table.jobId, table.origin, table.state),
    check("crawl_frontier_depth_check", sql`${table.depth} >= 0`),
    check("crawl_frontier_bytes_check", sql`${table.byteSize} >= 0`),
    check("crawl_frontier_reserved_check", sql`${table.reservedBytes} >= 0`),
    check(
      "crawl_frontier_state_check",
      sql`${table.state} IN ('queued', 'running', 'completed', 'failed', 'cancelled')`,
    ),
  ],
);
