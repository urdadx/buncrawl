import { afterEach, expect, test } from "bun:test";
import { createDb, enqueueJob, getJob, getJobItems, migrateDb } from "@buncrawl/db";
import {
  setRendererCapabilityReport,
  type RendererCapabilities,
  type RendererCapabilityReport,
} from "@buncrawl/renderer";

import { JobWorker } from "../src";

const workers: JobWorker[] = [];
afterEach(async () => {
  await Promise.all(workers.splice(0).map((worker) => worker.stop()));
  setRendererCapabilityReport(undefined);
});

const dispatch = { listen: async () => {}, active: async () => {}, close: () => {} };

const unavailable: RendererCapabilities = {
  available: false,
  browser: false,
  javascript: false,
  screenshots: false,
  cdp: false,
  computedStyles: false,
};

// Chrome resolves but cannot start here, so the startup check marks every renderer unavailable.
const report: RendererCapabilityReport = {
  checkedAt: "2026-11-22T00:00:00.000Z",
  renderers: [
    {
      name: "lightpanda",
      executable: null,
      version: null,
      capabilities: unavailable,
      error: "Lightpanda executable not found: lightpanda",
    },
    {
      name: "webview",
      executable: "/opt/chrome/chrome",
      version: "Chromium 158.0.8127.36",
      capabilities: unavailable,
      error: "/opt/chrome/chrome exited with code 133: FATAL: No usable sandbox!",
    },
  ],
  summary: unavailable,
};

test("job scrapes skip renderers the capability report marks unavailable", async () => {
  setRendererCapabilityReport(report);
  const db = createDb({ DATABASE_URL: ":memory:" });
  await migrateDb(db);
  const { job } = await enqueueJob(db, {
    submission: {
      type: "batch_scrape",
      requests: [{ url: "http://93.184.215.14/", renderJs: true }],
    },
    limits: { maxItems: 10, timeoutMs: 5000 },
  });

  // No scrapeItem override: the worker runs the real scrape() with its default renderer.
  const worker = new JobWorker({ db, dispatch, pollMs: 20 });
  workers.push(worker);
  await worker.start();
  for (let i = 0; i < 100 && (await getJob(db, job.id))?.state !== "completed"; i++) {
    await Bun.sleep(20);
  }

  const [item] = await getJobItems(db, job.id);
  expect(item?.state).toBe("failed");
  expect(item?.error).toMatchObject({ code: "RENDERER_UNAVAILABLE" });
});
