/**
 * Crawl-path overhead benchmark: crawls a synthetic in-memory site through the real discovery
 * worker and a real SQLite file, so the numbers reflect frontier, robots and progress bookkeeping
 * rather than network latency.
 *
 *   bun packages/jobs/bench/crawl.bench.ts [--pages 300] [--links 60] [--runs 3] [--mode map|crawl]
 */
import { createDb, enqueueJob, getCrawlFrontier, getJob, migrateDb } from "@buncrawl/db";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { crawlJobLimits, DiscoveryWorker } from "../src";

const args = new Map<string, string>();
for (let i = 2; i < Bun.argv.length; i += 2) args.set(Bun.argv[i]!.replace(/^--/, ""), Bun.argv[i + 1]!);
const pages = Number(args.get("pages") ?? 300);
const linksPerPage = Number(args.get("links") ?? 60);
const runs = Number(args.get("runs") ?? 3);
const mode = (args.get("mode") ?? "map") as "map" | "crawl";
const origin = "https://bench.example";

/** Deterministic site: page i links to the next `linksPerPage` pages (wrapping), like a dense nav. */
function page(index: number): string {
  const links = Array.from(
    { length: linksPerPage },
    (_, offset) => `<a href="/p/${(index + offset + 1) % pages}">Page ${offset}</a>`,
  ).join("");
  return `<html><head><title>Page ${index}</title></head><body><main><h1>Page ${index}</h1><p>${"Body text. ".repeat(60)}</p><nav>${links}</nav></main></body></html>`;
}

const fetchImpl = async (input: string | URL | Request) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.pathname === "/robots.txt") return new Response("User-agent: *\nDisallow: /private");
  if (url.pathname === "/sitemap.xml") return new Response("", { status: 404 });
  const index = url.pathname === "/" ? 0 : Number(url.pathname.split("/").pop());
  return new Response(page(index), { headers: { "content-type": "text/html" } });
};

const durations: number[] = [];
for (let run = 1; run <= runs; run++) {
  const dir = await mkdtemp(join(tmpdir(), "crawl-bench-"));
  const db = createDb({ DATABASE_URL: `file:${join(dir, "bench.db")}` });
  await migrateDb(db);
  const submission = { type: mode, url: origin, maxDepth: 10, ...(mode === "map" ? { maxUrls: pages } : { maxPages: pages }) } as const;
  const limits = crawlJobLimits(submission);
  const { job } = await enqueueJob(db, {
    submission,
    limits: { maxItems: limits.maxPages, timeoutMs: limits.maxElapsedMs },
  });
  const worker = new DiscoveryWorker({
    db,
    dispatch: { listen: async () => {}, close: () => {} },
    pollMs: 10,
    resolver: async () => ["93.184.216.34"],
    fetchImpl,
    ...(mode === "crawl"
      ? {
          scrapeItem: async (request) => ({
            success: true,
            data: { markdown: "# page", metadata: { sourceURL: request.url, finalURL: request.url, statusCode: 200, renderer: "fetch" } },
          }),
        }
      : {}),
  });
  const startedAt = performance.now();
  await worker.start();
  while (!["completed", "failed", "cancelled"].includes((await getJob(db, job.id))!.state)) await Bun.sleep(5);
  const elapsed = performance.now() - startedAt;
  await worker.stop();
  const done = (await getCrawlFrontier(db, job.id)).filter((row) => row.state === "completed").length;
  durations.push(elapsed);
  console.info(`${mode} run ${run}: ${done} pages in ${elapsed.toFixed(0)}ms (${((elapsed / done) | 0)}ms/page)`);
  db.$client.close();
  await rm(dir, { recursive: true, force: true });
}
durations.sort((a, b) => a - b);
console.info(`median ${durations[durations.length >> 1]!.toFixed(0)}ms for ${pages} pages x ${linksPerPage} links`);
process.exit(0);
