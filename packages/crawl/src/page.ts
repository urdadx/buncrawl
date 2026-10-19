import { Deadline } from "@buncrawl/core";
import { remainingCrawlBytes, type CrawlLimits, type Database } from "@buncrawl/db";
import { extractLinks } from "@buncrawl/extract";
import { fetchPage, type FetchPageOptions } from "@buncrawl/fetcher";

import { loadRobots, robotsAllows } from "./robots";
import { discoveredCrawlUrls, withinCrawlScope, type CrawlScope } from "./urls";

export interface CrawlPageOptions {
  deadline: Deadline;
  scope: CrawlScope;
  limits: CrawlLimits;
  depth: number;
  userAgent: string;
  fetchImpl?: FetchPageOptions["fetchImpl"];
  resolver?: FetchPageOptions["resolver"];
  byteBudget?: number;
}

/** Safe fetch with robots checks before navigation and every redirect; no browser needed for discovery. */
export async function fetchCrawlPage(
  db: Database,
  jobId: string,
  url: string,
  options: CrawlPageOptions,
) {
  if (!withinCrawlScope(url, options.scope)) throw new Error("URL is outside crawl scope");
  const fetchOptions = {
    deadline: options.deadline,
    fetchImpl: options.fetchImpl,
    resolver: options.resolver,
  };
  const check = async (candidate: string) => {
    if (!withinCrawlScope(candidate, options.scope))
      throw new Error("Redirect is outside crawl scope");
    const rules = await loadRobots(
      db,
      jobId,
      new URL(candidate).origin,
      options.userAgent,
      fetchOptions,
    );
    if (!robotsAllows(rules, candidate, options.userAgent))
      throw new Error("Blocked by robots.txt");
  };
  await check(url);
  const available =
    options.byteBudget ?? (await remainingCrawlBytes(db, jobId, options.limits.maxBytes));
  if (available <= 0) throw new Error("Crawl byte limit exceeded");
  const page = await fetchPage(url, {
    ...fetchOptions,
    maxResponseBytes: Math.min(available, 10 * 1024 * 1024),
    headers: { "User-Agent": options.userAgent },
    beforeRedirect: async (target) => check(target.href),
  });
  const links = page.contentType?.includes("html")
    ? discoveredCrawlUrls(
        extractLinks(page.body, page.finalUrl),
        page.finalUrl,
        options.scope,
        options.depth,
        options.limits.maxDepth,
      )
    : [];
  return {
    finalUrl: page.finalUrl,
    statusCode: page.statusCode,
    byteSize: page.rawBody.byteLength,
    links,
  };
}
