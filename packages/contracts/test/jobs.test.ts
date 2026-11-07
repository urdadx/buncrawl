import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import {
  canTransitionJobState,
  createJobId,
  createJobItemId,
  isTerminalJobState,
  jobCancellationResponseSchema,
  jobEventSchema,
  jobProgressSchema,
  jobResultSchema,
  jobStatusSchema,
  jobSubmissionSchema,
} from "../src/jobs";

const jobId = "job_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const itemId = "item_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const timestamp = "2026-10-12T12:00:00.000Z";
const progress = { total: 2, queued: 0, running: 0, succeeded: 1, failed: 1, cancelled: 0 };
const limits = { maxItems: 1000, timeoutMs: 120_000 };

describe("job submission contracts", () => {
  test.each([
    {
      type: "batch_scrape",
      requests: [{ url: "https://example.com", formats: ["markdown"] }],
    },
    { type: "map", url: "https://example.com", maxUrls: 500 },
    { type: "map", url: "https://example.com", maxDepth: 0, maxBytes: 1024, timeoutMs: 1000 },
    { type: "crawl", url: "https://example.com", maxPages: 100, maxDepth: 5 },
    {
      type: "crawl",
      url: "https://example.com",
      maxDepth: 0,
      scrapeOptions: { renderJs: false, formats: ["markdown"] },
    },
  ])("accepts a strict $type submission", (submission) => {
    expect(v.safeParse(jobSubmissionSchema, submission).success).toBe(true);
  });

  test.each([
    { type: "batch_scrape", requests: [] },
    { type: "map", url: "file:///etc/passwd" },
    { type: "crawl", url: "https://example.com", maxDepth: 101 },
    { type: "map", url: "https://example.com", maxBytes: 0 },
    { type: "crawl", url: "https://example.com", timeoutMs: -1 },
    { type: "map", url: "https://example.com", unknown: true },
    { type: "unsupported", url: "https://example.com" },
  ])("rejects invalid submissions", (submission) => {
    expect(v.safeParse(jobSubmissionSchema, submission).success).toBe(false);
  });
});

describe("job state contracts", () => {
  test("creates stable-format opaque IDs", () => {
    expect(createJobId()).toMatch(/^job_[0-9a-f]{32}$/);
    expect(createJobItemId()).toMatch(/^item_[0-9a-f]{32}$/);
  });

  test("defines terminal states and legal transitions", () => {
    expect(isTerminalJobState("completed")).toBe(true);
    expect(isTerminalJobState("running")).toBe(false);
    expect(canTransitionJobState("queued", "running")).toBe(true);
    expect(canTransitionJobState("running", "cancelled")).toBe(false);
    expect(canTransitionJobState("cancelling", "cancelled")).toBe(true);
    expect(canTransitionJobState("completed", "running")).toBe(false);
    expect(canTransitionJobState("failed", "failed")).toBe(true);
  });

  test("requires state-specific status fields", () => {
    const completed = {
      jobId,
      type: "batch_scrape",
      state: "completed",
      createdAt: timestamp,
      updatedAt: timestamp,
      startedAt: timestamp,
      finishedAt: timestamp,
      progress,
      limits,
    };
    expect(v.safeParse(jobStatusSchema, completed).success).toBe(true);
    expect(v.safeParse(jobStatusSchema, { ...completed, finishedAt: undefined }).success).toBe(
      false,
    );
  });

  test("rejects progress counters that do not equal the total", () => {
    expect(v.safeParse(jobProgressSchema, progress).success).toBe(true);
    expect(v.safeParse(jobProgressSchema, { ...progress, queued: 1 }).success).toBe(false);
  });
});

describe("job outputs", () => {
  test("validates typed partial-success batch results", () => {
    const result = v.safeParse(jobResultSchema, {
      jobId,
      type: "batch_scrape",
      items: [
        {
          itemId,
          index: 0,
          url: "https://example.com",
          state: "completed",
          document: {
            markdown: "# Example",
            metadata: {
              sourceURL: "https://example.com",
              finalURL: "https://example.com",
              statusCode: 200,
              renderer: "fetch",
            },
          },
        },
        {
          itemId: "item_cccccccccccccccccccccccccccccccc",
          index: 1,
          url: "https://invalid.example",
          state: "failed",
          error: { code: "FETCH_FAILED", message: "Fetch failed", retryable: true },
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  test("validates cancellation responses and ordered events", () => {
    expect(
      v.safeParse(jobCancellationResponseSchema, {
        jobId,
        state: "cancelling",
        requestedAt: timestamp,
      }).success,
    ).toBe(true);
    expect(
      v.safeParse(jobEventSchema, {
        jobId,
        sequence: 1,
        timestamp,
        event: "progress",
        progress,
      }).success,
    ).toBe(true);
    expect(
      v.safeParse(jobEventSchema, {
        jobId,
        sequence: 0,
        timestamp,
        event: "state_changed",
        state: "running",
      }).success,
    ).toBe(false);
  });

  test("validates page_completed events for discovery pages", () => {
    const page = { jobId, sequence: 3, timestamp, event: "page_completed" };
    expect(
      v.safeParse(jobEventSchema, {
        ...page,
        url: "https://example.com/a",
        depth: 1,
        state: "completed",
        finalUrl: "https://www.example.com/a",
      }).success,
    ).toBe(true);
    expect(
      v.safeParse(jobEventSchema, {
        ...page,
        url: "https://example.com/b",
        depth: 0,
        state: "failed",
        error: { code: "HTTP_ERROR", message: "Page returned HTTP 404", retryable: false },
      }).success,
    ).toBe(true);
    for (const invalid of [
      { url: "ftp://example.com/a", depth: 0, state: "completed" },
      { url: "https://example.com/a", depth: -1, state: "completed" },
      { url: "https://example.com/a", depth: 0, state: "cancelled" },
    ])
      expect(v.safeParse(jobEventSchema, { ...page, ...invalid }).success).toBe(false);
  });

  test("accepts page_completed as a webhook event filter", () => {
    const webhook = {
      url: "https://example.com/hook",
      secret: "a-secret-at-least-16-characters",
      events: ["state_changed", "progress", "item_completed", "page_completed", "error"],
    };
    expect(
      v.safeParse(jobSubmissionSchema, { type: "crawl", url: "https://example.com", webhook })
        .success,
    ).toBe(true);
  });
});
