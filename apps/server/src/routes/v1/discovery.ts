import {
  jobIdSchema,
  jobSubmissionSchema,
  type JobError,
  type ScrapeDocument,
} from "@buncrawl/contracts";
import { canonicalCrawlUrl } from "@buncrawl/crawl";
import {
  cancelQueuedCrawlUrls,
  enqueueJob,
  getCrawlFrontierPage,
  getCrawlProgress,
  getJob,
  requestJobCancellation,
  type Database,
} from "@buncrawl/db";
import { crawlJobLimits, RedisJobDispatch } from "@buncrawl/jobs";
import { validateUrl } from "@buncrawl/security";
import * as v from "valibot";

const dispatch = new RedisJobDispatch();
const MAX_RESULT_PAGE_BYTES = 1024 * 1024;
type DiscoveryType = "map" | "crawl";

export function createDiscoveryHandler(
  db: Database,
  type: DiscoveryType,
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
        type,
      });
      if (!parsed.success || parsed.output.type !== type)
        return Response.json(
          {
            code: "INVALID_REQUEST",
            error: `Invalid ${type} request`,
            details: parsed.issues?.map((issue) => issue.message),
          },
          { status: 400 },
        );
      try {
        validateUrl(parsed.output.url);
      } catch {
        return failure(400, "INVALID_URL", "URL is not allowed");
      }
      const url = canonicalCrawlUrl(parsed.output.url);
      if (!url) return failure(400, "INVALID_URL", "URL is not allowed");
      const submission = { ...parsed.output, url };
      const limits = crawlJobLimits(submission);
      const { job } = await enqueueJob(db, {
        submission,
        limits: { maxItems: limits.maxPages, timeoutMs: limits.maxElapsedMs },
      });
      await notify(job.id).catch(() => undefined);
      return Response.json(
        { jobId: job.id, type, state: "queued", createdAt: job.createdAt.toISOString() },
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
    if (!job || job.type !== type) return failure(404, "JOB_NOT_FOUND", "Job not found");
    if (request.method === "DELETE") {
      const cancelled = await requestJobCancellation(db, id);
      await cancelQueuedCrawlUrls(db, id);
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
    const limit = parsePageInteger(url.searchParams.get("limit"), 100, 100);
    if (cursor === undefined || limit === undefined)
      return failure(400, "INVALID_PAGINATION", "Invalid cursor or limit");
    const rows = await getCrawlFrontierPage(db, id, cursor, limit);
    const items: {
      url: string;
      finalUrl: string | null;
      depth: number;
      state: string;
      document?: ScrapeDocument;
      error?: JobError;
    }[] = [];
    let byteSize = 0;
    for (const row of rows.slice(0, limit)) {
      const item = {
        url: row.url,
        finalUrl: row.finalUrl,
        depth: row.depth,
        state: row.state,
        ...(row.state === "completed" && row.document ? { document: row.document } : {}),
        ...(row.state === "failed" && row.error ? { error: row.error } : {}),
      };
      const itemBytes = Buffer.byteLength(JSON.stringify(item));
      if (items.length > 0 && byteSize + itemBytes > MAX_RESULT_PAGE_BYTES) break;
      items.push(item);
      byteSize += itemBytes;
    }
    const hasMore = rows.length > items.length;
    if (hasMore) {
      url.search = "";
      url.searchParams.set("cursor", String(cursor + items.length));
      url.searchParams.set("limit", String(limit));
    }
    const currentProgress = await getCrawlProgress(db, id);
    const progress = currentProgress.total ? currentProgress : job.progress;
    return Response.json({
      jobId: id,
      type,
      state: job.state,
      createdAt: job.createdAt.toISOString(),
      updatedAt: job.updatedAt.toISOString(),
      ...(job.startedAt ? { startedAt: job.startedAt.toISOString() } : {}),
      ...(job.finishedAt ? { finishedAt: job.finishedAt.toISOString() } : {}),
      ...(job.error ? { error: job.error } : {}),
      progress,
      limits: job.limits,
      items,
      ...(type === "map"
        ? {
            urls: [
              ...new Set(
                items
                  .filter((entry) => entry.state === "completed")
                  .map((entry) => entry.finalUrl ?? entry.url),
              ),
            ],
          }
        : { documents: items.flatMap((entry) => ("document" in entry ? [entry.document] : [])) }),
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

function failure(
  status: number,
  code: string,
  error: string,
  headers?: Record<string, string>,
): Response {
  return Response.json({ code, error }, { status, headers });
}
