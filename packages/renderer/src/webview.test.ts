import { describe, expect, test } from "bun:test";
import { Deadline } from "@buncrawl/core";

import { WebViewRenderer, WebViewRendererError } from "./webview";

class FakeWebView {
  url = "";
  title = "Rendered title";
  closed = false;
  evaluations = 0;
  private readonly listeners = new Map<string, Set<(event: { data?: unknown }) => void>>();

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

  async cdp() {}

  addEventListener(type: string, listener: (event: { data?: unknown }) => void) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: (event: { data?: unknown }) => void) {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type: string, data: unknown) {
    for (const listener of this.listeners.get(type) ?? []) listener({ data });
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

  test("fails closed when Chromium request interception is unavailable", async () => {
    const renderer = new WebViewRenderer({
      factory: () => ({
        url: "",
        title: "",
        async navigate() {},
        async evaluate() {
          return "<html></html>";
        },
        async screenshot() {
          return "cG5n";
        },
        close() {},
      }),
    });

    await expect(
      renderer.render({ url: "https://example.com", deadline: new Deadline(1000) }),
    ).rejects.toMatchObject({ code: "WEBVIEW_UNAVAILABLE" });
  });

  test("blocks a browser navigation that resolves to a private address", async () => {
    const view = new FakeWebView();
    view.navigate = async (url) => {
      view.url = url;
      if (url !== "about:blank") {
        view.emit("Fetch.requestPaused", {
          requestId: "navigation",
          request: { url },
        });
      }
    };
    const renderer = new WebViewRenderer({
      backend: "chrome",
      factory: () => view,
      networkSafety: { resolver: async () => ["127.0.0.1"] },
    });

    await expect(
      renderer.render({ url: "https://rebind.example", deadline: new Deadline(1000) }),
    ).rejects.toMatchObject({ code: "BLOCKED_DESTINATION" });
    expect(view.closed).toBe(true);
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

  test("passes validated proxy flags to a spawned Chrome process", async () => {
    let receivedOptions: unknown;
    const renderer = new WebViewRenderer({
      chrome: {
        proxyUrl: "socks5://proxy.example.com:1080",
        argv: ["--lang=en-US"],
      },
      stabilityTimeoutMs: 0,
      factory: (options) => {
        receivedOptions = options;
        return new FakeWebView();
      },
    });

    await renderer.render({
      url: "https://example.com",
      deadline: new Deadline(1000),
    });

    expect(receivedOptions).toMatchObject({
      backend: {
        type: "chrome",
        url: false,
        argv: [
          "--lang=en-US",
          "--proxy-server=socks5://proxy.example.com:1080",
          "--proxy-bypass-list=<-loopback>",
        ],
      },
      dataStore: "ephemeral",
    });
  });

  test.each([
    "ftp://proxy.example.com:21",
    "http://user:password@proxy.example.com:8080",
    "http://proxy.example.com:8080/path",
  ])("rejects unsafe or unsupported proxy configuration %s", (proxyUrl) => {
    expect(() => new WebViewRenderer({ chrome: { proxyUrl } })).toThrow(WebViewRendererError);
  });

  test("rejects conflicting proxy launch flags", () => {
    expect(
      () =>
        new WebViewRenderer({
          chrome: {
            proxyUrl: "http://proxy.example.com:8080",
            argv: ["--proxy-server=http://other.example.com:8080"],
          },
        }),
    ).toThrow("proxyUrl conflicts");
  });
});
