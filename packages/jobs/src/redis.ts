import { RedisClient } from "bun";

const CHANNEL = "buncrawl:jobs:ready";

// Redis only carries identifiers and wakeups. The database remains the queue, and workers poll it,
// so Redis is optional: it shortens the wait for workers in other processes. Without a URL (no
// REDIS_URL), every method is a no-op.
export class RedisJobDispatch {
  private readonly publisher?: RedisClient;
  private readonly subscriber?: RedisClient;

  constructor(url: string | undefined = process.env.REDIS_URL || undefined) {
    if (!url) return;
    const options = { connectionTimeout: 1000, enableOfflineQueue: false, maxRetries: 0 };
    this.publisher = new RedisClient(url, options);
    this.subscriber = new RedisClient(url, options);
  }

  async notify(jobId: string): Promise<void> {
    if (!this.publisher) return;
    try {
      await this.publisher.publish(CHANNEL, jobId);
    } catch {
      // Polling will observe the committed job.
    }
  }

  async listen(wake: () => void): Promise<void> {
    if (!this.subscriber) return;
    try {
      await this.subscriber.subscribe(CHANNEL, () => wake());
    } catch {
      // Polling also recovers subscriptions after a disconnected Redis server.
    }
  }

  async active(workerId: string, count: number, leaseSeconds: number): Promise<void> {
    if (!this.publisher) return;
    try {
      await this.publisher.send("SET", [
        `buncrawl:worker:${workerId}:active`,
        String(count),
        "EX",
        String(leaseSeconds),
      ]);
    } catch {
      // Lease ownership and concurrency are enforced locally and in SQLite.
    }
  }

  close(): void {
    this.publisher?.close();
    this.subscriber?.close();
  }
}
