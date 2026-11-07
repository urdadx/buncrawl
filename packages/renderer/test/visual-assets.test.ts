import { describe, expect, test } from "bun:test";
import { Deadline } from "@buncrawl/core";

import { WebViewRenderer } from "../src/webview";

/** An <img> that is either already loaded or, like an offscreen lazy image, never loads. */
function image(top: number, loaded: boolean) {
  return {
    complete: loaded,
    naturalWidth: loaded ? 100 : 0,
    getBoundingClientRect: () => ({
      top,
      left: 0,
      bottom: top + 100,
      right: 100,
      width: 100,
      height: 100,
    }),
    addEventListener: () => {},
  };
}

/** Runs the renderer's in-page asset-wait script against a minimal DOM instead of a browser. */
class AssetWaitView {
  url = "";
  title = "";
  assetWaitMs = 0;

  async navigate(url: string) {
    this.url = url;
  }

  async evaluate(script: string): Promise<unknown> {
    if (script.includes("htmlLength")) return { readyState: "complete", htmlLength: 1 };
    if (script.includes("document.scrollingElement"))
      return { scrollY: 0, scrollHeight: 800, innerHeight: 800 };
    if (script.includes("document.images")) {
      const document = {
        images: [image(10, true), image(5000, false)],
        fonts: { ready: Promise.resolve() },
      };
      const run = new Function(
        "document",
        "innerHeight",
        "innerWidth",
        "requestAnimationFrame",
        `return ${script}`,
      );
      const startedAt = performance.now();
      await run(document, 800, 1280, (callback: () => void) => setTimeout(callback, 0));
      this.assetWaitMs = performance.now() - startedAt;
      return;
    }
    if (script.includes("scrollTo")) return;
    return "<html><body>Rendered</body></html>";
  }

  async screenshot() {
    return "cG5n";
  }

  async cdp(method: string): Promise<unknown> {
    if (method === "Page.getLayoutMetrics") return { contentSize: { width: 1280, height: 800 } };
    if (method === "Page.captureScreenshot") return { data: "cG5n" };
  }

  addEventListener() {}
  removeEventListener() {}
  close() {}
}

async function screenshotAssetWait(fullPage: boolean): Promise<number> {
  const view = new AssetWaitView();
  await new WebViewRenderer({ stabilityTimeoutMs: 0, factory: () => view }).render({
    url: "https://example.com",
    deadline: new Deadline(5000),
    screenshot: { fullPage },
  });
  return view.assetWaitMs;
}

describe("screenshot asset wait", () => {
  test("a viewport screenshot does not wait for lazy images below the fold", async () => {
    expect(await screenshotAssetWait(false)).toBeLessThan(200);
  });

  test("a full-page screenshot still waits for every image, up to its time cap", async () => {
    const waited = await screenshotAssetWait(true);
    expect(waited).toBeGreaterThanOrEqual(900);
    expect(waited).toBeLessThan(2000);
  });
});
