import * as v from "valibot";

import { scrapeDocumentSchema, scrapeRequestSchema } from "./scrape";

const MAX_BATCH_ITEMS = 1000;
const MAX_DISCOVERED_URLS = 100_000;
const MAX_CRAWL_DEPTH = 100;
const MAX_JOB_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_CRAWL_BYTES = 1024 * 1024 * 1024;

const nonNegativeInteger = (message: string) =>
  v.pipe(v.number(), v.integer(message), v.minValue(0, message));

const positiveInteger = (maximum: number, name: string) =>
  v.pipe(
    v.number(),
    v.integer(`${name} must be an integer`),
    v.minValue(1, `${name} must be positive`),
    v.maxValue(maximum, `${name} cannot exceed ${maximum}`),
  );

const httpUrl = v.pipe(
  v.string(),
  v.nonEmpty("URL is required"),
  v.url("URL must be valid"),
  v.regex(/^https?:\/\//i, "URL must use HTTP or HTTPS"),
);

export const jobIdSchema = v.pipe(v.string(), v.regex(/^job_[0-9a-f]{32}$/, "Invalid job ID"));
export const jobItemIdSchema = v.pipe(
  v.string(),
  v.regex(/^item_[0-9a-f]{32}$/, "Invalid job item ID"),
);

export const jobTypeSchema = v.picklist(["batch_scrape", "map", "crawl"]);
export const jobStateSchema = v.picklist([
  "queued",
  "running",
  "completed",
  "failed",
  "cancelling",
  "cancelled",
]);

export const terminalJobStateSchema = v.picklist(["completed", "failed", "cancelled"]);
export const jobTimestampSchema = v.pipe(v.string(), v.isoTimestamp("Invalid job timestamp"));

export const TERMINAL_JOB_STATES = ["completed", "failed", "cancelled"] as const;
export const JOB_STATE_TRANSITIONS: Readonly<Record<JobState, readonly JobState[]>> = {
  queued: ["running", "failed", "cancelling", "cancelled"],
  running: ["completed", "failed", "cancelling"],
  cancelling: ["completed", "failed", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
};

export function createJobId(): JobId {
  return `job_${crypto.randomUUID().replaceAll("-", "")}`;
}

export function createJobItemId(): JobItemId {
  return `item_${crypto.randomUUID().replaceAll("-", "")}`;
}

export function isTerminalJobState(state: JobState): state is TerminalJobState {
  return (TERMINAL_JOB_STATES as readonly string[]).includes(state);
}

export function canTransitionJobState(from: JobState, to: JobState): boolean {
  return from === to || JOB_STATE_TRANSITIONS[from].includes(to);
}

export const jobErrorSchema = v.strictObject({
  code: v.pipe(v.string(), v.nonEmpty("Error code is required"), v.maxLength(100)),
  message: v.pipe(v.string(), v.nonEmpty("Error message is required"), v.maxLength(4000)),
  retryable: v.boolean(),
  details: v.optional(v.record(v.string(), v.unknown())),
});

export const jobProgressSchema = v.pipe(
  v.strictObject({
    total: nonNegativeInteger("Progress total must be a non-negative integer"),
    queued: nonNegativeInteger("Queued count must be a non-negative integer"),
    running: nonNegativeInteger("Running count must be a non-negative integer"),
    succeeded: nonNegativeInteger("Succeeded count must be a non-negative integer"),
    failed: nonNegativeInteger("Failed count must be a non-negative integer"),
    cancelled: nonNegativeInteger("Cancelled count must be a non-negative integer"),
  }),
  v.check(
    (progress) =>
      progress.queued +
        progress.running +
        progress.succeeded +
        progress.failed +
        progress.cancelled ===
      progress.total,
    "Progress counters must sum to total",
  ),
);

export const jobLimitsSchema = v.strictObject({
  maxItems: positiveInteger(MAX_DISCOVERED_URLS, "maxItems"),
  timeoutMs: positiveInteger(MAX_JOB_TIMEOUT_MS, "timeoutMs"),
});

const batchScrapeSubmissionSchema = v.strictObject({
  type: v.literal("batch_scrape"),
  requests: v.pipe(
    v.array(scrapeRequestSchema),
    v.minLength(1, "At least one scrape request is required"),
    v.maxLength(MAX_BATCH_ITEMS, `Batch cannot exceed ${MAX_BATCH_ITEMS} requests`),
  ),
});

const mapSubmissionSchema = v.strictObject({
  type: v.literal("map"),
  url: httpUrl,
  maxUrls: v.optional(positiveInteger(MAX_DISCOVERED_URLS, "maxUrls")),
  maxDepth: v.optional(
    v.pipe(
      nonNegativeInteger("maxDepth must be a non-negative integer"),
      v.maxValue(MAX_CRAWL_DEPTH),
    ),
  ),
  maxBytes: v.optional(positiveInteger(MAX_CRAWL_BYTES, "maxBytes")),
  timeoutMs: v.optional(positiveInteger(MAX_JOB_TIMEOUT_MS, "timeoutMs")),
  includeSubdomains: v.optional(v.boolean()),
  pathPrefix: v.optional(v.boolean()),
});

const crawlSubmissionSchema = v.strictObject({
  type: v.literal("crawl"),
  url: httpUrl,
  maxPages: v.optional(positiveInteger(MAX_DISCOVERED_URLS, "maxPages")),
  maxDepth: v.optional(
    v.pipe(
      nonNegativeInteger("maxDepth must be a non-negative integer"),
      v.maxValue(MAX_CRAWL_DEPTH),
    ),
  ),
  maxBytes: v.optional(positiveInteger(MAX_CRAWL_BYTES, "maxBytes")),
  timeoutMs: v.optional(positiveInteger(MAX_JOB_TIMEOUT_MS, "timeoutMs")),
  includeSubdomains: v.optional(v.boolean()),
  pathPrefix: v.optional(v.boolean()),
  scrapeOptions: v.optional(v.omit(scrapeRequestSchema, ["url"])),
});

export const jobSubmissionSchema = v.variant("type", [
  batchScrapeSubmissionSchema,
  mapSubmissionSchema,
  crawlSubmissionSchema,
]);

export const jobSubmissionResponseSchema = v.strictObject({
  jobId: jobIdSchema,
  type: jobTypeSchema,
  state: v.literal("queued"),
  createdAt: jobTimestampSchema,
});

const jobStatusBase = {
  jobId: jobIdSchema,
  type: jobTypeSchema,
  createdAt: jobTimestampSchema,
  updatedAt: jobTimestampSchema,
  progress: jobProgressSchema,
  limits: jobLimitsSchema,
};

export const jobStatusSchema = v.variant("state", [
  v.strictObject({ ...jobStatusBase, state: v.literal("queued") }),
  v.strictObject({ ...jobStatusBase, state: v.literal("running"), startedAt: jobTimestampSchema }),
  v.strictObject({
    ...jobStatusBase,
    state: v.literal("completed"),
    startedAt: jobTimestampSchema,
    finishedAt: jobTimestampSchema,
  }),
  v.strictObject({
    ...jobStatusBase,
    state: v.literal("failed"),
    startedAt: v.optional(jobTimestampSchema),
    finishedAt: jobTimestampSchema,
    error: jobErrorSchema,
  }),
  v.strictObject({
    ...jobStatusBase,
    state: v.literal("cancelling"),
    startedAt: v.optional(jobTimestampSchema),
    cancellationRequestedAt: jobTimestampSchema,
  }),
  v.strictObject({
    ...jobStatusBase,
    state: v.literal("cancelled"),
    startedAt: v.optional(jobTimestampSchema),
    cancellationRequestedAt: jobTimestampSchema,
    finishedAt: jobTimestampSchema,
  }),
]);

const batchItemResultSchema = v.variant("state", [
  v.strictObject({
    itemId: jobItemIdSchema,
    index: nonNegativeInteger("Item index must be a non-negative integer"),
    url: httpUrl,
    state: v.literal("completed"),
    document: scrapeDocumentSchema,
  }),
  v.strictObject({
    itemId: jobItemIdSchema,
    index: nonNegativeInteger("Item index must be a non-negative integer"),
    url: httpUrl,
    state: v.literal("failed"),
    error: jobErrorSchema,
  }),
  v.strictObject({
    itemId: jobItemIdSchema,
    index: nonNegativeInteger("Item index must be a non-negative integer"),
    url: httpUrl,
    state: v.literal("cancelled"),
  }),
]);

export const jobResultSchema = v.variant("type", [
  v.strictObject({
    jobId: jobIdSchema,
    type: v.literal("batch_scrape"),
    items: v.array(batchItemResultSchema),
  }),
  v.strictObject({
    jobId: jobIdSchema,
    type: v.literal("map"),
    urls: v.array(httpUrl),
  }),
  v.strictObject({
    jobId: jobIdSchema,
    type: v.literal("crawl"),
    documents: v.array(scrapeDocumentSchema),
  }),
]);

export const jobCancellationRequestSchema = v.strictObject({ jobId: jobIdSchema });
export const jobCancellationResponseSchema = v.strictObject({
  jobId: jobIdSchema,
  state: v.picklist(["cancelling", "cancelled"]),
  requestedAt: jobTimestampSchema,
});

const jobEventBase = {
  jobId: jobIdSchema,
  sequence: positiveInteger(Number.MAX_SAFE_INTEGER, "sequence"),
  timestamp: jobTimestampSchema,
};

export const jobEventSchema = v.variant("event", [
  v.strictObject({
    ...jobEventBase,
    event: v.literal("state_changed"),
    state: jobStateSchema,
  }),
  v.strictObject({
    ...jobEventBase,
    event: v.literal("progress"),
    progress: jobProgressSchema,
  }),
  v.strictObject({
    ...jobEventBase,
    event: v.literal("item_completed"),
    itemId: jobItemIdSchema,
    index: nonNegativeInteger("Item index must be a non-negative integer"),
  }),
  v.strictObject({
    ...jobEventBase,
    event: v.literal("error"),
    error: jobErrorSchema,
  }),
]);

export type JobId = v.InferOutput<typeof jobIdSchema>;
export type JobItemId = v.InferOutput<typeof jobItemIdSchema>;
export type JobType = v.InferOutput<typeof jobTypeSchema>;
export type JobState = v.InferOutput<typeof jobStateSchema>;
export type TerminalJobState = v.InferOutput<typeof terminalJobStateSchema>;
export type JobError = v.InferOutput<typeof jobErrorSchema>;
export type JobProgress = v.InferOutput<typeof jobProgressSchema>;
export type JobLimits = v.InferOutput<typeof jobLimitsSchema>;
export type JobSubmission = v.InferOutput<typeof jobSubmissionSchema>;
export type JobSubmissionResponse = v.InferOutput<typeof jobSubmissionResponseSchema>;
export type JobStatus = v.InferOutput<typeof jobStatusSchema>;
export type JobResult = v.InferOutput<typeof jobResultSchema>;
export type JobCancellationRequest = v.InferOutput<typeof jobCancellationRequestSchema>;
export type JobCancellationResponse = v.InferOutput<typeof jobCancellationResponseSchema>;
export type JobEvent = v.InferOutput<typeof jobEventSchema>;
