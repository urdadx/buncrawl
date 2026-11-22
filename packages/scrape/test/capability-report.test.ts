import { afterEach, describe, expect, test } from "bun:test";
import type { FetchPageResult } from "@buncrawl/fetcher";
import {
  setRendererCapabilityReport,
  type RendererCapabilities,
  type RendererCapabilityReport,
} from "@buncrawl/renderer";

import { scrape } from "../src";

const unavailable: RendererCapabilities = {
  available: false,
  browser: false,
  javascript: false,
  screenshots: false,
  cdp: false,
  computedStyles: false,
};

// Both browsers resolve but fail the launch probe, as a Chrome without a usable sandbox does.
const brokenBrowsers: RendererCapabilityReport = {
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

const spaShell = `<html><body><div id="root"></div><script src="/app.js"></script></body></html>`;

function fetched(body: string): FetchPageResult {
  return {
    sourceUrl: "https://example.com",
    finalUrl: "https://example.com/",
    statusCode: 200,
    headers: new Headers({ "content-type": "text/html" }),
    contentType: "text/html",
    charset: "utf-8",
    body,
    rawBody: new TextEncoder().encode(body),
    elapsedMs: 5,
    redirectCount: 0,
  };
}

afterEach(() => setRendererCapabilityReport(undefined));

describe("default renderer selection", () => {
  test("never renders with browsers the capability report marks unavailable", async () => {
    setRendererCapabilityReport(brokenBrowsers);
    const response = await scrape({ url: "http://93.184.215.14/", renderJs: true });
    expect(response).toEqual({
      success: false,
      code: "RENDERER_UNAVAILABLE",
      error: "Browser rendering is unavailable",
    });
  });

  test("returns fetched content when the report has no working browser", async () => {
    setRendererCapabilityReport(brokenBrowsers);
    const response = await scrape(
      { url: "https://example.com" },
      {},
      { fetch: async () => fetched(spaShell) },
    );
    expect(response.success).toBe(true);
    if (!response.success) return;
    expect(response.warning).toBe("Browser rendering was unavailable; returned fetched content");
  });

  test("stops waiting for a pending capability check at the scrape deadline", async () => {
    setRendererCapabilityReport(new Promise<never>(() => {}));
    const response = await scrape({ url: "http://93.184.215.14/", renderJs: true, timeout: 50 });
    expect(response).toMatchObject({ success: false, code: "DEADLINE_EXCEEDED" });
  });
});
