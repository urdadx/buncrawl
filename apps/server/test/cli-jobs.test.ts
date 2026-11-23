import { describe, expect, test } from "bun:test";
import type { ScrapeResponse } from "@buncrawl/contracts";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { batchBody, parseCli } from "../src/cli";
import { pageFileName, runJob, writePages } from "../src/cli-jobs";

const origin = "https://site.example";

/** A three-page site: / links to /a and /b. Robots allow everything; there is no sitemap. */
const site: Record<string, string> = {
  "/": '<html><body><main><h1>Home</h1><a href="/a">A</a> <a href="/b">B</a></main></body></html>',
  "/a": "<html><body><main><h1>Page A</h1><p>Alpha.</p></main></body></html>",
  "/b": "<html><body><main><h1>Page B</h1><p>Beta.</p></main></body></html>",
};

const fakeWorker = {
  resolver: async () => ["8.8.8.8"],
  fetchImpl: async (input: string | URL | Request) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.pathname === "/robots.txt") return new Response("User-agent: *");
    const body = site[url.pathname];
    return body === undefined
      ? new Response("Not found", { status: 404 })
      : new Response(body, { headers: { "content-type": "text/html" } });
  },
  pollMs: 20,
};

describe("parseCli job commands", () => {
  test("maps map and crawl options onto the API request", () => {
    expect(
      parseCli([
        "map",
        `${origin}/docs`,
        "--limit",
        "50",
        "--depth",
        "2",
        "--subdomains",
        "--path-prefix",
        "--json",
      ]),
    ).toEqual({
      kind: "job",
      command: "map",
      json: true,
      body: {
        url: `${origin}/docs`,
        maxUrls: 50,
        maxDepth: 2,
        includeSubdomains: true,
        pathPrefix: true,
      },
    });
    expect(
      parseCli([
        "crawl",
        origin,
        "--limit",
        "10",
        "--timeout",
        "60000",
        "--render",
        "--out",
        "pages",
        "--screenshots",
        "--page-timeout",
        "20000",
        "--db",
        "crawl.db",
      ]),
    ).toEqual({
      kind: "job",
      command: "crawl",
      json: false,
      outDir: "pages",
      dbPath: "crawl.db",
      body: {
        url: origin,
        maxPages: 10,
        timeoutMs: 60000,
        scrapeOptions: { formats: ["markdown", "screenshots"], renderJs: true, timeout: 20000 },
      },
    });
  });

  test("passes --no-path-prefix through, so a crawl can leave the start URL's path", () => {
    expect(parseCli(["crawl", `${origin}/docs`, "--no-path-prefix"])).toMatchObject({
      body: { url: `${origin}/docs`, pathPrefix: false },
    });
    expect(parseCli(["map", origin, "--path-prefix", "--no-subdomains"])).toMatchObject({
      body: { pathPrefix: true, includeSubdomains: false },
    });
    expect(parseCli(["crawl", origin])).not.toMatchObject({ body: { pathPrefix: false } });
  });

  test("defers batch URLs to the file and keeps the page options", () => {
    expect(parseCli(["batch", "urls.txt", "-f", "html", "--no-render"])).toEqual({
      kind: "job",
      command: "batch",
      json: false,
      body: {},
      pageOptions: { formats: ["html"], renderJs: false },
      source: "urls.txt",
    });
  });

  test("reports usage errors with exit code 2", () => {
    for (const args of [
      ["crawl"],
      ["map", origin, "--screenshots"],
      ["crawl", origin, "--screenshots"],
      ["crawl", origin, "--out", "d", "--screenshots", "--no-render"],
      ["crawl", origin, "--out", "d", "--format", "html"],
      ["crawl", origin, "--json"],
      ["crawl", origin, "--limit", "lots"],
      ["crawl", "ftp://site.example"],
      ["batch", "a.txt", "b.txt"],
    ]) {
      expect(parseCli(args)).toMatchObject({ kind: "help", exitCode: 2 });
    }
  });
});

describe("batchBody", () => {
  test("reads one URL per line, skipping blanks and comments", () => {
    expect(batchBody(`# list\n${origin}/a\n\n  ${origin}/b  \n`, { formats: ["html"] })).toEqual({
      body: {
        requests: [
          { url: `${origin}/a`, formats: ["html"] },
          { url: `${origin}/b`, formats: ["html"] },
        ],
      },
    });
  });

  test("adds https:// to lines without a scheme", () => {
    expect(batchBody("site.example/a\nhttp://site.example/b\n", {})).toEqual({
      body: { requests: [{ url: `${origin}/a` }, { url: "http://site.example/b" }] },
    });
  });

  test("rejects an empty list and invalid URLs", () => {
    expect(batchBody("# nothing\n", {})).toMatchObject({
      error: expect.stringContaining("No URLs"),
    });
    expect(batchBody("not a url\n", {})).toMatchObject({ error: expect.stringContaining("URL") });
  });
});

describe("pageFileName", () => {
  test("keeps names to safe characters and unique", () => {
    const taken = new Set<string>();
    expect(pageFileName(`${origin}/`, taken)).toBe("site.example");
    expect(pageFileName(`${origin}/docs/a?x=1&y=2`, taken)).toBe("site.example_docs_a_x_1_y_2");
    expect(pageFileName(`${origin}/`, taken)).toBe("site.example-2");
    expect(pageFileName(`${origin}/../../etc/passwd`, taken)).toBe("site.example_etc_passwd");
    expect(pageFileName("..", taken)).toBe("page");
  });
});

describe("runJob", () => {
  test("maps a site through the API handlers and workers", async () => {
    const result = await runJob("map", { url: origin }, { worker: fakeWorker, pollMs: 20 });
    expect(result).toMatchObject({ ok: true, state: "completed" });
    if (!result.ok) throw new Error("expected success");
    expect(result.urls.sort()).toEqual([`${origin}/`, `${origin}/a`, `${origin}/b`]);
  }, 20_000);

  test("crawls pages and writes them as Markdown files", async () => {
    const progress: number[] = [];
    const result = await runJob(
      "crawl",
      { url: origin, scrapeOptions: { formats: ["markdown"], renderJs: false } },
      { worker: fakeWorker, pollMs: 20, onProgress: (p) => progress.push(p.total) },
    );
    if (!result.ok) throw new Error(`expected success: ${result.error}`);
    expect(result.state).toBe("completed");
    expect(result.items.filter((item) => item.state === "completed")).toHaveLength(3);
    expect(progress.length).toBeGreaterThan(0);

    const dir = await mkdtemp(join(tmpdir(), "buncrawl-cli-"));
    try {
      const written = await writePages(dir, result.items);
      expect(written).toHaveLength(3);
      expect((await readdir(dir)).sort()).toEqual([
        "site.example.md",
        "site.example_a.md",
        "site.example_b.md",
      ]);
      const pageA = await Bun.file(join(dir, "site.example_a.md")).text();
      expect(pageA).toStartWith(`<!-- ${origin}/a -->`);
      expect(pageA).toContain("Alpha.");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 20_000);

  test("batch scrapes each request and reports failures per item", async () => {
    const result = await runJob(
      "batch",
      { requests: [{ url: `${origin}/a` }, { url: `${origin}/missing` }] },
      {
        pollMs: 20,
        worker: {
          pollMs: 20,
          scrapeItem: async (request): Promise<ScrapeResponse> =>
            request.url.endsWith("/missing")
              ? { success: false, code: "HTTP_ERROR", error: "Not found" }
              : {
                  success: true,
                  data: {
                    metadata: {
                      sourceURL: request.url,
                      finalURL: request.url,
                      statusCode: 200,
                      renderer: "fetch",
                    },
                    markdown: "A",
                  },
                },
        },
      },
    );
    if (!result.ok) throw new Error("expected success");
    expect(result.items.map((item) => item.state)).toEqual(["completed", "failed"]);
    expect(result.progress).toMatchObject({ succeeded: 1, failed: 1 });
  }, 20_000);

  test("returns the API's validation error without starting work", async () => {
    const result = await runJob("crawl", { url: "ftp://site.example" }, { pollMs: 20 });
    expect(result).toMatchObject({ ok: false, status: 400, code: "INVALID_REQUEST" });
  });
});
