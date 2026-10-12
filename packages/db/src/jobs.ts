import {
  canTransitionJobState,
  createJobId,
  createJobItemId,
  type JobError,
  type JobEvent,
  type JobLimits,
  type JobProgress,
  type JobResult,
  type JobState,
  type JobSubmission,
} from "@buncrawl/contracts";
import { and, eq, inArray, sql } from "drizzle-orm";

import type { Database } from "./index";
import { jobEvents, jobItems, jobs, type JobItemRecord } from "./schema";

export interface EnqueueJobInput {
  id?: string;
  submission: JobSubmission;
  limits: JobLimits;
  now?: Date;
}

export interface ClaimJobItemInput {
  workerId: string;
  leaseMs: number;
  now?: Date;
}

export interface LeasedJobItem extends JobItemRecord {
  leaseOwner: string;
  leaseExpiresAt: Date;
}

export class StaleJobLeaseError extends Error {
  readonly code = "STALE_JOB_LEASE";

  constructor(itemId: string) {
    super(`Job item lease is stale: ${itemId}`);
    this.name = "StaleJobLeaseError";
  }
}

export async function enqueueJob(db: Database, input: EnqueueJobInput) {
  const now = input.now ?? new Date();
  const id = input.id ?? createJobId();
  const requests = submissionItems(input.submission);
  const progress: JobProgress = {
    total: requests.length,
    queued: requests.length,
    running: 0,
    succeeded: 0,
    failed: 0,
    cancelled: 0,
  };

  await executeBatch(db, [
    db.insert(jobs).values({
      id,
      type: input.submission.type,
      state: "queued",
      request: input.submission,
      progress,
      limits: input.limits,
      createdAt: now,
      updatedAt: now,
    }),
    db.insert(jobItems).values(
      requests.map((request, index) => ({
        id: createJobItemId(),
        jobId: id,
        index,
        state: "queued" as const,
        request,
        createdAt: now,
        updatedAt: now,
      })),
    ),
    db.insert(jobEvents).values({
      jobId: id,
      sequence: 1,
      type: "state_changed",
      payload: { state: "queued" },
      createdAt: now,
    }),
  ]);
  const job = await getJob(db, id);
  if (!job) throw new Error("Job was not created");
  return { job, items: await getJobItems(db, id) };
}

export async function getJob(db: Database, jobId: string) {
  const [job] = await db.select().from(jobs).where(eq(jobs.id, jobId)).limit(1);
  return job;
}

export async function getJobItems(db: Database, jobId: string) {
  return db.select().from(jobItems).where(eq(jobItems.jobId, jobId)).orderBy(jobItems.index);
}

export async function getJobEvents(db: Database, jobId: string, afterSequence = 0) {
  return db
    .select()
    .from(jobEvents)
    .where(sql`${jobEvents.jobId} = ${jobId} AND ${jobEvents.sequence} > ${afterSequence}`)
    .orderBy(jobEvents.sequence);
}

export async function claimJobItem(
  db: Database,
  input: ClaimJobItemInput,
): Promise<LeasedJobItem | undefined> {
  if (!input.workerId) throw new TypeError("workerId is required");
  if (!Number.isInteger(input.leaseMs) || input.leaseMs <= 0) {
    throw new TypeError("leaseMs must be a positive integer");
  }
  const now = input.now ?? new Date();
  const leaseExpiresAt = new Date(now.getTime() + input.leaseMs);

  const [item] = await db
    .update(jobItems)
    .set({
      state: "running",
      leaseOwner: input.workerId,
      leaseExpiresAt,
      leaseVersion: sql`${jobItems.leaseVersion} + 1`,
      attempts: sql`${jobItems.attempts} + 1`,
      startedAt: sql`COALESCE(${jobItems.startedAt}, ${now.getTime()})`,
      updatedAt: now,
    })
    .where(sql`${jobItems.id} = (
      SELECT item.id
      FROM job_items AS item
      INNER JOIN jobs AS job ON job.id = item.job_id
      WHERE job.state IN ('queued', 'running')
        AND (
          item.state = 'queued'
          OR (item.state = 'running' AND item.lease_expires_at <= ${now.getTime()})
        )
      ORDER BY item.created_at, item."index"
      LIMIT 1
    )`)
    .returning();
  if (!item) return;

  await db
    .update(jobs)
    .set({
      state: "running",
      startedAt: sql`COALESCE(${jobs.startedAt}, ${now.getTime()})`,
      updatedAt: now,
    })
    .where(and(eq(jobs.id, item.jobId), eq(jobs.state, "queued")));
  await refreshJobProgress(db, item.jobId, now);
  return item as LeasedJobItem;
}

export async function heartbeatJobItem(
  db: Database,
  itemId: string,
  workerId: string,
  leaseVersion: number,
  leaseMs: number,
  now = new Date(),
): Promise<LeasedJobItem> {
  if (!Number.isInteger(leaseMs) || leaseMs <= 0) {
    throw new TypeError("leaseMs must be a positive integer");
  }
  const [item] = await db
    .update(jobItems)
    .set({ leaseExpiresAt: new Date(now.getTime() + leaseMs), updatedAt: now })
    .where(activeLease(itemId, workerId, leaseVersion))
    .returning();
  if (!item) throw new StaleJobLeaseError(itemId);
  return item as LeasedJobItem;
}

export async function completeJobItem(
  db: Database,
  itemId: string,
  workerId: string,
  leaseVersion: number,
  result: unknown,
  now = new Date(),
) {
  return finishJobItem(db, {
    itemId,
    workerId,
    leaseVersion,
    state: "completed",
    result,
    now,
  });
}

export async function failJobItem(
  db: Database,
  itemId: string,
  workerId: string,
  leaseVersion: number,
  error: JobError,
  now = new Date(),
) {
  return finishJobItem(db, {
    itemId,
    workerId,
    leaseVersion,
    state: "failed",
    error,
    now,
  });
}

export async function requestJobCancellation(db: Database, jobId: string, now = new Date()) {
  const [existing] = await db.select().from(jobs).where(eq(jobs.id, jobId)).limit(1);
  if (!existing) return;
  if (["completed", "failed", "cancelled"].includes(existing.state)) return existing;

  await db
    .update(jobItems)
    .set({ state: "cancelled", finishedAt: now, updatedAt: now })
    .where(and(eq(jobItems.jobId, jobId), eq(jobItems.state, "queued")));
  const running = await queryRows<{ count: number }>(
    db,
    sql`SELECT count(*) AS count FROM job_items WHERE job_id = ${jobId} AND state = 'running'`,
  );
  const state = Number(running[0]?.count ?? 0) > 0 ? "cancelling" : "cancelled";
  const [job] = await db
    .update(jobs)
    .set({
      state,
      cancellationRequestedAt: existing.cancellationRequestedAt ?? now,
      ...(state === "cancelled" ? { finishedAt: now } : {}),
      updatedAt: now,
    })
    .where(and(eq(jobs.id, jobId), inArray(jobs.state, ["queued", "running", "cancelling"])))
    .returning();
  await refreshJobProgress(db, jobId, now);
  if (job) await appendJobEvent(db, jobId, "state_changed", { state }, now);
  return job;
}

export async function recoverExpiredJobItems(db: Database, now = new Date()) {
  const recovered = await db
    .update(jobItems)
    .set({
      state: sql`CASE
        WHEN EXISTS (
          SELECT 1 FROM jobs WHERE jobs.id = ${jobItems.jobId} AND jobs.state = 'cancelling'
        ) THEN 'cancelled'
        ELSE 'queued'
      END`,
      leaseOwner: null,
      leaseExpiresAt: null,
      finishedAt: sql`CASE
        WHEN EXISTS (
          SELECT 1 FROM jobs WHERE jobs.id = ${jobItems.jobId} AND jobs.state = 'cancelling'
        ) THEN ${now.getTime()}
        ELSE NULL
      END`,
      updatedAt: now,
    })
    .where(sql`${jobItems.state} = 'running' AND ${jobItems.leaseExpiresAt} <= ${now.getTime()}`)
    .returning();
  for (const jobId of new Set(recovered.map((item) => item.jobId))) {
    await refreshJobProgress(db, jobId, now);
  }
  return recovered;
}

export async function setJobResult(
  db: Database,
  jobId: string,
  leaseVersion: number,
  result: JobResult,
  now = new Date(),
) {
  const [job] = await db
    .update(jobs)
    .set({ state: "completed", result, finishedAt: now, updatedAt: now })
    .where(
      sql`${jobs.id} = ${jobId} AND ${jobs.leaseVersion} = ${leaseVersion} AND ${jobs.state} NOT IN ('completed', 'failed', 'cancelled')`,
    )
    .returning();
  if (!job) throw new StaleJobLeaseError(jobId);
  await appendJobEvent(db, jobId, "state_changed", { state: "completed" }, now);
  return job;
}

export async function failJob(db: Database, jobId: string, error: JobError, now = new Date()) {
  return transitionJob(db, jobId, "failed", { error, finishedAt: now }, now);
}

async function finishJobItem(
  db: Database,
  input: {
    itemId: string;
    workerId: string;
    leaseVersion: number;
    state: "completed" | "failed";
    result?: unknown;
    error?: JobError;
    now: Date;
  },
) {
  const [item] = await db
    .update(jobItems)
    .set({
      state: input.state,
      ...(input.result === undefined ? {} : { result: input.result }),
      ...(input.error === undefined ? {} : { error: input.error }),
      finishedAt: input.now,
      updatedAt: input.now,
    })
    .where(activeLease(input.itemId, input.workerId, input.leaseVersion))
    .returning();

  if (!item) {
    const [existing] = await db
      .select()
      .from(jobItems)
      .where(eq(jobItems.id, input.itemId))
      .limit(1);
    if (
      existing?.state === input.state &&
      existing.leaseOwner === input.workerId &&
      existing.leaseVersion === input.leaseVersion
    ) {
      return existing;
    }
    throw new StaleJobLeaseError(input.itemId);
  }
  await appendJobEvent(
    db,
    item.jobId,
    "item_completed",
    { itemId: item.id, index: item.index },
    input.now,
  );
  await refreshJobProgress(db, item.jobId, input.now);
  return item;
}

async function refreshJobProgress(db: Database, jobId: string, now: Date): Promise<void> {
  const rows = await queryRows<{ state: JobItemRecord["state"]; count: number }>(
    db,
    sql`SELECT state, count(*) AS count FROM job_items WHERE job_id = ${jobId} GROUP BY state`,
  );
  const counts = new Map(rows.map((row) => [row.state, Number(row.count)]));
  const progress: JobProgress = {
    total: [...counts.values()].reduce((sum, count) => sum + count, 0),
    queued: counts.get("queued") ?? 0,
    running: counts.get("running") ?? 0,
    succeeded: counts.get("completed") ?? 0,
    failed: counts.get("failed") ?? 0,
    cancelled: counts.get("cancelled") ?? 0,
  };
  const [job] = await db.select().from(jobs).where(eq(jobs.id, jobId)).limit(1);
  if (!job) return;

  let state = job.state;
  let finishedAt = job.finishedAt;
  if (progress.queued === 0 && progress.running === 0) {
    state = job.state === "cancelling" ? "cancelled" : "completed";
    finishedAt ??= now;
  }
  await db
    .update(jobs)
    .set({ progress, state, finishedAt, updatedAt: now })
    .where(eq(jobs.id, jobId));
  await appendJobEvent(db, jobId, "progress", { progress }, now);
  if (state !== job.state) await appendJobEvent(db, jobId, "state_changed", { state }, now);
}

async function transitionJob(
  db: Database,
  jobId: string,
  state: JobState,
  values: Partial<typeof jobs.$inferInsert>,
  now: Date,
) {
  const [existing] = await db.select().from(jobs).where(eq(jobs.id, jobId)).limit(1);
  if (!existing) return;
  if (!canTransitionJobState(existing.state, state)) {
    throw new Error(`Invalid job transition: ${existing.state} -> ${state}`);
  }
  const [job] = await db
    .update(jobs)
    .set({ ...values, state, updatedAt: now })
    .where(and(eq(jobs.id, jobId), eq(jobs.state, existing.state)))
    .returning();
  if (job) await appendJobEvent(db, jobId, "state_changed", { state }, now);
  return job;
}

async function appendJobEvent(
  db: Database,
  jobId: string,
  type: JobEvent["event"],
  payload: unknown,
  now: Date,
) {
  await db.run(sql`
    INSERT INTO job_events (job_id, sequence, type, payload_json, created_at)
    SELECT ${jobId}, COALESCE(MAX(sequence), 0) + 1, ${type}, ${JSON.stringify(payload)}, ${now.getTime()}
    FROM job_events
    WHERE job_id = ${jobId}
  `);
}

function activeLease(itemId: string, workerId: string, leaseVersion: number) {
  return and(
    eq(jobItems.id, itemId),
    eq(jobItems.state, "running"),
    eq(jobItems.leaseOwner, workerId),
    eq(jobItems.leaseVersion, leaseVersion),
  );
}

function submissionItems(submission: JobSubmission): unknown[] {
  if (submission.type === "batch_scrape") return submission.requests;
  return [submission];
}

async function executeBatch(db: Database, statements: readonly unknown[]): Promise<void> {
  if (statements.length === 0) return;
  const candidate = db as unknown as {
    batch?: (statements: readonly unknown[]) => unknown;
    $client?: {
      transaction?: (action: () => void) => () => void;
    };
  };
  if (candidate.batch) {
    await candidate.batch(statements);
    return;
  }
  if (candidate.$client?.transaction) {
    const transaction = candidate.$client.transaction(() => {
      for (const statement of statements) (statement as { run(): unknown }).run();
    });
    transaction();
    return;
  }
  throw new Error("Database does not support atomic batches");
}

async function queryRows<T>(db: Database, query: unknown): Promise<T[]> {
  const all = db.all.bind(db) as unknown as (query: unknown) => T[] | Promise<T[]>;
  return all(query);
}
