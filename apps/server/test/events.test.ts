import { describe, expect, test } from "bun:test";
import { createDb, enqueueJob, migrateDb, requestJobCancellation } from "@buncrawl/db";
import { createEventsHandler } from "../src/routes/v1/events";

describe("job SSE", () => {
  test("sends a snapshot and resumes from Last-Event-ID after cancellation", async () => {
    const db = createDb({ DATABASE_URL: ":memory:" });
    await migrateDb(db);
    const { job } = await enqueueJob(db, {
      submission: { type: "batch_scrape", requests: [{ url: "https://example.com" }] },
      limits: { maxItems: 1, timeoutMs: 1000 },
    });
    await requestJobCancellation(db, job.id);
    const handler = createEventsHandler(db);
    const url = `http://localhost/v1/batch/scrape/${job.id}/events`;
    const snapshot = await handler(new Request(url), job.id, "batch_scrape");
    expect(snapshot.headers.get("content-type")).toContain("text/event-stream");
    expect(await snapshot.text()).toContain("event: snapshot");
    const resumed = await handler(
      new Request(url, { headers: { "Last-Event-ID": "1" } }),
      job.id,
      "batch_scrape",
    );
    const text = await resumed.text();
    expect(text).toContain("id: 2");
    expect(text).toContain("event: state_changed");
    expect(text).not.toContain("event: snapshot");
  });
});
