import { describe, expect, test } from "bun:test";
import type { BrandingProfile } from "@buncrawl/contracts";
import type { FetchPageResult } from "@buncrawl/fetcher";
import {
  RendererChain,
  type Renderer,
  type RenderRequest,
  type RenderResult,
} from "@buncrawl/renderer";

import { scrape } from "../src";

const html = `<html><head><title>Acme</title></head><body><main><h1>Acme</h1><p>${"Useful content. ".repeat(30)}</p></main></body></html>`;
const branding: BrandingProfile = {
  colorScheme: "light",
  brandName: "Acme",
  logo: null,
  colors: { primary: "#533AFD", background: "#FFFFFF" },
};
const publicDns = { resolver: async () => ["93.184.216.34"] };

class FakeRenderer implements Renderer {
  calls: RenderRequest[] = [];

  constructor(
    readonly name: string,
    private readonly result: Partial<RenderResult>,
    private readonly computedStyles = true,
  ) {}

  capabilities() {
    return {
      available: true,
      browser: true,
      javascript: true,
      screenshots: true,
      cdp: this.computedStyles,
      computedStyles: this.computedStyles,
    };
  }

  async render(request: RenderRequest): Promise<RenderResult> {
    this.calls.push(request);
    return {
      sourceUrl: request.url,
      finalUrl: request.url,
      title: "Acme",
      html,
      renderer: this.name,
      elapsedMs: 1,
      ...this.result,
    };
  }
}

function fetched(): FetchPageResult {
  return {
    sourceUrl: "https://acme.test",
    finalUrl: "https://acme.test/",
    statusCode: 200,
    headers: new Headers({ "content-type": "text/html" }),
    contentType: "text/html",
    charset: "utf-8",
    body: html,
    rawBody: new TextEncoder().encode(html),
    elapsedMs: 1,
    redirectCount: 0,
  };
}

describe("branding format", () => {
  test("renders in a browser and returns the profile without fetching first", async () => {
    const renderer = new FakeRenderer("webview", { branding });
    let fetches = 0;
    const response = await scrape({ url: "https://acme.test", formats: ["branding"] }, publicDns, {
      renderer,
      fetch: async () => {
        fetches += 1;
        return fetched();
      },
    });

    expect(response).toMatchObject({ success: true, data: { branding } });
    if (!response.success) return;
    expect(response.data.markdown).toBeUndefined();
    expect(response.warning).toBeUndefined();
    expect(fetches).toBe(0);
    expect(renderer.calls[0]).toMatchObject({ branding: true });
    expect(renderer.calls[0]?.screenshot).toBeUndefined();
  });

  test("returns other formats alongside branding from the same render", async () => {
    const renderer = new FakeRenderer("webview", { branding });
    const response = await scrape(
      { url: "https://acme.test", formats: ["markdown", "branding"] },
      publicDns,
      { renderer, fetch: async () => fetched() },
    );

    expect(response.success).toBe(true);
    if (!response.success) return;
    expect(response.data.markdown).toContain("Useful content.");
    expect(response.data.branding).toEqual(branding);
    expect(renderer.calls).toHaveLength(1);
  });

  test("skips renderers that cannot measure branding", async () => {
    const lightpanda = new FakeRenderer("lightpanda", {}, false);
    const webview = new FakeRenderer("webview", { branding });
    const response = await scrape({ url: "https://acme.test", formats: ["branding"] }, publicDns, {
      renderer: new RendererChain([lightpanda, webview]),
    });

    expect(response).toMatchObject({ success: true, data: { branding } });
    expect(lightpanda.calls).toHaveLength(0);
  });

  test("warns when the page rendered but branding could not be measured", async () => {
    const response = await scrape(
      { url: "https://acme.test", formats: ["markdown", "branding"] },
      publicDns,
      { renderer: new FakeRenderer("webview", {}), fetch: async () => fetched() },
    );

    expect(response).toMatchObject({ success: true, warning: "Branding could not be measured" });
    if (!response.success) return;
    expect(response.data.branding).toBeUndefined();
    expect(response.data.markdown).toContain("Useful content.");
  });

  test("rejects branding when JavaScript rendering is disabled", async () => {
    const response = await scrape(
      { url: "https://acme.test", formats: ["branding"], renderJs: false },
      publicDns,
      { renderer: new FakeRenderer("webview", { branding }) },
    );
    expect(response).toEqual({
      success: false,
      code: "INVALID_REQUEST",
      error: "branding requires JavaScript rendering",
    });
  });
});
