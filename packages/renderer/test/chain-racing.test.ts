import { describe, expect, test } from "bun:test";
import { Deadline } from "@buncrawl/core";

import { RendererChain } from "../src/chain";
import type { RenderRequest, Renderer, RenderResult } from "../src/renderer";

/** A renderer that answers after `delayMs`, recording when each render started. */
class TimedRenderer implements Renderer {
  startedAt: number[] = [];

  constructor(
    readonly name: string,
    private readonly delayMs: number,
    private readonly outcome: "ok" | Error = "ok",
    private readonly idle = true,
  ) {}

  capabilities() {
    return { available: true, browser: true, javascript: true, screenshots: true, cdp: false };
  }

  hasIdleCapacity() {
    return this.idle;
  }

  async render(_request: RenderRequest): Promise<RenderResult> {
    this.startedAt.push(performance.now());
    await Bun.sleep(this.delayMs);
    if (this.outcome instanceof Error) throw this.outcome;
    return {
      sourceUrl: "https://example.com",
      finalUrl: "https://example.com",
      title: this.name,
      html: `<html>${this.name}</html>`,
      renderer: this.name,
      elapsedMs: this.delayMs,
    };
  }
}

const request = () => ({ url: "https://example.com", deadline: new Deadline(5000) });
const acceptOnly =
  (...names: string[]) =>
  (result: RenderResult) =>
    names.includes(result.renderer);

async function timed<T>(work: Promise<T>) {
  const startedAt = performance.now();
  const value = await work;
  return { value, elapsed: performance.now() - startedAt };
}

describe("RendererChain racing", () => {
  test("stays sequential by default: the fallback starts only after a rejection", async () => {
    const lightpanda = new TimedRenderer("lightpanda", 40);
    const webview = new TimedRenderer("webview", 40);
    const chain = new RendererChain([lightpanda, webview]);
    const { value, elapsed } = await timed(
      chain.renderWithFallback(request(), acceptOnly("webview")),
    );
    expect(value.renderer).toBe("webview");
    expect(webview.startedAt[0]! - lightpanda.startedAt[0]!).toBeGreaterThanOrEqual(35);
    expect(elapsed).toBeGreaterThanOrEqual(75);
  });

  test("racing returns the first accepted result without waiting for the primary", async () => {
    const lightpanda = new TimedRenderer("lightpanda", 200);
    const webview = new TimedRenderer("webview", 30);
    const chain = new RendererChain([lightpanda, webview]);
    const { value, elapsed } = await timed(
      chain.renderWithFallback(request(), acceptOnly("webview"), { startFallbackAfterMs: 0 }),
    );
    expect(value.renderer).toBe("webview");
    expect(elapsed).toBeLessThan(150);
  });

  test("an accepted primary still wins when it finishes first", async () => {
    const lightpanda = new TimedRenderer("lightpanda", 20);
    const webview = new TimedRenderer("webview", 200);
    const chain = new RendererChain([lightpanda, webview]);
    const { value, elapsed } = await timed(
      chain.renderWithFallback(request(), () => true, { startFallbackAfterMs: 0 }),
    );
    expect(value.renderer).toBe("lightpanda");
    expect(elapsed).toBeLessThan(150);
  });

  test("a rejected result waits for the renderer still running", async () => {
    const lightpanda = new TimedRenderer("lightpanda", 10);
    const webview = new TimedRenderer("webview", 60);
    const chain = new RendererChain([lightpanda, webview]);
    const value = await chain.renderWithFallback(request(), acceptOnly("webview"), {
      startFallbackAfterMs: 0,
    });
    expect(value.renderer).toBe("webview");
    expect(webview.startedAt).toHaveLength(1);
  });

  test("returns the latest renderer's result when none is accepted", async () => {
    const chain = new RendererChain([
      new TimedRenderer("lightpanda", 50),
      new TimedRenderer("webview", 10),
    ]);
    const value = await chain.renderWithFallback(request(), () => false, {
      startFallbackAfterMs: 0,
    });
    expect(value.renderer).toBe("webview");
  });

  test("does not race a fallback renderer that has no idle capacity", async () => {
    const lightpanda = new TimedRenderer("lightpanda", 40);
    const webview = new TimedRenderer("webview", 10, "ok", false);
    const chain = new RendererChain([lightpanda, webview]);
    await chain.renderWithFallback(request(), acceptOnly("webview"), { startFallbackAfterMs: 0 });
    // Started only once the primary was rejected, i.e. sequential fallback.
    expect(webview.startedAt[0]! - lightpanda.startedAt[0]!).toBeGreaterThanOrEqual(35);
  });

  test("a terminal error stops the race immediately", async () => {
    const blocked = Object.assign(new Error("private address"), { code: "BLOCKED_DESTINATION" });
    const chain = new RendererChain([
      new TimedRenderer("lightpanda", 10, blocked),
      new TimedRenderer("webview", 200),
    ]);
    const { value: error, elapsed } = await timed(
      chain
        .renderWithFallback(request(), () => true, { startFallbackAfterMs: 0 })
        .catch((caught: unknown) => caught),
    );
    expect((error as { code: string }).code).toBe("BLOCKED_DESTINATION");
    expect(elapsed).toBeLessThan(150);
  });

  test("a delayed race starts the fallback only if the primary is still running", async () => {
    const fastPrimary = new TimedRenderer("lightpanda", 10);
    const unused = new TimedRenderer("webview", 10);
    await new RendererChain([fastPrimary, unused]).renderWithFallback(request(), () => true, {
      startFallbackAfterMs: 50,
    });
    expect(unused.startedAt).toHaveLength(0);

    const slowPrimary = new TimedRenderer("lightpanda", 300);
    const hedge = new TimedRenderer("webview", 10);
    const { value } = await timed(
      new RendererChain([slowPrimary, hedge]).renderWithFallback(request(), () => true, {
        startFallbackAfterMs: 50,
      }),
    );
    expect(value.renderer).toBe("webview");
    expect(hedge.startedAt[0]! - slowPrimary.startedAt[0]!).toBeGreaterThanOrEqual(45);
  });
});
