import { RedisClient } from "bun";

const CHANNEL = "buncrawl:jobs:ready";

// Redis only carries identifiers and wakeups. The database remains the queue.
export class RedisJobDispatch {
  private readonly publisher: RedisClient;
  private readonly subscriber: RedisClient;

  constructor(url = process.env.REDIS_URL ?? "redis://localhost:6379") {
    const options = { connectionTimeout: 1000, enableOfflineQueue: false, maxRetries: 0 };
    this.publisher = new RedisClient(url, options);
    this.subscriber = new RedisClient(url, options);
  }

  async notify(jobId: string): Promise<void> {
    try {
      await this.publisher.publish(CHANNEL, jobId);
    } catch {
      // Polling will observe the committed job.
    }
  }

  async listen(wake: () => void): Promise<void> {
    try {
      await this.subscriber.subscribe(CHANNEL, () => wake());
    } catch {
      // Polling also recovers subscriptions after a disconnected Redis server.
    }
  }

  async active(workerId: string, count: number, leaseSeconds: number): Promise<void> {
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
    this.publisher.close();
    this.subscriber.close();
  }
}
