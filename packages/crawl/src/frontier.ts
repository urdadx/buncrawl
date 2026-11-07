import { Deadline } from "@buncrawl/core";
import { enqueueCrawlUrl, type CrawlLimits, type Database } from "@buncrawl/db";
import type { FetchPageOptions } from "@buncrawl/fetcher";

import { loadRobots, robotsAllows } from "./robots";
import { crawlUrlDepth, discoveredCrawlUrls, type CrawlScope } from "./urls";

/** Accept only in-scope, robots-allowed links; SQLite enforces canonical deduplication and budgets. */
export async function queueDiscoveredLinks(
  db: Database,
  jobId: string,
  links: readonly string[],
  base: string,
  options: {
    scope: CrawlScope;
    limits: CrawlLimits;
    userAgent: string;
    deadline: Deadline;
    fetchImpl?: FetchPageOptions["fetchImpl"];
    resolver?: FetchPageOptions["resolver"];
  },
): Promise<string[]> {
  const discovered = discoveredCrawlUrls(links, base, options.scope, options.limits.maxDepth);

  const allowed: string[] = [];

  for (const url of discovered) {
    options.deadline.throwIfExpired();

    const origin = new URL(url).origin;
    const robots = await loadRobots(db, jobId, origin, options.userAgent, options);

    if (!robotsAllows(robots, url, options.userAgent)) continue;

    if (
      await enqueueCrawlUrl(
        db,
        jobId,
        { url, origin, depth: crawlUrlDepth(url, options.scope.url) },
        options.limits,
      )
    ) {
      allowed.push(url);
    }
  }
  return allowed;
}
