import { Deadline } from "@buncrawl/core";
import { expect, test } from "bun:test";

import { LightpandaRenderer } from "./lightpanda";
import { WebViewRenderer } from "./webview";

const browserTest = process.env.BUNCRAWL_RUN_BROWSER_INTEGRATION === "1" ? test : test.skip;

browserTest("renders a real page with Lightpanda", async () => {
  const renderer = new LightpandaRenderer({ waitMs: 500 });
  expect(renderer.capabilities().available).toBe(true);

  const result = await renderer.render({
    url: "https://example.com",
    deadline: new Deadline(15_000),
  });

  expect(result.renderer).toBe("lightpanda");
  expect(result.html.length).toBeGreaterThan(100);
});

browserTest("renders a real page with Chromium WebView", async () => {
  const renderer = new WebViewRenderer({ backend: "chrome" });
  expect(renderer.capabilities().available).toBe(true);

  const result = await renderer.render({
    url: "https://example.com",
    deadline: new Deadline(15_000),
  });

  expect(result.renderer).toBe("webview");
  expect(result.html.length).toBeGreaterThan(100);
});
