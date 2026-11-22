import { describe, expect, test } from "bun:test";
import type { FetchPageResult } from "@buncrawl/fetcher";

import { scrape, scrapeCacheKey } from "../src";

const page = `<html><body><main><h1>Catalogue</h1><p>${"Intro text. ".repeat(40)}</p>
  <div class="item"><h2>Kettle</h2><a href="/p/kettle">view</a></div>
  <div class="item"><h2>Toaster</h2><a href="/p/toaster">view</a></div>
</main></body></html>`;

function fetched(): FetchPageResult {
  return {
    sourceUrl: "https://shop.example/",
    finalUrl: "https://shop.example/",
    statusCode: 200,
    headers: new Headers({ "content-type": "text/html" }),
    contentType: "text/html",
    charset: "utf-8",
    body: page,
    rawBody: new TextEncoder().encode(page),
    elapsedMs: 1,
    redirectCount: 0,
  };
}

describe("json scrape format", () => {
  test("returns selector results in data.json alongside other formats", async () => {
    const response = await scrape(
      {
        url: "https://shop.example/",
        formats: [
          "markdown",
          {
            type: "json",
            selectors: {
              heading: "h1",
              items: {
                selector: ".item",
                all: true,
                fields: { name: "h2", url: { selector: "a", attribute: "href" } },
              },
            },
          },
        ],
      },
      {},
      { fetch: async () => fetched() },
    );
    if (!response.success) throw new Error(response.error);
    expect(response.data.markdown).toContain("# Catalogue");
    expect(response.data.json).toEqual({
      heading: "Catalogue",
      items: [
        { name: "Kettle", url: "https://shop.example/p/kettle" },
        { name: "Toaster", url: "https://shop.example/p/toaster" },
      ],
    });
  });

  test("rejects an invalid CSS selector before fetching anything", async () => {
    let fetches = 0;
    const response = await scrape(
      { url: "https://shop.example/", formats: [{ type: "json", selectors: { broken: "div[" } }] },
      {},
      {
        fetch: async () => {
          fetches++;
          return fetched();
        },
      },
    );
    expect(response).toMatchObject({ success: false, code: "INVALID_REQUEST" });
    expect(fetches).toBe(0);
  });

  test("caches results per selector set", () => {
    const key = (selectors: Record<string, string>) =>
      scrapeCacheKey({ url: "https://shop.example/", formats: [{ type: "json", selectors }] });
    expect(key({ title: "h1" })).not.toBe(key({ title: "h2" }));
    expect(key({ title: "h1" })).toBe(key({ title: "h1" }));
    expect(
      scrapeCacheKey({
        url: "https://shop.example/",
        formats: ["markdown", { type: "json", selectors: { title: "h1" } }],
      }),
    ).toBe(
      scrapeCacheKey({
        url: "https://shop.example/",
        formats: [{ type: "json", selectors: { title: "h1" } }, "markdown"],
      }),
    );
  });
});
