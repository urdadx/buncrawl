import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import {
  isBrowserOnlyFormat,
  isJsonFormat,
  isScreenshotFormat,
  scrapeRequestSchema,
  type ScrapeFormat,
} from "../src";

const parse = (formats: unknown[]) =>
  v.safeParse(scrapeRequestSchema, { url: "https://example.com", formats });

const nest = (depth: number): Record<string, unknown> =>
  depth === 1 ? { leaf: "p" } : { level: { selector: "div", fields: nest(depth - 1) } };

describe("json format validation", () => {
  test("accepts strings, attributes, lists and nested records", () => {
    const result = parse([
      {
        type: "json",
        selectors: {
          title: "h1",
          image: { selector: "meta[property='og:image']", attribute: "content" },
          products: {
            selector: ".product",
            all: true,
            fields: { name: ".name", url: { selector: "a", attribute: "href" } },
          },
        },
      },
    ]);
    expect(result.success).toBe(true);
  });

  test("rejects empty, malformed and oversized selector maps", () => {
    for (const selectors of [
      {},
      { "has space": "h1" },
      { title: "" },
      { title: { attribute: "href" } },
      { title: { selector: "a", attribute: "bad attr" } },
      Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`f${i}`, "p"])),
    ])
      expect(parse([{ type: "json", selectors }]).success).toBe(false);
  });

  test("allows four levels of nesting but not five", () => {
    expect(parse([{ type: "json", selectors: nest(4) }]).success).toBe(true);
    expect(parse([{ type: "json", selectors: nest(5) }]).success).toBe(false);
  });

  test("treats json as one unique format alongside screenshots", () => {
    const json = { type: "json", selectors: { title: "h1" } };
    expect(parse(["markdown", "screenshots", json]).success).toBe(true);
    expect(parse([json, { type: "json", selectors: { other: "h2" } }]).success).toBe(false);
  });

  test("is neither a screenshot nor a browser-only format", () => {
    const json: ScrapeFormat = { type: "json", selectors: { title: "h1" } };
    expect(isJsonFormat(json)).toBe(true);
    expect(isScreenshotFormat(json)).toBe(false);
    expect(isBrowserOnlyFormat(json)).toBe(false);
    expect(isScreenshotFormat({ type: "screenshot" })).toBe(true);
  });
});
