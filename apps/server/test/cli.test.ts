import { describe, expect, test } from "bun:test";
import type { ScrapeResponse } from "@buncrawl/contracts";

import { formatOutput, parseCli, type CliCommand } from "../src/cli";

describe("parseCli", () => {
  test("serves by default and with `serve`", () => {
    expect(parseCli([])).toEqual({ kind: "serve" });
    expect(parseCli(["serve"])).toEqual({ kind: "serve" });
  });

  test("scrapes with `scrape <url>` or a bare URL", () => {
    const expected: CliCommand = {
      kind: "scrape",
      request: { url: "https://example.com", formats: ["markdown"] },
      json: false,
    };
    expect(parseCli(["scrape", "https://example.com"])).toEqual(expected);
    expect(parseCli(["https://example.com"])).toEqual(expected);
  });

  test("maps options onto the scrape request", () => {
    expect(
      parseCli([
        "https://example.com",
        "-f",
        "html",
        "--format",
        "links",
        "--render",
        "--full-page",
        "--wait",
        "500",
        "--timeout",
        "45000",
        "--screenshot",
        "page.png",
      ]),
    ).toEqual({
      kind: "scrape",
      request: {
        url: "https://example.com",
        formats: ["html", "links", "screenshots"],
        renderJs: true,
        onlyMainContent: false,
        waitForMs: 500,
        timeout: 45000,
      },
      screenshotPath: "page.png",
      json: true,
    });
    expect(parseCli(["https://example.com", "--no-render"])).toMatchObject({
      request: { renderJs: false },
    });
  });

  test("reports usage errors with exit code 2", () => {
    for (const args of [
      ["crawl"],
      ["scrape"],
      ["scrape", "ftp://example.com"],
      ["https://example.com", "--format", "pdf"],
      ["https://example.com", "--timeout", "soon"],
      ["https://example.com", "--screenshot", "a.png", "--no-render"],
      ["https://example.com", "--unknown"],
    ]) {
      expect(parseCli(args)).toMatchObject({ kind: "help", exitCode: 2 });
    }
    expect(parseCli(["--help"])).toEqual({ kind: "help", exitCode: 0 });
  });
});

describe("formatOutput", () => {
  const response: ScrapeResponse = {
    success: true,
    data: {
      metadata: { sourceURL: "https://example.com" },
      markdown: "# Title\n\n",
      links: ["https://example.com/a", "https://example.com/b"],
    } as never,
  };

  test("prints a single text format as-is", () => {
    const markdown = parseCli(["https://example.com"]);
    const links = parseCli(["https://example.com", "-f", "links"]);
    if (markdown.kind !== "scrape" || links.kind !== "scrape") throw new Error("expected scrape");
    expect(formatOutput(response, markdown)).toBe("# Title\n");
    expect(formatOutput(response, links)).toBe("https://example.com/a\nhttps://example.com/b\n");
  });

  test("prints JSON for --json and for failures", () => {
    const command = parseCli(["https://example.com", "--json"]);
    if (command.kind !== "scrape") throw new Error("expected scrape");
    expect(JSON.parse(formatOutput(response, command))).toEqual(response);
    const failure: ScrapeResponse = { success: false, code: "FETCH_FAILED", error: "nope" };
    const plain = parseCli(["https://example.com"]);
    if (plain.kind !== "scrape") throw new Error("expected scrape");
    expect(JSON.parse(formatOutput(failure, plain))).toEqual(failure);
  });
});
