import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import { scrapeRequestSchema } from "./scrape";

describe("scrapeRequestSchema", () => {
  test("accepts a valid request", () => {
    expect(
      v.safeParse(scrapeRequestSchema, {
        url: "https://example.com/article",
        formats: ["markdown", "links"],
        renderJs: "auto",
        onlyMainContent: true,
        timeout: 30_000,
      }).success,
    ).toBe(true);
  });

  test.each([
    [{ url: "ftp://example.com" }, "URL must use HTTP or HTTPS"],
    [{ url: "https://example.com", formats: [] }, "At least one format is required"],
    [{ url: "https://example.com", formats: ["markdown", "markdown"] }, "Formats must be unique"],
    [{ url: "https://example.com", timeout: 120_001 }, "Timeout cannot exceed 120000ms"],
    [{ url: "https://example.com", typo: true }, 'Invalid key: Expected never but received "typo"'],
  ])("rejects invalid input", (input, message) => {
    const result = v.safeParse(scrapeRequestSchema, input);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.issues.map((issue) => issue.message)).toContain(message);
  });
});
