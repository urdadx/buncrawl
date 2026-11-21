import { describe, expect, test } from "bun:test";
import type { BunRequest } from "bun";
import type { RendererCapabilityReport } from "@buncrawl/renderer";

import { capabilitiesRoutes } from "../src/routes/capabilities";

const report: RendererCapabilityReport = {
  checkedAt: "2026-11-21T00:00:00.000Z",
  renderers: [
    {
      name: "lightpanda",
      executable: "/opt/lightpanda/lightpanda",
      version: "1.0.5",
      capabilities: {
        available: true,
        browser: true,
        javascript: true,
        screenshots: true,
        cdp: false,
        computedStyles: false,
      },
    },
    {
      name: "webview",
      executable: null,
      version: null,
      capabilities: {
        available: false,
        browser: false,
        javascript: false,
        screenshots: false,
        cdp: false,
        computedStyles: false,
      },
      error: "No Chrome or Chromium executable found; set BUN_CHROME_PATH",
    },
  ],
  summary: {
    available: true,
    browser: true,
    javascript: true,
    screenshots: true,
    cdp: false,
    computedStyles: false,
  },
};

const handler = capabilitiesRoutes(Promise.resolve(report))["/v1/capabilities"];
const call = (method: string) =>
  handler(
    new Request("http://localhost/v1/capabilities", { method }) as BunRequest<"/v1/capabilities">,
  );

describe("GET /v1/capabilities", () => {
  test("returns the startup capability report", async () => {
    const response = await call("GET");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, data: report });
  });

  test("rejects other methods", async () => {
    const response = await call("POST");
    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("GET, OPTIONS");
  });
});
