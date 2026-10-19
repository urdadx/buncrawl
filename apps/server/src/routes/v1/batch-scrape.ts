import { jobIdSchema, jobSubmissionSchema } from "@buncrawl/contracts";
import {
  enqueueJob,
  getJob,
  getJobItemsPage,
  JobQueueFullError,
  requestJobCancellation,
  type Database,
} from "@buncrawl/db";
import { RedisJobDispatch } from "@buncrawl/jobs";
import * as v from "valibot";

const MAX_PENDING_ITEMS = 10_000;
const MAX_RESULT_PAGE_BYTES = 1024 * 1024;
const DEFAULT_RESULT_PAGE_SIZE = 100;
const dispatch = new RedisJobDispatch();

export function createBatchScrapeHandler(
  db: Database,
  notify: (id: string) => Promise<void> = (id) => dispatch.notify(id),
) {
  return async (request: Request, id?: string): Promise<Response> => {
    if (!id) {
      if (request.method !== "POST")
        return failure(405, "METHOD_NOT_ALLOWED", "Method not allowed", { Allow: "POST, OPTIONS" });

      let body: unknown;

      try {
        body = await request.json();
      } catch {
        return failure(400, "INVALID_JSON", "Request body must be JSON");
      }

      const parsed = v.safeParse(jobSubmissionSchema, {
        ...(typeof body === "object" && body !== null ? body : {}),
        type: "batch_scrape",
      });

      if (!parsed.success || parsed.output.type !== "batch_scrape") {
        return Response.json(
          {
            code: "INVALID_REQUEST",
            error: "Invalid batch scrape request",
            details: parsed.issues?.map((issue) => issue.message),
          },
          { status: 400 },
        );
      }

      const pending = await db.all<{ count: number }>(
        "SELECT count(*) AS count FROM job_items WHERE state IN ('queued', 'running')",
      );

      if (Number(pending[0]?.count ?? 0) + parsed.output.requests.length > MAX_PENDING_ITEMS) {
        return failure(429, "QUEUE_FULL", "Batch queue is full");
      }

      let job;
      try {
        ({ job } = await enqueueJob(db, {
          submission: parsed.output,
          limits: { maxItems: parsed.output.requests.length, timeoutMs: 120_000 },
        }));
      } catch (error) {
        if (error instanceof JobQueueFullError)
          return failure(429, "QUEUE_FULL", "Batch queue is full");
        throw error;
      }

      await notify(job.id).catch(() => undefined);

      return Response.json(
        { jobId: job.id, type: job.type, state: "queued", createdAt: job.createdAt.toISOString() },
        { status: 202 },
      );
    }

    if (request.method !== "GET" && request.method !== "DELETE")
      return failure(405, "METHOD_NOT_ALLOWED", "Method not allowed", {
        Allow: "GET, DELETE, OPTIONS",
      });

    if (!v.safeParse(jobIdSchema, id).success)
      return failure(400, "INVALID_JOB_ID", "Invalid job ID");

    const job = await getJob(db, id);

    if (!job || job.type !== "batch_scrape") return failure(404, "JOB_NOT_FOUND", "Job not found");

    if (request.method === "DELETE") {
      const cancelled = await requestJobCancellation(db, id);
      return Response.json({
        jobId: id,
        state: cancelled?.state,
        requestedAt:
          cancelled?.cancellationRequestedAt?.toISOString() ??
          job.finishedAt?.toISOString() ??
          new Date().toISOString(),
      });
    }

    const url = new URL(request.url);
    const cursor = parsePageInteger(url.searchParams.get("cursor"), 0, Number.MAX_SAFE_INTEGER);
    const limit = parsePageInteger(url.searchParams.get("limit"), DEFAULT_RESULT_PAGE_SIZE, 100);
    if (cursor === undefined || limit === undefined)
      return failure(400, "INVALID_PAGINATION", "cursor and limit must be valid integers");
    const rows = await getJobItemsPage(db, id, cursor, limit);
    const items: Record<string, unknown>[] = [];
    let size = 0;
    for (const item of rows.slice(0, limit)) {
      const projected = {
        itemId: item.id,
        index: item.index,
        url: (item.request as { url: string }).url,
        state: item.state,
        ...(item.state === "completed" ? { document: item.result } : {}),
        ...(item.state === "failed" ? { error: item.error } : {}),
      };
      const bytes = Buffer.byteLength(JSON.stringify(projected));
      // A single large item is still returned so a cursor can always advance.
      if (items.length > 0 && size + bytes > MAX_RESULT_PAGE_BYTES) break;
      size += bytes;
      items.push(projected);
    }
    const nextIndex = cursor + items.length;
    const hasMore = rows.length > items.length;
    if (hasMore) {
      url.search = "";
      url.searchParams.set("cursor", String(nextIndex));
      url.searchParams.set("limit", String(limit));
    }

    return Response.json({
      jobId: job.id,
      type: job.type,
      state: job.state,
      createdAt: job.createdAt.toISOString(),
      updatedAt: job.updatedAt.toISOString(),
      ...(job.startedAt ? { startedAt: job.startedAt.toISOString() } : {}),
      ...(job.finishedAt ? { finishedAt: job.finishedAt.toISOString() } : {}),
      ...(job.cancellationRequestedAt
        ? { cancellationRequestedAt: job.cancellationRequestedAt.toISOString() }
        : {}),
      ...(job.error ? { error: job.error } : {}),
      progress: job.progress,
      limits: job.limits,
      items,
      ...(hasMore ? { next: url.href } : {}),
    });
  };
}

function parsePageInteger(
  raw: string | null,
  fallback: number,
  maximum: number,
): number | undefined {
  if (raw === null) return fallback;
  if (!/^(0|[1-9]\d*)$/.test(raw)) return;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > maximum || (maximum === 100 && value < 1)) return;
  return value;
}

function failure(status: number, code: string, error: string, headers?: Record<string, string>) {
  return Response.json({ code, error }, { status, headers });
}
