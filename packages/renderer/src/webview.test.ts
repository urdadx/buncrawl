import { describe, expect, test } from "bun:test";
import { Deadline } from "@buncrawl/core";

import { WebViewRenderer, WebViewRendererError } from "./webview";

class FakeWebView {
  url = "";
  title = "Rendered title";
  closed = false;
  evaluations = 0;

  async navigate(url: string) {
    this.url = `${url}/final`;
  }

  async evaluate(script: string): Promise<unknown> {
    this.evaluations += 1;
    if (script.includes("htmlLength")) {
      return { readyState: "complete", htmlLength: 42 };
    }
    return "<html><body>Rendered</body></html>";
  }

  async screenshot() {
    return "cG5n";
  }

  close() {
    this.closed = true;
  }
}

describe("WebViewRenderer", () => {
  test("renders HTML and always closes the view", async () => {
    const view = new FakeWebView();
    const renderer = new WebViewRenderer({
      stabilityTimeoutMs: 500,
      factory: () => view,
    });

    const result = await renderer.render({
      url: "https://example.com",
      deadline: new Deadline(2000),
    });

    expect(result).toMatchObject({
      sourceUrl: "https://example.com",
      finalUrl: "https://example.com/final",
      title: "Rendered title",
      html: "<html><body>Rendered</body></html>",
      renderer: "webview",
    });
    expect(view.evaluations).toBeGreaterThanOrEqual(3);
    expect(view.closed).toBe(true);
  });

  test("captures an optional base64 screenshot", async () => {
    const renderer = new WebViewRenderer({
      stabilityTimeoutMs: 0,
      factory: () => new FakeWebView(),
    });
    const result = await renderer.render({
      url: "https://example.com",
      deadline: new Deadline(1000),
      screenshot: true,
    });

    expect(result.screenshot).toEqual({ data: "cG5n", mimeType: "image/png" });
  });

  test("wraps navigation failures and closes the view", async () => {
    const view = new FakeWebView();
    view.navigate = async () => {
      throw new Error("navigation failed");
    };
    const renderer = new WebViewRenderer({ factory: () => view });

    const promise = renderer.render({
      url: "https://example.com",
      deadline: new Deadline(1000),
    });
    await expect(promise).rejects.toBeInstanceOf(WebViewRendererError);
    await expect(promise).rejects.toMatchObject({ code: "WEBVIEW_NAVIGATION_FAILED" });
    expect(view.closed).toBe(true);
  });

  test("does not create a view after cancellation", async () => {
    const controller = new AbortController();
    controller.abort(new Error("client disconnected"));
    let created = false;
    const renderer = new WebViewRenderer({
      factory: () => {
        created = true;
        return new FakeWebView();
      },
    });

    await expect(
      renderer.render({
        url: "https://example.com",
        deadline: new Deadline(1000, controller.signal),
      }),
    ).rejects.toThrow("client disconnected");
    expect(created).toBe(false);
  });

  test("reports Chrome-only CDP capability correctly", () => {
    const renderer = new WebViewRenderer({
      backend: "chrome",
      factory: () => new FakeWebView(),
    });
    expect(renderer.capabilities()).toMatchObject({
      browser: true,
      javascript: true,
      screenshots: true,
      cdp: true,
    });
  });
});
