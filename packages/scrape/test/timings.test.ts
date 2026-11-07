import { describe, expect, test } from "bun:test";
import type { FetchPageResult } from "@buncrawl/fetcher";
import type { Renderer, RenderResult } from "@buncrawl/renderer";

import { scrape, type ScrapeTimings } from "../src";

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

function renderer(result: RenderResult | Error): Renderer {
  return {
    name: "fake-webview",
    capabilities: () => ({
      available: true,
      browser: true,
      javascript: true,
      screenshots: true,
      cdp: true,
    }),
    render: async () => {
      await Bun.sleep(15);
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

const staticPage = `<html><body><main><h1>Static</h1><p>${"Article text. ".repeat(40)}</p></main></body></html>`;
const spaShell = `<html><body><div id="root"></div><script src="/app.js"></script></body></html>`;
const renderedPage: RenderResult = {
  sourceUrl: "https://example.com/",
  finalUrl: "https://example.com/",
  html: `<html><body><main><h1>Rendered</h1><p>${"Useful rendered content. ".repeat(30)}</p></main></body></html>`,
  renderer: "webview",
  elapsedMs: 15,
};

async function timingsFor(
  ...args: Parameters<typeof scrape>
): Promise<{ timings: ScrapeTimings; success: boolean }> {
  let timings: ScrapeTimings | undefined;
  const response = await scrape(
    args[0],
    { ...args[1], onTimings: (value) => (timings = value) },
    args[2],
  );
  return { timings: timings!, success: response.success };
}

describe("scrape timings", () => {
  test("reports fetch, detection and extraction for a static page without rendering", async () => {
    const { timings } = await timingsFor(
      { url: "https://example.com" },
      {},
      { fetch: async () => fetched(staticPage), renderer: renderer(renderedPage) },
    );
    expect(timings.renderer).toBe("fetch");
    expect(timings.renderMs).toBeUndefined();
    for (const phase of ["fetchMs", "detectMs", "extractMs"] as const)
      expect(timings[phase]).toBeGreaterThanOrEqual(0);
    expect(timings.totalMs).toBeGreaterThanOrEqual(
      timings.fetchMs! + timings.detectMs! + timings.extractMs!,
    );
  });

  test("attributes browser time to the render phase and names the renderer used", async () => {
    const { timings } = await timingsFor(
      { url: "https://example.com" },
      {},
      { fetch: async () => fetched(spaShell), renderer: renderer(renderedPage) },
    );
    expect(timings.renderer).toBe("webview");
    expect(timings.renderMs).toBeGreaterThanOrEqual(10);
  });

  test("still reports timings when the scrape fails", async () => {
    const { timings, success } = await timingsFor(
      { url: "https://example.com", renderJs: true },
      { resolver: async () => ["93.184.216.34"] },
      { renderer: renderer(new Error("browser crashed")) },
    );
    expect(success).toBe(false);
    expect(timings.renderMs).toBeGreaterThanOrEqual(10);
    expect(timings.extractMs).toBeUndefined();
  });
});
