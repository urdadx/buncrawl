import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const port = Number(Bun.env.TESTER_PORT ?? 4100);
const target = new URL(Bun.env.BUNCRAWL_URL ?? "http://localhost:3000");
const secret = Bun.env.TESTER_WEBHOOK_SECRET ?? randomBytes(32).toString("hex");
const jobIdPattern = /^job_[0-9a-f]{32}$/;
const routes = { batch_scrape: "batch/scrape", map: "map", crawl: "crawl" } as const;
const webhookEvents = ["state_changed", "progress", "item_completed", "error"] as const;
const receiverModes = ["accept", "error", "timeout"] as const;
/** Longer than Buncrawl's 10s delivery timeout, so "timeout" mode forces a retry. */
const timeoutDelayMs = 11_000;
type JobType = keyof typeof routes;
type ReceiverMode = (typeof receiverModes)[number];
type Delivery = {
  id: string;
  receivedAt: string;
  valid: boolean;
  reason?: string;
  event?: unknown;
  timestamp: string | null;
  signature: string | null;
  status: number;
  mode: ReceiverMode;
  simulated: boolean;
};
const deliveries: Delivery[] = [];
let receiverMode: ReceiverMode = "accept";
let simulations = 0;

/** Returns why a delivery fails verification, or undefined when it is authentic and fresh. */
export function webhookError(
  body: string,
  timestamp: string | null,
  signature: string | null,
  now = Date.now(),
): string | undefined {
  if (!timestamp) return "Missing x-buncrawl-timestamp header";
  if (!/^(0|[1-9]\d*)$/.test(timestamp)) return "Malformed timestamp";
  if (Math.abs(now - Number(timestamp)) > 300_000) return "Timestamp outside the 5-minute window";
  if (!signature) return "Missing x-buncrawl-signature header";
  if (!/^sha256=[a-f0-9]{64}$/.test(signature)) return "Malformed signature";
  const expected = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest();
  if (!timingSafeEqual(expected, Buffer.from(signature.slice(7), "hex")))
    return "Signature mismatch";
}

export function verifyWebhook(
  body: string,
  timestamp: string | null,
  signature: string | null,
  now = Date.now(),
): boolean {
  return webhookError(body, timestamp, signature, now) === undefined;
}

function error(status: number, message: string): Response {
  return Response.json({ error: message }, { status });
}

async function readJson<T>(request: Request): Promise<T | undefined> {
  try {
    return (await request.json()) as T;
  } catch {
    return undefined;
  }
}

async function receiveWebhook(request: Request, simulated = false): Promise<Response> {
  // Marks responses so the tunnel check can tell this tester apart from another server.
  const headers = { "x-job-events-tester": "1" };
  if (request.method !== "POST")
    return Response.json({ error: "POST required" }, { status: 405, headers });
  if (Number(request.headers.get("content-length")) > 1024 * 1024)
    return error(413, "Payload too large");
  const body = await request.text();
  if (Buffer.byteLength(body) > 1024 * 1024) return error(413, "Payload too large");
  const timestamp = request.headers.get("x-buncrawl-timestamp");
  const signature = request.headers.get("x-buncrawl-signature");
  const reason = webhookError(body, timestamp, signature);
  const mode = simulated ? "accept" : receiverMode;
  const status = reason ? 401 : mode === "error" ? 500 : 200;
  let event: unknown;
  try {
    event = JSON.parse(body);
  } catch {
    /* keep malformed bodies visible */
  }
  deliveries.unshift({
    id: request.headers.get("x-buncrawl-delivery") ?? "missing",
    receivedAt: new Date().toISOString(),
    valid: !reason,
    timestamp,
    signature,
    status,
    mode,
    simulated,
    ...(reason && { reason }),
    ...(event === undefined ? { reason: reason ?? "Invalid JSON" } : { event }),
  });
  deliveries.length = Math.min(deliveries.length, 200);
  if (reason) return Response.json({ error: reason }, { status, headers });
  if (mode === "timeout") await Bun.sleep(timeoutDelayMs);
  if (mode === "error")
    return Response.json({ error: "Simulated receiver failure" }, { status, headers });
  return Response.json({ received: true }, { headers });
}

/** Signs a sample event exactly like Buncrawl does, optionally corrupted, and feeds it to the receiver. */
async function simulateDelivery(input: { jobId?: string; kind?: string }): Promise<Response> {
  const kinds = ["valid", "bad_signature", "expired"];
  if (!kinds.includes(input.kind ?? "")) return error(400, "Invalid simulation kind");
  const jobId = jobIdPattern.test(input.jobId ?? "") ? input.jobId! : `job_${"0".repeat(32)}`;
  const sequence = ++simulations;
  const now = Date.now();
  const timestamp = String(input.kind === "expired" ? now - 10 * 60_000 : now);
  const body = JSON.stringify({
    jobId,
    sequence,
    event: "state_changed",
    state: "running",
    timestamp: new Date(now).toISOString(),
  });
  const signature =
    input.kind === "bad_signature"
      ? `sha256=${"0".repeat(64)}`
      : `sha256=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
  const response = await receiveWebhook(
    new Request("http://localhost/webhook", {
      method: "POST",
      body,
      headers: {
        "content-type": "application/json",
        "x-buncrawl-timestamp": timestamp,
        "x-buncrawl-signature": signature,
        "x-buncrawl-delivery": `${jobId}:sim-${sequence}`,
      },
    }),
    true,
  );
  return Response.json({ status: response.status, delivery: deliveries[0] });
}

/** Confirms a public receiver URL reaches this tester's /webhook (e.g. through a tunnel). */
async function checkReceiver(input: { url?: string }): Promise<Response> {
  let url: URL;
  try {
    url = new URL(input.url ?? "");
  } catch {
    return error(400, "Invalid receiver URL");
  }
  if (url.protocol !== "https:") return error(400, "Receiver must use HTTPS");
  try {
    const response = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(8_000),
    });
    await response.body?.cancel();
    const reachesTester = response.headers.get("x-job-events-tester") === "1";
    return Response.json({
      ok: reachesTester,
      status: response.status,
      message: reachesTester
        ? "Receiver URL reaches this tester."
        : `Got HTTP ${response.status}, but not from this tester's /webhook. Check the path and tunnel target.`,
    });
  } catch (cause) {
    return Response.json({ ok: false, status: 0, message: `Unreachable: ${String(cause)}` });
  }
}

async function submitJob(request: Request): Promise<Response> {
  const input = await readJson<{
    type?: string;
    url?: string;
    webhookUrl?: string;
    events?: unknown;
  }>(request);
  if (!input) return error(400, "Invalid JSON");
  if (!Object.hasOwn(routes, input.type ?? "")) return error(400, "Invalid job type");
  try {
    if (!input.url || !["http:", "https:"].includes(new URL(input.url).protocol)) throw new Error();
  } catch {
    return error(400, "Enter an HTTP(S) page URL");
  }
  let webhook: { url: string; secret: string; events?: string[] } | undefined;
  if (input.webhookUrl) {
    try {
      const receiver = new URL(input.webhookUrl);
      if (receiver.protocol !== "https:" || receiver.username || receiver.password)
        return error(400, "Use a public HTTPS receiver URL");
      webhook = { url: receiver.href, secret };
    } catch {
      return error(400, "Invalid receiver URL");
    }
    if (input.events !== undefined) {
      const events = input.events;
      if (
        !Array.isArray(events) ||
        events.length === 0 ||
        !events.every((event) => (webhookEvents as readonly unknown[]).includes(event))
      )
        return error(400, "Pick at least one valid webhook event");
      webhook.events = [...new Set(events as string[])];
    }
  }
  const type = input.type as JobType;
  const body =
    type === "batch_scrape"
      ? { requests: [{ url: input.url }], ...(webhook && { webhook }) }
      : { url: input.url, ...(webhook && { webhook }) };
  try {
    const response = await fetch(new URL(`/v1/${routes[type]}`, target), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    return new Response(response.body, {
      status: response.status,
      headers: { "content-type": "application/json" },
    });
  } catch (cause) {
    return error(502, `Cannot reach Buncrawl: ${String(cause)}`);
  }
}

export function createTesterServer() {
  return Bun.serve({
    hostname: "0.0.0.0", // Public tunnel forwards to this port; only /webhook is exposed by host checks below.
    port,
    idleTimeout: 30, // Allows the receiver's simulated timeout to outlast Buncrawl's own.
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/webhook") return receiveWebhook(request);
      if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
        return error(403, "Local UI only");
      if (url.pathname === "/")
        return new Response(Bun.file(new URL("./index.html", import.meta.url)), {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      if (url.pathname === "/api/deliveries") {
        if (request.method === "GET") return Response.json(deliveries);
        if (request.method === "DELETE") {
          deliveries.length = 0;
          return new Response(null, { status: 204 });
        }
      }
      if (url.pathname === "/api/config" && request.method === "GET")
        return Response.json({ target: target.origin, secret, receiverMode, webhookEvents });
      if (url.pathname === "/api/receiver" && request.method === "POST") {
        const input = await readJson<{ mode?: string }>(request);
        if (!receiverModes.includes(input?.mode as ReceiverMode))
          return error(400, "Invalid receiver mode");
        receiverMode = input!.mode as ReceiverMode;
        return Response.json({ receiverMode });
      }
      if (url.pathname === "/api/simulate" && request.method === "POST") {
        const input = await readJson<{ jobId?: string; kind?: string }>(request);
        return input ? simulateDelivery(input) : error(400, "Invalid JSON");
      }
      if (url.pathname === "/api/check-receiver" && request.method === "POST") {
        const input = await readJson<{ url?: string }>(request);
        return input ? checkReceiver(input) : error(400, "Invalid JSON");
      }
      if (url.pathname === "/api/submit" && request.method === "POST") return submitJob(request);
      const match = /^\/api\/events\/(batch_scrape|map|crawl)\/(job_[0-9a-f]{32})$/.exec(
        url.pathname,
      );
      if (match && request.method === "GET") {
        const [, type, id] = match as [string, JobType, string];
        if (!jobIdPattern.test(id)) return error(400, "Invalid job ID");
        const upstream = new URL(`/v1/${routes[type]}/${id}/events`, target);
        const after = url.searchParams.get("after");
        if (after !== null) upstream.searchParams.set("after", after);
        // EventSource reconnects with Last-Event-ID; Buncrawl prefers it over ?after=.
        const lastEventId = request.headers.get("last-event-id");
        try {
          const response = await fetch(upstream, {
            headers: {
              accept: "text/event-stream",
              ...(lastEventId !== null && { "last-event-id": lastEventId }),
            },
            signal: request.signal,
          });
          return new Response(response.body, {
            status: response.status,
            headers: {
              "content-type": response.headers.get("content-type") ?? "application/json",
              "cache-control": "no-cache",
            },
          });
        } catch (cause) {
          return error(502, `Cannot reach Buncrawl: ${String(cause)}`);
        }
      }
      const statusMatch = /^\/api\/jobs\/(batch_scrape|map|crawl)\/(job_[0-9a-f]{32})$/.exec(
        url.pathname,
      );
      if (statusMatch && (request.method === "GET" || request.method === "DELETE")) {
        const [, type, id] = statusMatch as [string, JobType, string];
        const upstream = new URL(`/v1/${routes[type]}/${id}`, target);
        if (request.method === "GET") {
          for (const key of ["cursor", "limit"])
            if (url.searchParams.has(key))
              upstream.searchParams.set(key, url.searchParams.get(key)!);
        }
        try {
          const response = await fetch(upstream, {
            method: request.method,
            signal: AbortSignal.timeout(15_000),
          });
          return new Response(response.body, {
            status: response.status,
            headers: { "content-type": response.headers.get("content-type") ?? "application/json" },
          });
        } catch (cause) {
          return error(502, `Cannot reach Buncrawl: ${String(cause)}`);
        }
      }
      return error(404, "Not found");
    },
  });
}

if (import.meta.main) {
  const server = createTesterServer();
  console.info(`Tester: http://localhost:${server.port} → Buncrawl ${target.origin}`);
  console.info("Expose /webhook through a public HTTPS tunnel to receive signed deliveries.");
}
