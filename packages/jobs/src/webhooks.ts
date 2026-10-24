import { getJobEvents, type Database } from "@buncrawl/db";
import { resolveSafeUrl } from "@buncrawl/security";
import { sql } from "drizzle-orm";
import { request as httpsRequest } from "node:https";

const MAX_ATTEMPTS = 5;
const LEASE_MS = 30_000;

type Delivery = { jobId: string; sequence: number; attempts: number; request: string };

export async function deliverWebhooks(
  db: Database,
  send: (url: string | URL, init: RequestInit) => Promise<Response> = fetch,
  now = new Date(),
): Promise<boolean> {
  const [row] = await db.all<Delivery>(sql`
    UPDATE webhook_deliveries SET attempts = attempts + 1, lease_until = ${now.getTime() + LEASE_MS}
    WHERE (job_id, sequence) = (
      SELECT job_id, sequence FROM webhook_deliveries
      WHERE state = 'pending' AND next_attempt_at <= ${now.getTime()} AND lease_until <= ${now.getTime()}
      ORDER BY next_attempt_at, job_id, sequence LIMIT 1
    ) RETURNING job_id AS jobId, sequence, attempts,
      (SELECT request_json FROM jobs WHERE id = job_id) AS request
  `);
  if (!row) return false;

  let error: string | undefined;
  try {
    const webhook = (JSON.parse(row.request) as { webhook: { url: string; secret: string } })
      .webhook;
    const [event] = await getJobEvents(db, row.jobId, row.sequence - 1, 1);
    if (!event || event.sequence !== row.sequence) throw new Error("Event expired");
    const { url, addresses } = await resolveSafeUrl(webhook.url, { dnsTimeoutMs: 3000 });
    if (url.protocol !== "https:") throw new Error("Webhook requires HTTPS");
    const body = JSON.stringify({
      jobId: row.jobId,
      sequence: row.sequence,
      event: event.type,
      ...(event.payload as object),
      timestamp: event.createdAt.toISOString(),
    });
    const timestamp = String(now.getTime());
    const signature = Buffer.from(
      await crypto.subtle.sign(
        "HMAC",
        await crypto.subtle.importKey(
          "raw",
          new TextEncoder().encode(webhook.secret),
          { name: "HMAC", hash: "SHA-256" },
          false,
          ["sign"],
        ),
        new TextEncoder().encode(`${timestamp}.${body}`),
      ),
    ).toString("hex");
    const init: RequestInit = {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
      headers: {
        "content-type": "application/json",
        "x-buncrawl-timestamp": timestamp,
        "x-buncrawl-signature": `sha256=${signature}`,
        "x-buncrawl-delivery": `${row.jobId}:${row.sequence}`,
      },
      body,
    };
    const response =
      send === fetch ? await sendPinned(url, addresses[0]!, init) : await send(url, init);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    await response.body?.cancel();
  } catch (cause) {
    error = cause instanceof Error ? cause.message.slice(0, 500) : "Delivery failed";
  }

  const state = error ? (row.attempts >= MAX_ATTEMPTS ? "failed" : "pending") : "delivered";
  await db.run(sql`UPDATE webhook_deliveries SET state = ${state}, last_error = ${error ?? null},
    delivered_at = ${error ? null : Date.now()}, lease_until = 0,
    next_attempt_at = ${now.getTime() + Math.min(60_000, 1000 * 2 ** (row.attempts - 1))}
    WHERE job_id = ${row.jobId} AND sequence = ${row.sequence} AND attempts = ${row.attempts}
      AND lease_until = ${now.getTime() + LEASE_MS}`);
  return true;
}

/** Pin the validated DNS answer at connection time while preserving TLS SNI and certificate checks. */
async function sendPinned(url: URL, address: string, init: RequestInit): Promise<Response> {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(
      url,
      {
        method: "POST",
        headers: init.headers as Record<string, string>,
        timeout: 10_000,
        lookup: (_hostname, _options, callback) =>
          callback(null, address, address.includes(":") ? 6 : 4),
      },
      (response) => {
        const status = response.statusCode ?? 500;
        response.destroy();
        resolve(new Response(null, { status }));
      },
    );
    request.on("timeout", () => request.destroy(new Error("Webhook timed out")));
    request.on("error", reject);
    request.end(init.body as string);
  });
}

export class WebhookWorker {
  private stopped = true;
  private loop?: Promise<void>;

  constructor(private readonly db: Database) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.loop = (async () => {
      while (!this.stopped) {
        try {
          if (await deliverWebhooks(this.db)) continue;
        } catch (error) {
          console.error("Webhook delivery failed", error);
        }
        await Bun.sleep(1000);
      }
    })();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.loop;
  }
}
