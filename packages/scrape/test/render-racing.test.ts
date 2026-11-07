import { describe, expect, test } from "bun:test";
import type { FetchPageResult } from "@buncrawl/fetcher";
import type {
  FallbackOptions,
  FallbackRenderer,
  RenderRequest,
  RenderResultAcceptance,
} from "@buncrawl/renderer";

import { scrape } from "../src";

const shell = `<html><body><div id="root"></div><script src="/app.js"></script></body></html>`;

function fetched(): FetchPageResult {
  return {
    sourceUrl: "https://example.com",
    finalUrl: "https://example.com/",
    statusCode: 200,
    headers: new Headers({ "content-type": "text/html" }),
    contentType: "text/html",
    charset: "utf-8",
    body: shell,
    rawBody: new TextEncoder().encode(shell),
    elapsedMs: 1,
    redirectCount: 0,
  };
}

/** Records the fallback options scrape() asks the chain for. */
class RecordingChain implements FallbackRenderer {
  readonly name = "chain";
  options: Array<FallbackOptions | undefined> = [];

  capabilities() {
    return { available: true, browser: true, javascript: true, screenshots: true, cdp: true };
  }
  render(request: RenderRequest) {
    return this.renderWithFallback(request, () => true);
  }
  async renderWithFallback(
    _request: RenderRequest,
    _accept: RenderResultAcceptance,
    options?: FallbackOptions,
  ) {
    this.options.push(options);
    return {
      sourceUrl: "https://example.com/",
      finalUrl: "https://example.com/",
      title: "Rendered",
      html: `<html><body><main><h1>Rendered</h1><p>${"Rendered text. ".repeat(40)}</p></main></body></html>`,
      renderer: "webview",
      elapsedMs: 1,
    };
  }
}

describe("render racing policy", () => {
  test("races renderers only when an auto-mode render must beat fetched content", async () => {
    const chain = new RecordingChain();
    const run = (renderJs: "auto" | true) =>
      scrape(
        { url: "https://example.com", renderJs },
        { resolver: async () => ["93.184.216.34"] },
        { renderer: chain, fetch: async () => fetched() },
      );

    await run("auto");
    await run(true);
    expect(chain.options).toEqual([{ startFallbackAfterMs: 0 }, {}]);
  });
});
