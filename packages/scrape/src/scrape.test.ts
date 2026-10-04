import { describe, expect, test } from "bun:test";
import type { FetchPageOptions, FetchPageResult } from "@buncrawl/fetcher";
import { RendererChain, type Renderer, type RenderRequest, type RenderResult } from "@buncrawl/renderer";

import { scrape } from "./scrape";

function fetched(body: string): FetchPageResult {
  return {
    sourceUrl: "https://example.com",
    finalUrl: "https://example.com/final",
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

class FakeRenderer implements Renderer {
  readonly name = "fake-webview";
  calls: RenderRequest[] = [];

  constructor(
    private readonly result: RenderResult | Error,
    private readonly available = true,
  ) {}

  capabilities() {
    return {
      available: this.available,
      browser: this.available,
      javascript: this.available,
      screenshots: this.available,
      cdp: this.available,
    };
  }

  async render(request: RenderRequest): Promise<RenderResult> {
    this.calls.push(request);
    if (this.result instanceof Error) throw this.result;
    return this.result;
  }
}

const renderedPage: RenderResult = {
  sourceUrl: "https://example.com/final",
  finalUrl: "https://example.com/app",
  title: "Rendered",
  html: `<html><head><title>Rendered</title></head><body><main><h1>Rendered page</h1><p>${"Useful rendered content. ".repeat(20)}</p></main></body></html>`,
  renderer: "webview",
  elapsedMs: 20,
};

describe("scrape", () => {
  test("keeps a substantive static page on the fetch path", async () => {
    const renderer = new FakeRenderer(renderedPage);
    const response = await scrape(
      {
        url: "https://example.com",
        formats: ["markdown", "html", "rawHtml", "links"],
      },
      {},
      {
        fetch: async () =>
          fetched(
            `<html><head><title>Static</title></head><body><h1>Static</h1><p>${"Article text. ".repeat(30)}</p><a href="/next">Next</a></body></html>`,
          ),
        renderer,
      },
    );

    expect(response.success).toBe(true);
    if (!response.success) return;
    expect(response.data.metadata.renderer).toBe("fetch");
    expect(response.data.markdown).toContain("# Static");
    expect(response.data.links).toContain("https://example.com/next");
    expect(renderer.calls).toHaveLength(0);
  });

  test("renders an SPA shell in automatic mode", async () => {
    const renderer = new FakeRenderer(renderedPage);
    const response = await scrape(
      { url: "https://example.com", renderJs: "auto" },
      {},
      {
        fetch: async () =>
          fetched('<html><body><div id="root"></div><script src="/app.js"></script></body></html>'),
        renderer,
      },
    );

    expect(response.success).toBe(true);
    if (!response.success) return;
    expect(response.data.metadata.renderer).toBe("webview");
    expect(response.data.markdown).toContain("Rendered page");
    expect(renderer.calls).toHaveLength(1);
  });

  test("escalates inadequate Lightpanda output to WebView", async () => {
    const lightpanda = new FakeRenderer({
      ...renderedPage,
      html: '<html><body><div class="spinner">Loading...</div></body></html>',
      renderer: "lightpanda",
    });
    const webview = new FakeRenderer({
      ...renderedPage,
      html: `<html><body><h1>Complete article</h1><p>${"Useful content. ".repeat(30)}</p></body></html>`,
      renderer: "webview",
    });
    const response = await scrape(
      { url: "https://example.com", renderJs: "auto" },
      {},
      {
        fetch: async () =>
          fetched('<html><body><div id="root"></div><script src="/app.js"></script></body></html>'),
        renderer: new RendererChain([lightpanda, webview]),
      },
    );

    expect(response).toMatchObject({
      success: true,
      data: { metadata: { renderer: "webview" } },
    });
    expect(lightpanda.calls).toHaveLength(1);
    expect(webview.calls).toHaveLength(1);
  });

  test("reports Lightpanda as the concrete renderer", async () => {
    const renderer = new FakeRenderer({ ...renderedPage, renderer: "lightpanda" });
    const response = await scrape(
      { url: "https://example.com", renderJs: true },
      { resolver: async () => ["93.184.216.34"] },
      { renderer },
    );

    expect(response).toMatchObject({
      success: true,
      data: { metadata: { renderer: "lightpanda" } },
    });
  });

  test("never invokes the renderer when renderJs is false", async () => {
    const renderer = new FakeRenderer(renderedPage);
    const response = await scrape(
      { url: "https://example.com", renderJs: false },
      {},
      {
        fetch: async () =>
          fetched('<html><body><div id="root"></div><script src="/app.js"></script></body></html>'),
        renderer,
      },
    );

    expect(response.success).toBe(true);
    expect(renderer.calls).toHaveLength(0);
  });

  test("forced rendering bypasses native fetch", async () => {
    let fetchCalls = 0;
    const response = await scrape(
      { url: "https://example.com", renderJs: true },
      { resolver: async () => ["93.184.216.34"] },
      {
        fetch: async () => {
          fetchCalls += 1;
          return fetched("unused");
        },
        renderer: new FakeRenderer(renderedPage),
      },
    );

    expect(response.success).toBe(true);
    expect(fetchCalls).toBe(0);
  });

  test("resolves relative URLs in rendered raw HTML", async () => {
    const renderer = new FakeRenderer({
      ...renderedPage,
      finalUrl: "https://padyna.com/articles/page",
      html: '<html><head><link href="/_astro/site.css"><script src="/_astro/app.js"></script></head><body><img src="images/cover.jpg"></body></html>',
    });
    const response = await scrape(
      {
        url: "https://padyna.com",
        renderJs: true,
        formats: ["rawHtml"],
      },
      { resolver: async () => ["93.184.216.34"] },
      { renderer },
    );

    expect(response.success).toBe(true);
    if (!response.success) return;
    expect(response.data.rawHtml).toContain('src="https://padyna.com/_astro/app.js"');
    expect(response.data.rawHtml).toContain('href="https://padyna.com/_astro/site.css"');
    expect(response.data.rawHtml).toContain(
      'src="https://padyna.com/articles/images/cover.jpg"',
    );
  });

  test("preserves fetched content when automatic rendering fails", async () => {
    const response = await scrape(
      { url: "https://example.com" },
      {},
      {
        fetch: async () =>
          fetched(
            '<html><body><div id="root">Fallback</div><script src="/app.js"></script></body></html>',
          ),
        renderer: new FakeRenderer(new Error("browser crashed")),
      },
    );

    expect(response).toMatchObject({
      success: true,
      warning: "Browser rendering failed; returned fetched content: browser crashed",
      data: { metadata: { renderer: "fetch" } },
    });
  });

  test("preserves fetched content when browser output is worse", async () => {
    const renderer = new FakeRenderer({
      ...renderedPage,
      html: '<html><body><div class="spinner">Loading...</div></body></html>',
    });
    const response = await scrape(
      { url: "https://example.com" },
      {},
      {
        fetch: async () =>
          fetched(
            '<html><body><div id="root">Fallback</div><script src="/app.js"></script></body></html>',
          ),
        renderer,
      },
    );

    expect(response).toMatchObject({
      success: true,
      warning: "Browser rendering did not improve the fetched content",
      data: { metadata: { renderer: "fetch" } },
    });
  });

  test("requests a screenshot and returns a PNG data URL", async () => {
    const renderer = new FakeRenderer({
      ...renderedPage,
      screenshot: { data: "cG5n", mimeType: "image/png" },
    });
    const response = await scrape(
      { url: "https://example.com", formats: ["screenshots"] },
      {},
      { fetch: async () => fetched("unused"), renderer },
    );

    expect(response).toMatchObject({
      success: true,
      data: { screenshot: "data:image/png;base64,cG5n" },
    });
    expect(renderer.calls[0]?.screenshot).toBe(true);
  });

  test("does not duplicate an existing screenshot data URL prefix", async () => {
    const renderer = new FakeRenderer({
      ...renderedPage,
      screenshot: { data: "data:image/png;base64,cG5n", mimeType: "image/png" },
    });
    const response = await scrape(
      { url: "https://example.com", formats: ["screenshots"] },
      {},
      { fetch: async () => fetched("unused"), renderer },
    );

    expect(response).toMatchObject({
      success: true,
      data: { screenshot: "data:image/png;base64,cG5n" },
    });
  });

  test("rejects screenshots when rendering is disabled", async () => {
    const response = await scrape({
      url: "https://example.com",
      formats: ["screenshots"],
      renderJs: false,
    });
    expect(response).toEqual({
      success: false,
      code: "INVALID_REQUEST",
      error: "screenshots require JavaScript rendering",
    });
  });

  test("returns a deadline error when the pipeline exceeds its budget", async () => {
    const response = await scrape(
      { url: "https://example.com", timeout: 1 },
      {},
      {
        fetch: async (_url, options: FetchPageOptions) => {
          await Bun.sleep(10);
          throw options.deadline.signal.reason ?? new Error("timed out");
        },
      },
    );
    expect(response).toMatchObject({ success: false, code: "DEADLINE_EXCEEDED" });
  });
});
