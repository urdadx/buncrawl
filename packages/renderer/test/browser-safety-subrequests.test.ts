import { describe, expect, test } from "bun:test";
import { Deadline } from "@buncrawl/core";

import { installBrowserNetworkGuard, type CdpEvent, type CdpView } from "../src/browser-safety";
import { WebViewRenderer } from "../src/webview";

const MAIN_FRAME = "main-frame";

interface PausedOptions {
  resourceType?: string;
  frameId?: string;
}

class FakeCdpView implements CdpView {
  readonly commands: Array<{ method: string; params?: Record<string, unknown> }> = [];
  private readonly listeners = new Map<string, Set<(event: CdpEvent) => void>>();

  async cdp(method: string, params?: Record<string, unknown>): Promise<unknown> {
    this.commands.push({ method, ...(params ? { params } : {}) });
    if (method === "Page.getFrameTree") return { frameTree: { frame: { id: MAIN_FRAME } } };
  }

  addEventListener(type: string, listener: (event: CdpEvent) => void) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: (event: CdpEvent) => void) {
    this.listeners.get(type)?.delete(listener);
  }

  request(url: string, requestId: string, options: PausedOptions) {
    for (const listener of this.listeners.get("Fetch.requestPaused") ?? []) {
      listener({ data: { requestId, request: { url }, ...options } });
    }
  }

  failed(requestId: string) {
    return this.commands.some(
      (command) =>
        command.method === "Fetch.failRequest" &&
        command.params?.requestId === requestId &&
        command.params?.errorReason === "BlockedByClient",
    );
  }

  continued(requestId: string) {
    return this.commands.some(
      (command) =>
        command.method === "Fetch.continueRequest" && command.params?.requestId === requestId,
    );
  }
}

const publicOrPrivate = async (hostname: string) =>
  hostname.endsWith(".internal") ? ["10.0.0.8"] : ["93.184.216.34"];

async function guardFor(view: FakeCdpView) {
  return installBrowserNetworkGuard(view, new AbortController().signal, {
    resolver: publicOrPrivate,
  });
}

describe("browser network guard sub-requests", () => {
  test("fails an over-long sub-request URL without failing the render", async () => {
    const view = new FakeCdpView();
    const guard = await guardFor(view);
    const longUrl = `https://ads.example.com/track?q=${"a".repeat(2100)}`;

    view.request("https://news.example/", "document", {
      resourceType: "Document",
      frameId: MAIN_FRAME,
    });
    view.request(longUrl, "tracker", { resourceType: "Script", frameId: MAIN_FRAME });
    await guard.settled();

    expect(view.continued("document")).toBe(true);
    expect(view.failed("tracker")).toBe(true);
    expect(view.continued("tracker")).toBe(false);
    expect(() => guard.throwIfBlocked()).not.toThrow();
    expect(guard.blockedSubrequests()).toBe(1);
    guard.close();
  });

  test.each([
    ["Image", MAIN_FRAME],
    ["XHR", MAIN_FRAME],
    ["Fetch", MAIN_FRAME],
    ["Document", "child-iframe"],
  ])("fails a private-address %s sub-request without failing the render", async (type, frameId) => {
    const view = new FakeCdpView();
    const guard = await guardFor(view);

    view.request("http://metadata.internal/latest", "private", { resourceType: type, frameId });
    await guard.settled();

    expect(view.failed("private")).toBe(true);
    expect(view.continued("private")).toBe(false);
    expect(() => guard.throwIfBlocked()).not.toThrow();
    expect(guard.blockedSubrequests()).toBe(1);
    guard.close();
  });

  test("still fails the render when the main-frame document is blocked", async () => {
    const view = new FakeCdpView();
    const guard = await guardFor(view);

    view.request("https://news.example/", "start", {
      resourceType: "Document",
      frameId: MAIN_FRAME,
    });
    // A main-frame redirect pauses again as a Document in the same frame.
    view.request("http://admin.internal/", "redirect", {
      resourceType: "Document",
      frameId: MAIN_FRAME,
    });
    await guard.settled();

    expect(view.failed("redirect")).toBe(true);
    expect(() => guard.throwIfBlocked()).toThrow();
    expect(guard.blockedSubrequests()).toBe(0);
    guard.close();
  });

  test("treats a request without a resource type as a navigation", async () => {
    const view = new FakeCdpView();
    const guard = await guardFor(view);

    view.request("http://admin.internal/", "unknown", {});
    await guard.settled();

    expect(view.failed("unknown")).toBe(true);
    expect(() => guard.throwIfBlocked()).toThrow();
    guard.close();
  });

  test("treats every Document as a navigation when the main frame is unknown", async () => {
    const view = new FakeCdpView();
    view.cdp = async (method, params) => {
      view.commands.push({ method, ...(params ? { params } : {}) });
      if (method === "Page.getFrameTree") throw new Error("Page domain unavailable");
    };
    const guard = await guardFor(view);

    view.request("http://admin.internal/", "iframe", {
      resourceType: "Document",
      frameId: "child-iframe",
    });
    await guard.settled();

    expect(view.failed("iframe")).toBe(true);
    expect(() => guard.throwIfBlocked()).toThrow();
    guard.close();
  });
});

class FakeWebView {
  url = "";
  title = "Rendered title";
  closed = false;
  private readonly listeners = new Map<string, Set<(event: { data?: unknown }) => void>>();
  onNavigate: (url: string) => void = () => {};

  async navigate(url: string) {
    this.url = url;
    if (url !== "about:blank") this.onNavigate(url);
  }

  async evaluate(script: string): Promise<unknown> {
    if (script.includes("htmlLength")) return { readyState: "complete", htmlLength: 42 };
    return "<html><body>Rendered</body></html>";
  }

  async screenshot() {
    return "cG5n";
  }

  async cdp(method: string): Promise<unknown> {
    if (method === "Page.getFrameTree") return { frameTree: { frame: { id: MAIN_FRAME } } };
  }

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

describe("WebView render with blocked sub-requests", () => {
  function rendererFor(view: FakeWebView) {
    return new WebViewRenderer({
      backend: "chrome",
      factory: () => view as never,
      networkSafety: { resolver: publicOrPrivate },
    });
  }

  test("renders the page when sub-requests are blocked", async () => {
    const view = new FakeWebView();
    view.onNavigate = (url) => {
      view.emit("Fetch.requestPaused", {
        requestId: "navigation",
        request: { url },
        resourceType: "Document",
        frameId: MAIN_FRAME,
      });
      view.emit("Fetch.requestPaused", {
        requestId: "tracker",
        request: { url: `https://ads.example.com/t?${"x".repeat(2100)}` },
        resourceType: "Image",
        frameId: MAIN_FRAME,
      });
      view.emit("Fetch.requestPaused", {
        requestId: "iframe",
        request: { url: "http://router.internal/" },
        resourceType: "Document",
        frameId: "child-iframe",
      });
    };

    const result = await rendererFor(view).render({
      url: "https://news.example",
      deadline: new Deadline(1000),
    });

    expect(result.html).toContain("Rendered");
  });

  test("fails the render when the navigation itself is blocked", async () => {
    const view = new FakeWebView();
    view.onNavigate = (url) => {
      view.emit("Fetch.requestPaused", {
        requestId: "navigation",
        request: { url: url.replace("news.example", "news.internal") },
        resourceType: "Document",
        frameId: MAIN_FRAME,
      });
    };

    await expect(
      rendererFor(view).render({ url: "https://news.example", deadline: new Deadline(1000) }),
    ).rejects.toMatchObject({ code: "BLOCKED_DESTINATION" });
    expect(view.closed).toBe(true);
  });
});
