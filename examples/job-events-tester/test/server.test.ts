import { afterAll, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";

let submitted: unknown;
let lastEventIdSeen: string | null = null;
const upstream = Bun.serve({
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/v1/batch/scrape") {
      submitted = await request.json();
      return Response.json({ jobId: `job_${"a".repeat(32)}`, state: "queued" }, { status: 202 });
    }
    if (url.pathname.endsWith("/events")) {
      lastEventIdSeen = request.headers.get("last-event-id");
      return new Response(`id: 1\nevent: state_changed\ndata: {"state":"queued"}\n\n`, {
        headers: { "content-type": "text/event-stream" },
      });
    }
    if (url.pathname === `/v1/batch/scrape/job_${"a".repeat(32)}`) {
      if (request.method === "DELETE") return Response.json({ state: "cancelling" });
      return Response.json({
        state: "completed",
        progress: { succeeded: 1 },
        items: [
          { url: "https://example.com", state: "completed", document: { markdown: "# Result" } },
        ],
        cursor: url.searchParams.get("cursor"),
      });
    }
    return new Response(null, { status: 404 });
  },
});
Bun.env.BUNCRAWL_URL = upstream.url.href;
Bun.env.TESTER_PORT = "0";
Bun.env.TESTER_WEBHOOK_SECRET = "test-secret-at-least-16-characters";
const { createTesterServer } = await import("../server");
const tester = createTesterServer();
const local = `http://localhost:${tester.port}`;
const postJson = (path: string, body: unknown) =>
  fetch(new URL(path, local), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const signed = (body: string, timestamp = String(Date.now())) => ({
  "x-buncrawl-timestamp": timestamp,
  "x-buncrawl-signature": `sha256=${createHmac("sha256", Bun.env.TESTER_WEBHOOK_SECRET!).update(`${timestamp}.${body}`).digest("hex")}`,
});
afterAll(() => {
  tester.stop(true);
  upstream.stop(true);
});

describe("job event tester", () => {
  test("submits a job and proxies its SSE stream", async () => {
    const response = await fetch(new URL("/api/submit", local), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "batch_scrape", url: "https://example.com" }),
    });
    expect(response.status).toBe(202);
    const { jobId } = await response.json();
    const events = await fetch(new URL(`/api/events/batch_scrape/${jobId}?after=0`, local));
    expect(events.headers.get("content-type")).toBe("text/event-stream");
    expect(await events.text()).toContain("event: state_changed");
  });

  test("verifies signatures and rejects invalid deliveries", async () => {
    const body = JSON.stringify({ jobId: `job_${"a".repeat(32)}`, event: "progress" });
    const timestamp = String(Date.now());
    const signature = `sha256=${createHmac("sha256", Bun.env.TESTER_WEBHOOK_SECRET!).update(`${timestamp}.${body}`).digest("hex")}`;
    const post = (value: string) =>
      fetch(new URL("/webhook", local), {
        method: "POST",
        body,
        headers: {
          "x-buncrawl-timestamp": timestamp,
          "x-buncrawl-signature": value,
          "x-buncrawl-delivery": "test:1",
        },
      });
    expect((await post(signature)).status).toBe(200);
    expect((await post("sha256=" + "0".repeat(64))).status).toBe(401);
    const deliveries = await (await fetch(new URL("/api/deliveries", local))).json();
    expect(deliveries.map((entry: { valid: boolean }) => entry.valid)).toEqual([false, true]);
  });

  test("proxies persisted results, pagination and cancellation", async () => {
    const jobId = `job_${"a".repeat(32)}`;
    const status = await fetch(new URL(`/api/jobs/batch_scrape/${jobId}?cursor=3`, local));
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({
      state: "completed",
      cursor: "3",
      items: [{ document: { markdown: "# Result" } }],
    });
    const cancel = await fetch(new URL(`/api/jobs/batch_scrape/${jobId}`, local), {
      method: "DELETE",
    });
    expect(await cancel.json()).toEqual({ state: "cancelling" });
  });

  test("keeps the UI private when accessed through a tunnel hostname", async () => {
    const response = await fetch(new URL("/api/config", local), {
      headers: { host: "public-tunnel.example" },
    });
    expect(response.status).toBe(403);
  });

  test("forwards Last-Event-ID so EventSource reconnects resume", async () => {
    const jobId = `job_${"a".repeat(32)}`;
    const response = await fetch(new URL(`/api/events/batch_scrape/${jobId}?after=0`, local), {
      headers: { "last-event-id": "7" },
    });
    await response.text();
    expect(lastEventIdSeen).toBe("7");
  });

  test("passes the webhook event filter and rejects unknown events", async () => {
    const base = {
      type: "batch_scrape",
      url: "https://example.com",
      webhookUrl: "https://receiver.example/webhook",
    };
    expect((await postJson("/api/submit", { ...base, events: ["progress", "error"] })).status).toBe(
      202,
    );
    expect(submitted).toMatchObject({
      webhook: { url: base.webhookUrl, events: ["progress", "error"] },
    });
    expect((await postJson("/api/submit", { ...base, events: ["nope"] })).status).toBe(400);
    expect((await postJson("/api/submit", { ...base, events: [] })).status).toBe(400);
  });

  test("simulates signed, tampered and expired deliveries", async () => {
    const jobId = `job_${"b".repeat(32)}`;
    const results = await Promise.all(
      ["valid", "bad_signature", "expired"].map(async (kind) =>
        (await postJson("/api/simulate", { kind, jobId })).json(),
      ),
    );
    expect(results.map((result) => result.status)).toEqual([200, 401, 401]);
    expect(results.map((result) => result.delivery.reason)).toEqual([
      undefined,
      "Signature mismatch",
      "Timestamp outside the 5-minute window",
    ]);
    expect(results.every((result) => result.delivery.simulated)).toBe(true);
    expect(results[0].delivery.id).toStartWith(`${jobId}:sim-`);
    expect((await postJson("/api/simulate", { kind: "bogus" })).status).toBe(400);
  });

  test("receiver error mode returns 500 for valid deliveries but 401 for invalid ones", async () => {
    expect((await postJson("/api/receiver", { mode: "error" })).status).toBe(200);
    const body = JSON.stringify({ jobId: `job_${"c".repeat(32)}`, event: "progress" });
    const valid = await fetch(new URL("/webhook", local), {
      method: "POST",
      body,
      headers: { ...signed(body), "x-buncrawl-delivery": "retry:1" },
    });
    expect(valid.status).toBe(500);
    const invalid = await fetch(new URL("/webhook", local), {
      method: "POST",
      body,
      headers: { ...signed(body, "1"), "x-buncrawl-delivery": "retry:1" },
    });
    expect(invalid.status).toBe(401);
    const [latest, previous] = await (await fetch(new URL("/api/deliveries", local))).json();
    expect(previous).toMatchObject({ valid: true, status: 500, mode: "error" });
    expect(latest).toMatchObject({ valid: false, status: 401 });
    expect((await postJson("/api/receiver", { mode: "accept" })).status).toBe(200);
    expect((await postJson("/api/receiver", { mode: "nope" })).status).toBe(400);
  });

  test("marks /webhook responses so tunnel checks can identify the tester", async () => {
    const response = await fetch(new URL("/webhook", local));
    expect(response.status).toBe(405);
    expect(response.headers.get("x-job-events-tester")).toBe("1");
    expect((await postJson("/api/check-receiver", { url: "http://insecure.example" })).status).toBe(
      400,
    );
  });

  test("clears received deliveries", async () => {
    const response = await fetch(new URL("/api/deliveries", local), { method: "DELETE" });
    expect(response.status).toBe(204);
    expect(await (await fetch(new URL("/api/deliveries", local))).json()).toEqual([]);
  });
});
