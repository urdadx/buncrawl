import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { BunRequest } from "bun";
import { createDb, migrateDb } from "@buncrawl/db";
import {
  setRendererCapabilityReport,
  type RendererCapabilities,
  type RendererCapabilityReport,
} from "@buncrawl/renderer";

import { checkRenderers } from "../src/renderers";
import { scrapeRoutes } from "../src/routes/scrape";

const unavailable: RendererCapabilities = {
  available: false,
  browser: false,
  javascript: false,
  screenshots: false,
  cdp: false,
  computedStyles: false,
};

// Both browsers resolve, but neither starts: what a host without Chrome's sandbox or libraries reports.
const report: RendererCapabilityReport = {
  checkedAt: "2026-11-22T00:00:00.000Z",
  renderers: [
    {
      name: "lightpanda",
      executable: "/opt/lightpanda/lightpanda",
      version: null,
      capabilities: unavailable,
      error: "lightpanda exited with code 127: error while loading shared libraries",
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

afterEach(() => setRendererCapabilityReport(undefined));

describe("startup renderer check", () => {
  test("scrapes select renderers from the startup report", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(await checkRenderers(async () => report)).toBe(report);
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }

    const db = createDb({ DATABASE_URL: ":memory:" });
    await migrateDb(db);
    const response = await scrapeRoutes(db)["/v1/scrape"](
      new Request("http://localhost/v1/scrape", {
        method: "POST",
        body: JSON.stringify({ url: "http://93.184.215.14/", renderJs: true }),
        headers: { "content-type": "application/json" },
      }) as BunRequest<"/v1/scrape">,
    );
    expect(await response.json()).toMatchObject({
      success: false,
      code: "RENDERER_UNAVAILABLE",
    });
  });
});
