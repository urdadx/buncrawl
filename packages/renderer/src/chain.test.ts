import { Deadline } from "@buncrawl/core";
import { describe, expect, test } from "bun:test";

import { RendererChain } from "./chain";
import type { RenderRequest, Renderer, RenderResult } from "./renderer";

class FakeRenderer implements Renderer {
  calls: RenderRequest[] = [];

  constructor(
    readonly name: string,
    private readonly response: RenderResult | Error,
    private readonly available = true,
  ) {}

  capabilities() {
    return {
      available: this.available,
      browser: this.available,
      javascript: this.available,
      screenshots: this.available,
      cdp: this.name.includes("webview"),
    };
  }

  async render(request: RenderRequest) {
    this.calls.push(request);
    if (this.response instanceof Error) throw this.response;
    return this.response;
  }
}

function result(renderer: string, html = `<html><body>${renderer}</body></html>`): RenderResult {
  return {
    sourceUrl: "https://example.com",
    finalUrl: "https://example.com",
    title: renderer,
    html,
    renderer,
    elapsedMs: 1,
  };
}

describe("RendererChain", () => {
  test("falls back after a runtime renderer failure", async () => {
    const lightpanda = new FakeRenderer("isolated-lightpanda", new Error("browser failed"));
    const webview = new FakeRenderer("isolated-webview", result("webview"));
    const chain = new RendererChain([lightpanda, webview]);

    const rendered = await chain.render({
      url: "https://example.com",
      deadline: new Deadline(1000),
    });

    expect(rendered.renderer).toBe("webview");
    expect(lightpanda.calls).toHaveLength(1);
    expect(webview.calls).toHaveLength(1);
  });

  test("falls back when the caller rejects output quality", async () => {
    const lightpanda = new FakeRenderer("isolated-lightpanda", result("lightpanda", "Loading"));
    const webview = new FakeRenderer("isolated-webview", result("webview", "Complete article"));
    const chain = new RendererChain([lightpanda, webview]);

    const rendered = await chain.renderWithFallback(
      { url: "https://example.com", deadline: new Deadline(1000) },
      (candidate) => candidate.html.includes("Complete"),
    );

    expect(rendered.renderer).toBe("webview");
    expect(webview.calls[0]?.deadline).toBe(lightpanda.calls[0]?.deadline);
  });

  test("does not bypass a terminal destination error", async () => {
    const blocked = Object.assign(new Error("blocked"), { code: "BLOCKED_DESTINATION" });
    const lightpanda = new FakeRenderer("isolated-lightpanda", blocked);
    const webview = new FakeRenderer("isolated-webview", result("webview"));
    const chain = new RendererChain([lightpanda, webview]);

    await expect(
      chain.render({ url: "https://example.com", deadline: new Deadline(1000) }),
    ).rejects.toMatchObject({ code: "BLOCKED_DESTINATION" });
    expect(webview.calls).toHaveLength(0);
  });

  test("prefers one-navigation WebView rendering for screenshots", async () => {
    const lightpanda = new FakeRenderer("isolated-lightpanda", {
      ...result("lightpanda"),
      screenshot: { data: "lightpanda", mimeType: "image/png" },
    });
    const webview = new FakeRenderer("isolated-webview", {
      ...result("webview"),
      screenshot: { data: "webview", mimeType: "image/png" },
    });
    const chain = new RendererChain([lightpanda, webview]);

    const rendered = await chain.render({
      url: "https://example.com",
      deadline: new Deadline(1000),
      screenshot: true,
    });

    expect(rendered.renderer).toBe("webview");
    expect(lightpanda.calls).toHaveLength(0);
  });
});
