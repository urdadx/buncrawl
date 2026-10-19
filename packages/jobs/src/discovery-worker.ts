import type {
  JobError,
  JobSubmission,
  ScrapeDocument,
  ScrapeRequest,
  ScrapeResponse,
} from "@buncrawl/contracts";
import { Deadline } from "@buncrawl/core";
import {
  canonicalCrawlUrl,
  discoverSitemapUrls,
  fetchCrawlPage,
  loadRobots,
  queueDiscoveredLinks,
  robotsAllows,
  withinCrawlScope,
  type CrawlScope,
} from "@buncrawl/crawl";
import {
  cancelQueuedCrawlUrls,
  cancelRunningCrawlUrl,
  cancelRunningJobItem,
  claimCrawlUrl,
  claimJobItem,
  completeJobItem,
  crawlLimitsExhausted,
  enqueueCrawlUrl,
  failJob,
  failJobItem,
  finishCrawlUrl,
  getJob,
  heartbeatCrawlUrl,
  heartbeatJobItem,
  recoverCrawlLeases,
  recoverExpiredJobItems,
  scheduleCrawlHost,
  StaleJobLeaseError,
  syncCrawlProgress,
  type CrawlLease,
  type CrawlLimits,
  type Database,
  type LeasedJobItem,
} from "@buncrawl/db";
import { FetchError, type FetchPageOptions, type FetchPageResult } from "@buncrawl/fetcher";
import { scrape } from "@buncrawl/scrape";
import { UrlSafetyError } from "@buncrawl/security";

import { RedisJobDispatch } from "./redis";

type DiscoverySubmission = Extract<JobSubmission, { type: "map" | "crawl" }>;

class ScrapeFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function pageError(error: unknown, signal: AbortSignal): JobError {
  const message = error instanceof Error ? error.message : "Page failed";
  let code = "CRAWL_PAGE_FAILED";
  if (signal.aborted) code = "DEADLINE_EXCEEDED";
  else if (
    error instanceof FetchError ||
    error instanceof UrlSafetyError ||
    error instanceof ScrapeFailure
  )
    code = error.code;
  else if (message === "Blocked by robots.txt") code = "ROBOTS_BLOCKED";
  else if (message.includes("outside crawl scope")) code = "OUT_OF_SCOPE";
  else if (/^Page returned HTTP \d+$/.test(message)) code = "HTTP_ERROR";
  return { code, message, retryable: false };
}

export function crawlJobLimits(request: DiscoverySubmission): CrawlLimits {
  return {
    maxDepth: request.maxDepth ?? 2,
    maxPages: request.type === "map" ? (request.maxUrls ?? 100) : (request.maxPages ?? 100),
    maxBytes: request.maxBytes ?? 50 * 1024 * 1024,
    maxElapsedMs: request.timeoutMs ?? 120_000,
  };
}

export interface DiscoveryWorkerOptions {
  db: Database;
  persistDocument?: (document: ScrapeDocument) => Promise<ScrapeDocument>;
  scrapeItem?: (
    request: ScrapeRequest,
    signal: AbortSignal,
    fetched: FetchPageResult,
  ) => Promise<ScrapeResponse>;
  fetchImpl?: FetchPageOptions["fetchImpl"];
  resolver?: FetchPageOptions["resolver"];
  dispatch?: Pick<RedisJobDispatch, "listen" | "close">;
  pageConcurrency?: number;
  leaseMs?: number;
  pollMs?: number;
  workerId?: string;
}

export class DiscoveryWorker {
  private readonly options: DiscoveryWorkerOptions;
  private readonly dispatch: NonNullable<DiscoveryWorkerOptions["dispatch"]>;
  private readonly workerId: string;
  private readonly pageConcurrency: number;
  private readonly leaseMs: number;
  private readonly pollMs: number;
  private readonly active = new Set<AbortController>();
  private readonly wakeups = new Set<() => void>();
  private loopPromise?: Promise<void>;
  private recoveryTimer?: ReturnType<typeof setInterval>;
  private stopped = true;

  constructor(options: DiscoveryWorkerOptions) {
    this.options = options;
    this.dispatch = options.dispatch ?? new RedisJobDispatch();
    this.workerId = options.workerId ?? crypto.randomUUID();
    this.pageConcurrency = options.pageConcurrency ?? 2;
    this.leaseMs = options.leaseMs ?? 30_000;
    this.pollMs = options.pollMs ?? 250;
    if (
      ![this.pageConcurrency, this.leaseMs, this.pollMs].every((n) => Number.isInteger(n) && n > 0)
    )
      throw new TypeError("Worker limits must be positive integers");
  }

  async start(): Promise<void> {
    if (!this.stopped) return;
    this.stopped = false;
    await recoverExpiredJobItems(this.options.db);
    await recoverCrawlLeases(this.options.db);
    this.recoveryTimer = setInterval(
      () => {
        if (this.stopped) return;
        void Promise.all([
          recoverExpiredJobItems(this.options.db),
          recoverCrawlLeases(this.options.db),
        ]).catch((error) => console.error("Discovery recovery failed", error));
      },
      Math.max(1000, this.leaseMs),
    );
    void this.dispatch.listen(() => this.wake()).catch(() => undefined);
    this.loopPromise = this.loop();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.recoveryTimer) clearInterval(this.recoveryTimer);
    for (const controller of this.active) controller.abort();
    this.wake();
    await this.loopPromise;
    this.dispatch.close();
  }

  private wake(): void {
    for (const resolve of this.wakeups) resolve();
  }

  private async wait(): Promise<void> {
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.wakeups.delete(done);
        resolve();
      };
      const timer = setTimeout(done, this.pollMs);
      this.wakeups.add(done);
    });
  }

  private async loop(): Promise<void> {
    let backoff = 1;
    while (!this.stopped) {
      try {
        const item =
          (await claimJobItem(this.options.db, {
            workerId: this.workerId,
            leaseMs: this.leaseMs,
            type: "map",
          })) ??
          (await claimJobItem(this.options.db, {
            workerId: this.workerId,
            leaseMs: this.leaseMs,
            type: "crawl",
          }));
        if (this.stopped) break;
        if (!item) {
          await this.wait();
          continue;
        }
        backoff = 1;
        await this.execute(item);
      } catch (error) {
        console.error("Discovery worker failed", error);
        await Bun.sleep(Math.min(this.pollMs * backoff, 10_000));
        backoff = Math.min(backoff * 2, 16);
      }
    }
  }

  private async execute(item: LeasedJobItem): Promise<void> {
    const job = await getJob(this.options.db, item.jobId);
    if (!job || (job.type !== "map" && job.type !== "crawl")) return;
    const request = job.request as DiscoverySubmission;
    const limits = crawlJobLimits(request);
    const scope: CrawlScope = {
      url: request.url,
      includeSubdomains: request.includeSubdomains ?? false,
      pathPrefix: request.pathPrefix ?? request.type === "crawl",
    };
    const controller = new AbortController();
    this.active.add(controller);
    const remaining = Math.max(1, limits.maxElapsedMs - (Date.now() - job.createdAt.getTime()));
    const timer = setTimeout(() => controller.abort(), remaining);
    let heartbeatBusy = false;
    let lostLease = false;
    const heartbeat = setInterval(
      () => {
        if (heartbeatBusy) return;
        heartbeatBusy = true;
        void (async () => {
          try {
            const current = await getJob(this.options.db, item.jobId);
            if (!current || current.state === "cancelling" || current.state === "cancelled")
              controller.abort();
            else if (!this.stopped)
              await heartbeatJobItem(
                this.options.db,
                item.id,
                this.workerId,
                item.leaseVersion,
                this.leaseMs,
              );
          } catch (error) {
            if (error instanceof StaleJobLeaseError) lostLease = true;
            controller.abort();
            if (!(error instanceof StaleJobLeaseError))
              console.error("Discovery heartbeat failed", error);
          } finally {
            heartbeatBusy = false;
          }
        })();
      },
      Math.min(500, Math.max(100, Math.floor(this.leaseMs / 3))),
    );

    try {
      const root = canonicalCrawlUrl(request.url);
      if (!root) throw new Error("Invalid crawl URL");
      await scheduleCrawlHost(this.options.db, item.jobId, new URL(root).origin);
      await enqueueCrawlUrl(
        this.options.db,
        item.jobId,
        { url: root, origin: new URL(root).origin, depth: 0 },
        limits,
      );
      await syncCrawlProgress(this.options.db, item.jobId);
      const deadline = new Deadline(Math.min(remaining, 15_000), controller.signal);
      const userAgent = "Buncrawl";
      const fetchOptions = {
        deadline,
        fetchImpl: this.options.fetchImpl,
        resolver: this.options.resolver,
      };
      const robots = await loadRobots(
        this.options.db,
        item.jobId,
        new URL(root).origin,
        userAgent,
        fetchOptions,
      );
      const sitemapSeeds = robots.sitemaps.length
        ? robots.sitemaps
        : [new URL("/sitemap.xml", root).href];
      const sitemapUrls = await discoverSitemapUrls(sitemapSeeds, scope, {
        ...fetchOptions,
        maxUrls: limits.maxPages,
        maxSitemaps: 20,
      });
      for (const url of sitemapUrls) {
        if (controller.signal.aborted || this.stopped) break;
        const origin = new URL(url).origin;
        const rules =
          origin === new URL(root).origin
            ? robots
            : await loadRobots(this.options.db, item.jobId, origin, userAgent, fetchOptions);
        if (robotsAllows(rules, url, userAgent))
          await enqueueCrawlUrl(this.options.db, item.jobId, { url, origin, depth: 0 }, limits);
      }
      await syncCrawlProgress(this.options.db, item.jobId);
      await Promise.all(
        Array.from({ length: this.pageConcurrency }, () =>
          this.processPages(item.jobId, request, scope, limits, userAgent, controller),
        ),
      );
      const current = await getJob(this.options.db, item.jobId);
      if (lostLease) {
        // A newer process owns the kickoff item; it will finish the frontier.
      } else if (current?.state === "cancelling" || current?.state === "cancelled") {
        await cancelQueuedCrawlUrls(this.options.db, item.jobId);
        if (current.state === "cancelling")
          await cancelRunningJobItem(this.options.db, item.id, this.workerId, item.leaseVersion);
      } else if (!this.stopped && controller.signal.aborted) {
        await cancelQueuedCrawlUrls(this.options.db, item.jobId);
        const failure: JobError = {
          code: "DEADLINE_EXCEEDED",
          message: "Job time limit exceeded",
          retryable: false,
        };
        await failJob(this.options.db, item.jobId, failure);
        await failJobItem(this.options.db, item.id, this.workerId, item.leaseVersion, failure);
        await syncCrawlProgress(this.options.db, item.jobId);
      } else if (!this.stopped) {
        await completeJobItem(this.options.db, item.id, this.workerId, item.leaseVersion, {
          finished: true,
        });
        await syncCrawlProgress(this.options.db, item.jobId);
      }
    } catch (error) {
      const current = await getJob(this.options.db, item.jobId);
      if (lostLease || error instanceof StaleJobLeaseError) {
        // A stale attempt cannot mutate the job's terminal state.
      } else if (current?.state === "cancelling" || current?.state === "cancelled") {
        await cancelQueuedCrawlUrls(this.options.db, item.jobId);
        if (current.state === "cancelling")
          await cancelRunningJobItem(this.options.db, item.id, this.workerId, item.leaseVersion);
      } else if (!this.stopped && !controller.signal.aborted) {
        await cancelQueuedCrawlUrls(this.options.db, item.jobId);
        const failure: JobError = {
          code: "DISCOVERY_FAILED",
          message: error instanceof Error ? error.message : "Discovery failed",
          retryable: false,
        };
        await failJob(this.options.db, item.jobId, failure);
        await failJobItem(this.options.db, item.id, this.workerId, item.leaseVersion, failure);
        await syncCrawlProgress(this.options.db, item.jobId);
      } else if (!this.stopped && controller.signal.aborted) {
        await cancelQueuedCrawlUrls(this.options.db, item.jobId);
        const failure: JobError = {
          code: "DEADLINE_EXCEEDED",
          message: "Job time limit exceeded",
          retryable: false,
        };
        await failJob(this.options.db, item.jobId, failure);
        await failJobItem(this.options.db, item.id, this.workerId, item.leaseVersion, failure);
        await syncCrawlProgress(this.options.db, item.jobId);
      }
    } finally {
      clearTimeout(timer);
      clearInterval(heartbeat);
      this.active.delete(controller);
    }
  }

  private async processPages(
    jobId: string,
    request: DiscoverySubmission,
    scope: CrawlScope,
    limits: CrawlLimits,
    userAgent: string,
    controller: AbortController,
  ): Promise<void> {
    while (!this.stopped && !controller.signal.aborted) {
      const lease = await claimCrawlUrl(
        this.options.db,
        jobId,
        this.workerId,
        this.leaseMs,
        limits,
      );
      if (!lease) {
        const progress = await syncCrawlProgress(this.options.db, jobId);
        if (progress.queued === 0 && progress.running === 0) return;
        if (await crawlLimitsExhausted(this.options.db, jobId, limits)) {
          await cancelQueuedCrawlUrls(this.options.db, jobId);
          return;
        }
        await Bun.sleep(this.pollMs);
        continue;
      }
      await this.processPage(jobId, request, scope, limits, userAgent, lease, controller);
    }
  }

  private async processPage(
    jobId: string,
    request: DiscoverySubmission,
    scope: CrawlScope,
    limits: CrawlLimits,
    userAgent: string,
    lease: CrawlLease,
    controller: AbortController,
  ): Promise<void> {
    const deadline = new Deadline(
      Math.min(
        30_000,
        Math.max(
          1,
          limits.maxElapsedMs -
            (Date.now() - (await getJob(this.options.db, jobId))!.createdAt.getTime()),
        ),
      ),
      controller.signal,
    );
    const beat = setInterval(
      () => {
        void heartbeatCrawlUrl(this.options.db, lease, this.leaseMs)
          .then((valid) => {
            if (!valid) controller.abort();
          })
          .catch(() => controller.abort());
      },
      Math.max(100, Math.floor(this.leaseMs / 3)),
    );
    try {
      const page = await fetchCrawlPage(this.options.db, jobId, lease.url, {
        deadline,
        scope,
        limits,
        depth: lease.depth,
        userAgent,
        byteBudget: lease.byteBudget,
        fetchImpl: this.options.fetchImpl,
        resolver: this.options.resolver,
      });
      if (page.statusCode >= 400) throw new Error(`Page returned HTTP ${page.statusCode}`);
      if (request.type === "crawl") {
        const options = request.scrapeOptions;
        const scrapeRequest: ScrapeRequest = {
          ...options,
          url: lease.url,
          timeout: Math.max(
            1,
            Math.min(options?.timeout ?? 30_000, Math.ceil(deadline.remainingMs)),
          ),
        };
        const response = this.options.scrapeItem
          ? await this.options.scrapeItem(scrapeRequest, deadline.signal, page.fetched)
          : await scrape(
              scrapeRequest,
              { signal: deadline.signal },
              { fetch: async () => page.fetched },
            );
        if (!response.success) throw new ScrapeFailure(response.code, response.error);
        if (!withinCrawlScope(response.data.metadata.finalURL, scope))
          throw new Error("Rendered page left crawl scope");
        const document = this.options.persistDocument
          ? await this.options.persistDocument(response.data)
          : response.data;
        await queueDiscoveredLinks(this.options.db, jobId, page.links, page.finalUrl, lease.depth, {
          scope,
          limits,
          userAgent,
          deadline,
          fetchImpl: this.options.fetchImpl,
          resolver: this.options.resolver,
        });
        if (
          !(await finishCrawlUrl(this.options.db, lease, {
            state: "completed",
            byteSize: page.byteSize,
            finalUrl: page.finalUrl,
            document,
          }))
        )
          throw new StaleJobLeaseError(lease.url);
      } else {
        await queueDiscoveredLinks(this.options.db, jobId, page.links, page.finalUrl, lease.depth, {
          scope,
          limits,
          userAgent,
          deadline,
          fetchImpl: this.options.fetchImpl,
          resolver: this.options.resolver,
        });
        if (
          !(await finishCrawlUrl(this.options.db, lease, {
            state: "completed",
            byteSize: page.byteSize,
            finalUrl: page.finalUrl,
          }))
        )
          throw new StaleJobLeaseError(lease.url);
      }
    } catch (error) {
      if (error instanceof StaleJobLeaseError) throw error;
      const job = await getJob(this.options.db, jobId);
      if (job?.state === "cancelling" || job?.state === "cancelled") {
        await cancelRunningCrawlUrl(this.options.db, lease);
      } else if (!this.stopped) {
        const failure = pageError(error, deadline.signal);
        await finishCrawlUrl(this.options.db, lease, {
          state: "failed",
          byteSize: 0,
          error: failure,
        });
      }
    } finally {
      clearInterval(beat);
      await syncCrawlProgress(this.options.db, jobId);
    }
  }
}
