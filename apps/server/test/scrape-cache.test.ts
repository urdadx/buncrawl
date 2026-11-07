import { expect, test } from "bun:test";
import { createDb, createScrapeCache, migrateDb } from "@buncrawl/db";
import { scrape } from "@buncrawl/scrape";

import { createScrapeHandler } from "../src/routes/v1/scrape";

const html = `<html><body><main><h1>Cached page</h1><p>${"Body text. ".repeat(40)}</p></main></body></html>`;

test("serves a repeat scrape from the SQLite cache when maxAge allows it", async () => {
  const db = createDb({ DATABASE_URL: ":memory:" });
  await migrateDb(db);
  const cache = createScrapeCache(db);
  let fetches = 0;
  const handle = createScrapeHandler((request, context) =>
    scrape(request, context, {
      cache,
      fetch: async (input) => {
        fetches++;
        const url = String(input);
        return {
          sourceUrl: url,
          finalUrl: url,
          statusCode: 200,
          headers: new Headers({ "content-type": "text/html" }),
          contentType: "text/html",
          charset: "utf-8",
          body: html,
          rawBody: new TextEncoder().encode(html),
          elapsedMs: 1,
          redirectCount: 0,
        };
      },
    }),
  );
  const post = async (body: unknown) => {
    const response = await handle(
      new Request("http://localhost/v1/scrape", { method: "POST", body: JSON.stringify(body) }),
    );
    return { status: response.status, body: (await response.json()) as any };
  };

  const miss = await post({ url: "https://example.com/page", maxAge: 60_000 });
  expect(miss.status).toBe(200);
  expect(miss.body.data.metadata.cacheState).toBe("miss");

  const hit = await post({ url: "https://example.com/page", maxAge: 60_000, timeout: 5_000 });
  expect(hit.body.data.metadata.cacheState).toBe("hit");
  expect(hit.body.data.markdown).toBe(miss.body.data.markdown);
  expect(fetches).toBe(1);

  expect((await post({ url: "https://example.com/page", maxAge: -1 })).status).toBe(400);
});
