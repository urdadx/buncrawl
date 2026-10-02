import { describe, expect, test } from "bun:test";

import { createScrapeHandler } from "./scrape";

describe("POST /v1/scrape", () => {
  test("validates the request body", async () => {
    const handler = createScrapeHandler(async () => {
      throw new Error("must not run");
    });
    const response = await handler(
      new Request("http://localhost/v1/scrape", {
        method: "POST",
        body: JSON.stringify({ url: "file:///etc/passwd" }),
        headers: { "content-type": "application/json" },
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ success: false, code: "INVALID_REQUEST" });
  });

  test("returns successful scrape output", async () => {
    const handler = createScrapeHandler(async (request) => ({
      success: true,
      data: {
        markdown: `# ${request.url}`,
        metadata: {
          sourceURL: request.url,
          finalURL: request.url,
          statusCode: 200,
          renderer: "fetch",
        },
      },
    }));
    const response = await handler(
      new Request("http://localhost/v1/scrape", {
        method: "POST",
        body: JSON.stringify({ url: "https://example.com" }),
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true });
  });

  test("maps pipeline errors to HTTP status codes", async () => {
    const handler = createScrapeHandler(async () => ({
      success: false,
      code: "DEADLINE_EXCEEDED",
      error: "timed out",
    }));
    const response = await handler(
      new Request("http://localhost/v1/scrape", {
        method: "POST",
        body: JSON.stringify({ url: "https://example.com" }),
      }),
    );

    expect(response.status).toBe(504);
  });

  test("rejects non-POST methods", async () => {
    const response = await createScrapeHandler()(new Request("http://localhost/v1/scrape"));
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST, OPTIONS");
  });
});
