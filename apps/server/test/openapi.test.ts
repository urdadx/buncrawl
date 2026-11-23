import { describe, expect, test } from "bun:test";
import { jobSubmissionResponseSchema, type ScrapeResponse } from "@buncrawl/contracts";
import { createDb, migrateDb } from "@buncrawl/db";
import type { RendererCapabilityReport } from "@buncrawl/renderer";
import * as v from "valibot";

import {
  apiErrorSchema,
  batchScrapeStatusSchema,
  buildOpenApiDocument,
  capabilitiesSchema,
  crawlStatusSchema,
  jobCancelledSchema,
  mapStatusSchema,
  scrapeErrorSchema,
  scrapeSuccessSchema,
} from "../src/openapi";
import { createRoutes } from "../src/routes";
import { capabilitiesRoutes } from "../src/routes/capabilities";
import { createBatchScrapeHandler } from "../src/routes/v1/batch-scrape";
import { createDiscoveryHandler } from "../src/routes/v1/discovery";
import { createScrapeHandler } from "../src/routes/v1/scrape";

const report: RendererCapabilityReport = {
  checkedAt: "2026-11-23T00:00:00.000Z",
  renderers: [
    {
      name: "lightpanda",
      executable: "/usr/bin/lightpanda",
      version: "1.0.5",
      capabilities: {
        available: true,
        browser: true,
        javascript: true,
        screenshots: true,
        cdp: false,
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
      },
      error: "No Chrome",
    },
  ],
  summary: { available: true, browser: true, javascript: true, screenshots: true, cdp: false },
};

type ObjectSchema = v.ObjectSchema<v.ObjectEntries, undefined>;

/** The body matches the schema, and has no top-level field the schema doesn't document. */
async function expectDocumented(schema: ObjectSchema, response: Response) {
  const body = (await response.json()) as Record<string, unknown>;
  const result = v.safeParse(schema, body);
  if (!result.success) throw new Error(JSON.stringify({ body, issues: v.flatten(result.issues) }));
  expect(Object.keys(body).filter((key) => !(key in schema.entries))).toEqual([]);
  return body;
}

function request(path: string, method = "GET", body?: unknown) {
  return new Request(`http://localhost${path}`, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

test("apps/docs/openapi.json is up to date (run `pnpm --filter server openapi`)", async () => {
  const committed = await Bun.file(new URL("../../docs/openapi.json", import.meta.url)).json();
  expect(committed).toEqual(buildOpenApiDocument());
});

test("every v1 route the server registers is documented", () => {
  const db = createDb({ DATABASE_URL: ":memory:" });
  const routes = Object.keys(createRoutes(db, Promise.resolve(report)))
    // tRPC is the dashboard's; /v2 is the Firecrawl-compatible API, documented separately.
    .filter((path) => !path.startsWith("/trpc") && !path.startsWith("/v2"))
    .map((path) => path.replace(/:(\w+)/g, "{$1}"));
  const documented = Object.keys(buildOpenApiDocument().paths as object);
  expect(routes.filter((path) => !documented.includes(path))).toEqual([]);
  expect(documented.filter((path) => !routes.includes(path))).toEqual([]);
  db.$client.close();
});

describe("handler responses match the documented schemas", () => {
  test("scrape", async () => {
    const response: ScrapeResponse = {
      success: true,
      warning: "Browser rendering did not improve the fetched content",
      data: {
        metadata: {
          sourceURL: "https://example.com",
          finalURL: "https://example.com/",
          title: "Example",
          statusCode: 200,
          contentType: "text/html",
          renderer: "fetch",
        },
        markdown: "# Example",
        links: ["https://example.com/a"],
        json: { title: "Example", tags: ["a", null] },
      },
    };
    const handler = createScrapeHandler(async () => response);
    await expectDocumented(
      scrapeSuccessSchema,
      await handler(request("/v1/scrape", "POST", { url: "https://example.com" })),
    );
    const invalid = await handler(request("/v1/scrape", "POST", { url: "nope" }));
    expect(invalid.status).toBe(400);
    await expectDocumented(scrapeErrorSchema, invalid);
  });

  test("crawl, map and batch scrape jobs", async () => {
    const db = createDb({ DATABASE_URL: ":memory:" });
    await migrateDb(db);
    const notify = async () => undefined;
    const kinds = [
      {
        path: "/v1/crawl",
        handler: createDiscoveryHandler(db, "crawl", notify),
        status: crawlStatusSchema,
        body: { url: "https://example.com", scrapeOptions: { formats: ["markdown"] } },
      },
      {
        path: "/v1/map",
        handler: createDiscoveryHandler(db, "map", notify),
        status: mapStatusSchema,
        body: { url: "https://example.com", maxUrls: 10 },
      },
      {
        path: "/v1/batch/scrape",
        handler: createBatchScrapeHandler(db, notify),
        status: batchScrapeStatusSchema,
        body: { requests: [{ url: "https://example.com" }, { url: "https://example.org" }] },
      },
    ];
    for (const kind of kinds) {
      const submitted = await kind.handler(request(kind.path, "POST", kind.body));
      expect(submitted.status).toBe(202);
      const { jobId } = (await expectDocumented(
        jobSubmissionResponseSchema as unknown as ObjectSchema,
        submitted,
      )) as { jobId: string };

      await expectDocumented(
        kind.status,
        await kind.handler(request(`${kind.path}/${jobId}`), jobId),
      );
      await expectDocumented(
        jobCancelledSchema,
        await kind.handler(request(`${kind.path}/${jobId}`, "DELETE"), jobId),
      );

      const missing = `job_${"0".repeat(32)}`;
      const notFound = await kind.handler(request(`${kind.path}/${missing}`), missing);
      expect(notFound.status).toBe(404);
      await expectDocumented(apiErrorSchema, notFound);
    }
    db.$client.close();
  });

  test("capabilities", async () => {
    const routes = capabilitiesRoutes(Promise.resolve(report));
    await expectDocumented(
      capabilitiesSchema,
      await routes["/v1/capabilities"](request("/v1/capabilities") as never),
    );
  });
});
