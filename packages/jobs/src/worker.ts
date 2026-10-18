import type { ScrapeDocument, ScrapeRequest, ScrapeResponse } from "@buncrawl/contracts";
import {
  cancelRunningJobItem,
  claimJobItem,
  completeJobItem,
  failJobItem,
  getJob,
  heartbeatJobItem,
  recoverExpiredJobItems,
  StaleJobLeaseError,
  type Database,
  type LeasedJobItem,
} from "@buncrawl/db";
import { scrape } from "@buncrawl/scrape";

import { RedisJobDispatch } from "./redis";

export interface WorkerOptions {
  db: Database;
  scrapeItem?: (request: ScrapeRequest, signal: AbortSignal) => Promise<ScrapeResponse>;
  persistDocument?: (document: ScrapeDocument) => Promise<ScrapeDocument>;
  dispatch?: Pick<RedisJobDispatch, "listen" | "active" | "close">;
  concurrency?: number;
  leaseMs?: number;
  pollMs?: number;
  workerId?: string;
}

export class JobWorker {
  private readonly db: Database;
  private readonly runScrape: NonNullable<WorkerOptions["scrapeItem"]>;
  private readonly persistDocument: NonNullable<WorkerOptions["persistDocument"]>;
  private readonly dispatch: NonNullable<WorkerOptions["dispatch"]>;
  private readonly concurrency: number;
  private readonly leaseMs: number;
  private readonly pollMs: number;
  private readonly workerId: string;
  private readonly controllers = new Set<AbortController>();
  private readonly slots: Promise<void>[] = [];
  private readonly waiters = new Set<() => void>();

  private stopped = false;
  private active = 0;

  /** Configure the database-backed worker, its concurrency limits, and optional Redis dispatch. */
  constructor(options: WorkerOptions) {
    this.db = options.db;
    this.runScrape = options.scrapeItem ?? ((request, signal) => scrape(request, { signal }));
    this.persistDocument = options.persistDocument ?? (async (document) => document);
    this.dispatch = options.dispatch ?? new RedisJobDispatch();
    this.concurrency = options.concurrency ?? 2;
    this.leaseMs = options.leaseMs ?? 30_000;
    this.pollMs = options.pollMs ?? 1000;
    this.workerId = options.workerId ?? crypto.randomUUID();
    if (![this.concurrency, this.leaseMs, this.pollMs].every((n) => Number.isInteger(n) && n > 0)) {
      throw new TypeError("Worker limits must be positive integers");
    }
  }

  /** Requeue expired leases, subscribe to wakeups, and start bounded claim loops. */
  async start(): Promise<void> {
    this.stopped = false;
    await recoverExpiredJobItems(this.db);
    void this.dispatch.listen(() => this.wake()).catch(() => undefined);
    for (let i = 0; i < this.concurrency; i++) this.slots.push(this.loop());
  }

  /** Abort active scrapes, wake idle loops, and wait for all slots to exit. */
  async stop(): Promise<void> {
    this.stopped = true;
    for (const controller of this.controllers) controller.abort();
    this.wake();
    await Promise.all(this.slots);
    this.slots.length = 0;
    this.dispatch.close();
  }

  /** Release every slot waiting for new work, such as after a Redis notification. */
  private wake(): void {
    for (const waiter of this.waiters) waiter();
  }

  /** Wait for a wakeup or the next database poll if notifications are unavailable. */
  private async wait(): Promise<void> {
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.waiters.delete(done);
        resolve();
      };
      const timer = setTimeout(done, this.pollMs);
      this.waiters.add(done);
    });
  }

  /** Recover and claim work repeatedly, backing off when database operations fail. */
  private async loop(): Promise<void> {
    let backoff = 1;
    while (!this.stopped) {
      try {
        await recoverExpiredJobItems(this.db);
        const item = await claimJobItem(this.db, {
          workerId: this.workerId,
          leaseMs: this.leaseMs,
          type: "batch_scrape",
        });

        if (this.stopped) break;

        if (item) {
          backoff = 1;
          await this.execute(item);
          continue;
        }
        await this.wait();
      } catch (error) {
        console.error("Job worker polling failed", error);
        await Bun.sleep(Math.min(this.pollMs * backoff, 10_000));
        backoff = Math.min(backoff * 2, 16);
      }
    }
  }

  /** Run one leased scrape with a deadline, cancellation checks, heartbeats, and durable completion. */
  private async execute(item: LeasedJobItem): Promise<void> {
    const controller = new AbortController();
    this.controllers.add(controller);
    this.active++;
    void this.dispatch.active(this.workerId, this.active, Math.ceil(this.leaseMs / 1000) + 1);

    const job = await getJob(this.db, item.jobId);
    const request = item.request as ScrapeRequest;
    const timeout = Math.min(request.timeout ?? 30_000, job?.limits.timeoutMs ?? 30_000);
    const timer = setTimeout(() => controller.abort(), timeout);

    let checking = false;

    const heartbeat = setInterval(
      () => {
        if (checking) return;
        checking = true;
        void (async () => {
          try {
            const current = await getJob(this.db, item.jobId);
            if (current?.state === "cancelling" || current?.state === "cancelled")
              controller.abort();
            else
              await heartbeatJobItem(
                this.db,
                item.id,
                this.workerId,
                item.leaseVersion,
                this.leaseMs,
              );
          } catch (error) {
            controller.abort();
            if (!(error instanceof StaleJobLeaseError))
              console.error("Job heartbeat failed", error);
          } finally {
            checking = false;
          }
        })();
      },
      Math.max(100, Math.floor(this.leaseMs / 3)),
    );

    try {
      const response = await this.runScrape(request, controller.signal);
      const current = await getJob(this.db, item.jobId);

      if (current?.state === "cancelling") {
        await cancelRunningJobItem(this.db, item.id, this.workerId, item.leaseVersion);
      } else if (this.stopped) {
        // Leave the lease for the next process rather than recording shutdown as a scrape failure.
      } else if (controller.signal.aborted) {
        await failJobItem(this.db, item.id, this.workerId, item.leaseVersion, {
          code: "DEADLINE_EXCEEDED",
          message: "Job item timed out",
          retryable: false,
        });
      } else if (response.success) {
        const document = await this.persistDocument(response.data);
        await completeJobItem(this.db, item.id, this.workerId, item.leaseVersion, document);
      } else {
        await failJobItem(this.db, item.id, this.workerId, item.leaseVersion, {
          code: response.code,
          message: response.error,
          retryable: false,
        });
      }
    } catch (error) {
      try {
        const current = await getJob(this.db, item.jobId);
        if (current?.state === "cancelling") {
          await cancelRunningJobItem(this.db, item.id, this.workerId, item.leaseVersion);
        } else if (this.stopped) {
          // Recover on restart.
        } else {
          await failJobItem(this.db, item.id, this.workerId, item.leaseVersion, {
            code: "SCRAPE_FAILED",
            message: error instanceof Error ? error.message : "Scrape failed",
            retryable: false,
          });
        }
      } catch (persistError) {
        if (!(persistError instanceof StaleJobLeaseError))
          console.error("Job result persistence failed", persistError);
      }
    } finally {
      clearTimeout(timer);
      clearInterval(heartbeat);
      this.controllers.delete(controller);
      this.active--;
      void this.dispatch.active(this.workerId, this.active, Math.ceil(this.leaseMs / 1000) + 1);
    }
  }
}
