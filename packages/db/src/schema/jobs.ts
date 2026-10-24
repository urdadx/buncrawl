import type {
  JobError,
  JobLimits,
  JobProgress,
  JobResult,
  JobState,
  JobSubmission,
  JobType,
} from "@buncrawl/contracts";
import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const jobs = sqliteTable(
  "jobs",
  {
    id: text().primaryKey(),
    type: text().$type<JobType>().notNull(),
    state: text().$type<JobState>().notNull(),
    request: text("request_json", { mode: "json" }).$type<JobSubmission>().notNull(),
    result: text("result_json", { mode: "json" }).$type<JobResult>(),
    error: text("error_json", { mode: "json" }).$type<JobError>(),
    progress: text("progress_json", { mode: "json" }).$type<JobProgress>().notNull(),
    limits: text("limits_json", { mode: "json" }).$type<JobLimits>().notNull(),
    cancellationRequestedAt: integer("cancellation_requested_at", { mode: "timestamp_ms" }),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: integer("lease_expires_at", { mode: "timestamp_ms" }),
    leaseVersion: integer("lease_version").notNull().default(0),
    attempts: integer().notNull().default(0),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
    startedAt: integer("started_at", { mode: "timestamp_ms" }),
    finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
  },
  (table) => [
    check("jobs_type_check", sql`${table.type} IN ('batch_scrape', 'map', 'crawl')`),
    check(
      "jobs_state_check",
      sql`${table.state} IN ('queued', 'running', 'completed', 'failed', 'cancelling', 'cancelled')`,
    ),
    check("jobs_lease_version_check", sql`${table.leaseVersion} >= 0`),
    check("jobs_attempts_check", sql`${table.attempts} >= 0`),
    index("jobs_state_created_at_idx").on(table.state, table.createdAt),
    index("jobs_lease_expires_at_idx").on(table.leaseExpiresAt),
  ],
);

export const jobItems = sqliteTable(
  "job_items",
  {
    id: text().primaryKey(),
    jobId: text("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    index: integer().notNull(),
    state: text().$type<"queued" | "running" | "completed" | "failed" | "cancelled">().notNull(),
    request: text("request_json", { mode: "json" }).$type<unknown>().notNull(),
    result: text("result_json", { mode: "json" }).$type<unknown>(),
    error: text("error_json", { mode: "json" }).$type<JobError>(),
    attempts: integer().notNull().default(0),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: integer("lease_expires_at", { mode: "timestamp_ms" }),
    leaseVersion: integer("lease_version").notNull().default(0),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
    startedAt: integer("started_at", { mode: "timestamp_ms" }),
    finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
  },
  (table) => [
    check("job_items_index_check", sql`${table.index} >= 0`),
    check(
      "job_items_state_check",
      sql`${table.state} IN ('queued', 'running', 'completed', 'failed', 'cancelled')`,
    ),
    check("job_items_attempts_check", sql`${table.attempts} >= 0`),
    check("job_items_lease_version_check", sql`${table.leaseVersion} >= 0`),
    uniqueIndex("job_items_job_id_index_uidx").on(table.jobId, table.index),
    index("job_items_claim_idx").on(table.state, table.leaseExpiresAt, table.createdAt),
    index("job_items_job_id_state_idx").on(table.jobId, table.state),
  ],
);

export const jobEvents = sqliteTable(
  "job_events",
  {
    jobId: text("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    sequence: integer().notNull(),
    type: text().notNull(),
    payload: text("payload_json", { mode: "json" }).$type<unknown>().notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.jobId, table.sequence] }),
    check("job_events_sequence_check", sql`${table.sequence} > 0`),
    index("job_events_created_at_idx").on(table.createdAt),
  ],
);

export const webhookDeliveries = sqliteTable(
  "webhook_deliveries",
  {
    jobId: text("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    sequence: integer().notNull(),
    attempts: integer().notNull().default(0),
    state: text().$type<"pending" | "delivered" | "failed">().notNull().default("pending"),
    nextAttemptAt: integer("next_attempt_at", { mode: "timestamp_ms" }).notNull(),
    leaseUntil: integer("lease_until", { mode: "timestamp_ms" }).notNull().default(new Date(0)),
    deliveredAt: integer("delivered_at", { mode: "timestamp_ms" }),
    lastError: text("last_error"),
  },
  (table) => [
    primaryKey({ columns: [table.jobId, table.sequence] }),
    check(
      "webhook_deliveries_state_check",
      sql`${table.state} IN ('pending', 'delivered', 'failed')`,
    ),
    index("webhook_deliveries_due_idx").on(table.state, table.nextAttemptAt),
  ],
);

export type JobRecord = typeof jobs.$inferSelect;
export type NewJobRecord = typeof jobs.$inferInsert;
export type JobItemRecord = typeof jobItems.$inferSelect;
export type NewJobItemRecord = typeof jobItems.$inferInsert;
export type JobEventRecord = typeof jobEvents.$inferSelect;
export type NewJobEventRecord = typeof jobEvents.$inferInsert;
