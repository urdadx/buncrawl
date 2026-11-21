import { afterAll, describe, expect, test } from "bun:test";
import { Deadline } from "@buncrawl/core";

import { checkRendererCapabilities } from "../src/capabilities";
import { IsolatedRenderer, isolatedRendererConfigs } from "../src/isolated";
import type { RenderRequest, RenderResult } from "../src/renderer";

/**
 * Real-browser smoke tests for CI and the production image: they render a local fixture through
 * the isolated worker pool, exactly as scrapes do, and never touch the public internet. Set
 * BUNCRAWL_RUN_BROWSER_SMOKE=1 to run them; a missing browser then fails instead of skipping.
 */
const smoke = process.env.BUNCRAWL_RUN_BROWSER_SMOKE === "1" ? describe : describe.skip;

const RENDER_TIMEOUT_MS = 30_000;
const TEST_TIMEOUT_MS = 60_000;

const fixture = await Bun.file(new URL("./fixtures/smoke.html", import.meta.url)).bytes();
const fixtureUrl = `data:text/html;base64,${fixture.toBase64()}`;
const blankUrl = "data:text/html,<!doctype html><title>Blank</title><body></body>";

smoke("browser smoke", () => {
  // The same worker configurations scrapes use, including BUNCRAWL_CHROME_NO_SANDBOX.
  const configs = isolatedRendererConfigs();
  const lightpanda = new IsolatedRenderer(
    configs.lightpanda ?? { type: "lightpanda" },
    { available: true, browser: true, javascript: true, screenshots: true, cdp: false },
    { maxWorkers: 1, retryCrashes: 0 },
  );
  const webview = new IsolatedRenderer(
    configs.webview,
    {
      available: true,
      browser: true,
      javascript: true,
      screenshots: true,
      cdp: true,
      computedStyles: true,
    },
    { maxWorkers: 1, retryCrashes: 0 },
  );
  // A loopback service stands in for an internal one the browsers must never reach.
  let internalRequests = 0;
  const internal = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => {
      internalRequests += 1;
      return new Response("<title>Internal</title><p>internal secret</p>", {
        headers: { "content-type": "text/html" },
      });
    },
  });

  afterAll(async () => {
    lightpanda.close();
    webview.close();
    await internal.stop(true);
  });

  const render = (
    renderer: IsolatedRenderer,
    request: Omit<RenderRequest, "deadline">,
  ): Promise<RenderResult> =>
    renderer.render({ ...request, deadline: new Deadline(RENDER_TIMEOUT_MS) });

  test("the capability check finds both browsers", async () => {
    const report = await checkRendererCapabilities();
    for (const renderer of report.renderers) {
      expect({ name: renderer.name, error: renderer.error }).toEqual({
        name: renderer.name,
        error: undefined,
      });
      expect(renderer.version).toBeTruthy();
    }
    expect(report.summary).toEqual({
      available: true,
      browser: true,
      javascript: true,
      screenshots: true,
      cdp: true,
      computedStyles: true,
    });
  });

  test(
    "Lightpanda runs the fixture's script and takes a screenshot",
    async () => {
      const rendered = await render(lightpanda, { url: fixtureUrl });
      expect(rendered.renderer).toBe("lightpanda");
      expect(rendered.title).toBe("Smokebrand fixture");
      expect(rendered.html).toContain("Rendered by JavaScript");

      const captured = await render(lightpanda, { url: fixtureUrl, screenshot: true });
      expect(captured.screenshot?.mimeType).toBe("image/png");
      const { format, width, height } = await screenshotImage(captured).metadata();
      expect(format).toBe("png");
      expect(width).toBeGreaterThan(0);
      expect(height).toBeGreaterThan(0);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "Chromium renders the fixture with real fonts, a screenshot and branding",
    async () => {
      const rendered = await render(webview, {
        url: fixtureUrl,
        screenshot: true,
        branding: true,
      });
      expect(rendered.renderer).toBe("webview");
      expect(rendered.title).toBe("Smokebrand fixture");
      expect(rendered.html).toContain("Rendered by JavaScript");

      const metadata = await screenshotImage(rendered).metadata();
      expect(metadata).toMatchObject({ format: "png", width: 1280 });
      expect(metadata.height).toBeGreaterThan(0);
      // Drawn text makes the PNG far larger than an empty page; without usable fonts Chromium
      // draws no glyphs and the two compress to about the same size.
      const blank = await render(webview, { url: blankUrl, screenshot: true });
      expect(screenshotBytes(rendered)).toBeGreaterThan(screenshotBytes(blank) * 3);

      expect(rendered.branding).toMatchObject({
        colorScheme: "light",
        brandName: "Smokebrand",
        colors: {
          primary: "#C2410C",
          background: "#FFFFFF",
          textPrimary: "#1F2937",
          link: "#0E7490",
        },
        components: { buttonPrimary: { background: "#C2410C", textColor: "#FFFFFF" } },
        typography: {
          fontFamilies: { primary: "Liberation Sans", heading: "Liberation Serif" },
        },
      });
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "both browsers refuse to contact a private-network address",
    async () => {
      for (const renderer of [webview, lightpanda]) {
        // The browser works, so a failure below is the network guard and not a dead browser.
        expect((await render(renderer, { url: fixtureUrl })).html).toContain("Rendered by");
        const leaked = await render(renderer, {
          url: `http://127.0.0.1:${internal.port}/`,
        }).then(
          (result) => result.html.includes("internal secret"),
          () => false,
        );
        expect({ renderer: renderer.name, leaked, internalRequests }).toEqual({
          renderer: renderer.name,
          leaked: false,
          internalRequests: 0,
        });
      }
    },
    TEST_TIMEOUT_MS,
  );
});

function screenshotImage(result: RenderResult): Bun.Image {
  expect(result.screenshot).toBeDefined();
  return new Bun.Image(Uint8Array.fromBase64(result.screenshot!.data));
}

function screenshotBytes(result: RenderResult): number {
  return Uint8Array.fromBase64(result.screenshot!.data).byteLength;
}
