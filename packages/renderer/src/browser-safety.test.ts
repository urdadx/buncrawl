import { describe, expect, test } from "bun:test";

import {
  installBrowserNetworkGuard,
  type CdpEvent,
  type CdpView,
} from "./browser-safety";

class FakeCdpView implements CdpView {
  readonly commands: Array<{ method: string; params?: Record<string, unknown> }> = [];
  private readonly listeners = new Map<string, Set<(event: CdpEvent) => void>>();

  async cdp(method: string, params?: Record<string, unknown>) {
    this.commands.push({ method, ...(params ? { params } : {}) });
  }

  addEventListener(type: string, listener: (event: CdpEvent) => void) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: (event: CdpEvent) => void) {
    this.listeners.get(type)?.delete(listener);
  }

  request(url: string, requestId: string = crypto.randomUUID()) {
    for (const listener of this.listeners.get("Fetch.requestPaused") ?? []) {
      listener({ data: { requestId, request: { url } } });
    }
  }
}

describe("browser network safety", () => {
  test("continues requests whose DNS answers are public", async () => {
    const view = new FakeCdpView();
    const guard = await installBrowserNetworkGuard(view, new AbortController().signal, {
      resolver: async () => ["93.184.216.34"],
    });

    view.request("https://example.com/app.js", "public");
    await guard.settled();
    guard.throwIfBlocked();

    expect(view.commands).toContainEqual({
      method: "Fetch.continueRequest",
      params: { requestId: "public" },
    });
    guard.close();
  });

  test.each([
    "http://127.0.0.1/admin",
    "http://192.168.1.20/internal.js",
    "http://169.254.169.254/latest/meta-data/",
  ])("blocks private browser destination %s", async (url) => {
    const view = new FakeCdpView();
    const guard = await installBrowserNetworkGuard(view, new AbortController().signal);

    view.request(url, "blocked");
    await guard.settled();

    expect(() => guard.throwIfBlocked()).toThrow();
    expect(view.commands).toContainEqual({
      method: "Fetch.failRequest",
      params: { requestId: "blocked", errorReason: "BlockedByClient" },
    });
    guard.close();
  });

  test("validates a redirect destination independently", async () => {
    const view = new FakeCdpView();
    const guard = await installBrowserNetworkGuard(view, new AbortController().signal, {
      resolver: async (hostname: string) =>
        hostname === "public.example" ? ["93.184.216.34"] : ["10.0.0.8"],
    });

    view.request("https://public.example/start", "initial");
    view.request("https://internal.example/redirected", "redirect");
    await guard.settled();

    expect(() => guard.throwIfBlocked()).toThrow();
    expect(view.commands).toContainEqual({
      method: "Fetch.continueRequest",
      params: { requestId: "initial" },
    });
    expect(view.commands).toContainEqual({
      method: "Fetch.failRequest",
      params: { requestId: "redirect", errorReason: "BlockedByClient" },
    });
    guard.close();
  });

  test("re-resolves repeated hostnames to detect DNS rebinding", async () => {
    const view = new FakeCdpView();
    let lookups = 0;
    const guard = await installBrowserNetworkGuard(view, new AbortController().signal, {
      resolver: async () => (++lookups === 1 ? ["93.184.216.34"] : ["127.0.0.1"]),
    });

    view.request("https://rebind.example/first", "first");
    view.request("https://rebind.example/second", "second");
    await guard.settled();

    expect(lookups).toBe(2);
    expect(() => guard.throwIfBlocked()).toThrow();
    expect(view.commands).toContainEqual({
      method: "Fetch.failRequest",
      params: { requestId: "second", errorReason: "BlockedByClient" },
    });
    guard.close();
  });
});
