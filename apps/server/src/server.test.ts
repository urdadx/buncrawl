import { afterAll, describe, expect, test } from "bun:test";

import { SERVER_IDLE_TIMEOUT_SECONDS } from "./server-config";
import { createScrapeHandler } from "./routes/v1/scrape";

const RESPONSE_DELAY_MS = 10_250;

const handleScrape = createScrapeHandler(async (request) => {
  await Bun.sleep(RESPONSE_DELAY_MS);
  return {
    success: true,
    data: {
      markdown: "# Delayed response",
      metadata: {
        sourceURL: request.url,
        finalURL: request.url,
        statusCode: 200,
        renderer: "fetch",
      },
    },
  };
});

const server = Bun.serve({
  port: 0,
  idleTimeout: SERVER_IDLE_TIMEOUT_SECONDS,
  routes: {
    "/v1/scrape": {
      POST: handleScrape,
    },
  },
});

afterAll(async () => {
  await server.stop(true);
});

describe("server request timeout", () => {
  test(
    "keeps a scrape connection open for longer than Bun's 10-second default",
    async () => {
      const response = await fetch(new URL("/v1/scrape", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: "https://example.com" }),
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ success: true });
    },
    15_000,
  );
});
