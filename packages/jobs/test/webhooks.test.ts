import { describe, expect, test } from "bun:test";
import {
  createDb,
  enqueueJob,
  getJobEvents,
  migrateDb,
  pruneJobEvents,
  requestJobCancellation,
} from "@buncrawl/db";
import { deliverWebhooks } from "../src/webhooks";

describe("webhook deliveries", () => {
  test("signs persisted events, records delivery and does not redeliver", async () => {
    const db = createDb({ DATABASE_URL: ":memory:" });
    await migrateDb(db);
    const { job } = await enqueueJob(db, {
      submission: {
        type: "batch_scrape",
        requests: [{ url: "https://example.com" }],
        webhook: { url: "https://example.com/hook", secret: "a-secret-at-least-16-characters" },
      },
      limits: { maxItems: 1, timeoutMs: 1000 },
    });
    let calls = 0;
    expect(
      await deliverWebhooks(db, async (_url, init) => {
        calls++;
        const body = String(init?.body);
        const headers = new Headers(init?.headers);
        const key = await crypto.subtle.importKey(
          "raw",
          new TextEncoder().encode("a-secret-at-least-16-characters"),
          { name: "HMAC", hash: "SHA-256" },
          false,
          ["sign"],
        );
        const digest = Buffer.from(
          await crypto.subtle.sign(
            "HMAC",
            key,
            new TextEncoder().encode(`${headers.get("x-buncrawl-timestamp")}.${body}`),
          ),
        ).toString("hex");
        expect(headers.get("x-buncrawl-signature")).toBe(`sha256=${digest}`);
        expect(JSON.parse(body)).toMatchObject({ jobId: job.id, sequence: 1, state: "queued" });
        return new Response(null, { status: 204 });
      }),
    ).toBe(true);
    expect(
      await deliverWebhooks(db, async () => {
        throw new Error("unexpected retry");
      }),
    ).toBe(false);
    expect(calls).toBe(1);
    expect(await getJobEvents(db, job.id)).toHaveLength(1);
    await pruneJobEvents(db);
  });

  test("bounds retries and records a failed delivery without changing job state", async () => {
    const db = createDb({ DATABASE_URL: ":memory:" });
    await migrateDb(db);
    const start = new Date();
    const { job } = await enqueueJob(db, {
      submission: {
        type: "batch_scrape",
        requests: [{ url: "https://example.com" }],
        webhook: { url: "https://example.com/hook", secret: "a-secret-at-least-16-characters" },
      },
      limits: { maxItems: 1, timeoutMs: 1000 },
      now: start,
    });
    for (let attempt = 0; attempt < 5; attempt++) {
      expect(
        await deliverWebhooks(
          db,
          async () => new Response(null, { status: 503 }),
          new Date(start.getTime() + attempt * 60_000),
        ),
      ).toBe(true);
    }
    const [delivery] = await db.all<{ state: string; attempts: number }>(
      "SELECT state, attempts FROM webhook_deliveries",
    );
    expect(delivery).toMatchObject({ state: "failed", attempts: 5 });
    expect(job.state).toBe("queued");
  });

  test("only enqueues subscribed event types, including cancellation state changes", async () => {
    const db = createDb({ DATABASE_URL: ":memory:" });
    await migrateDb(db);
    await migrateDb(db);
    const { job } = await enqueueJob(db, {
      submission: {
        type: "batch_scrape",
        requests: [{ url: "https://example.com" }],
        webhook: {
          url: "https://example.com/hook",
          secret: "a-secret-at-least-16-characters",
          events: ["progress"],
        },
      },
      limits: { maxItems: 1, timeoutMs: 1000 },
    });
    await requestJobCancellation(db, job.id);
    expect((await getJobEvents(db, job.id)).map((event) => [event.type, event.payload])).toEqual([
      ["state_changed", { state: "queued" }],
      [
        "progress",
        { progress: { total: 1, queued: 0, running: 0, succeeded: 0, failed: 0, cancelled: 1 } },
      ],
      ["state_changed", { state: "cancelled" }],
    ]);
    const deliveries = await db.all<{ sequence: number }>(
      "SELECT sequence FROM webhook_deliveries",
    );
    expect(deliveries.map((row) => row.sequence)).toEqual([2]);
  });
});
