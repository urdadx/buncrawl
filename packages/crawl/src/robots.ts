import { Deadline } from "@buncrawl/core";
import { getCrawlHost, saveCrawlRobots, scheduleCrawlHost, type Database } from "@buncrawl/db";
import { fetchPage, type FetchPageOptions } from "@buncrawl/fetcher";

const MAX_ROBOTS_BYTES = 512 * 1024;
const ROBOTS_TTL_MS = 60 * 60 * 1000;

interface Rule {
  allow: boolean;
  path: string;
}
interface Group {
  agents: string[];
  rules: Rule[];
  crawlDelayMs?: number;
}
export interface RobotsFile {
  groups: Group[];
  sitemaps: string[];
}

export function parseRobots(body: string): RobotsFile {
  const groups: Group[] = [];
  const sitemaps: string[] = [];
  let group: Group | undefined;
  let directivesStarted = false;
  for (const line of body.split(/\r?\n/)) {
    const cleaned = line.replace(/#.*$/, "").trim();
    const index = cleaned.indexOf(":");
    if (index < 0) continue;
    const name = cleaned.slice(0, index).trim().toLowerCase();
    const value = cleaned.slice(index + 1).trim();
    if (name === "sitemap") {
      if (value) sitemaps.push(value);
    } else if (name === "user-agent") {
      if (!group || directivesStarted) {
        group = { agents: [], rules: [] };
        groups.push(group);
        directivesStarted = false;
      }
      group.agents.push(value.toLowerCase());
    } else if (group && (name === "allow" || name === "disallow")) {
      directivesStarted = true;
      if (value) group.rules.push({ allow: name === "allow", path: value });
    } else if (group && name === "crawl-delay") {
      directivesStarted = true;
      const seconds = Number(value);
      if (Number.isFinite(seconds) && seconds >= 0)
        group.crawlDelayMs = Math.min(60_000, Math.ceil(seconds * 1000));
    }
  }
  return { groups, sitemaps };
}

function selectedGroups(file: RobotsFile, userAgent: string): Group[] {
  const agent = userAgent.toLowerCase();
  const matches = file.groups.map((group) => ({
    group,
    score: Math.max(
      -1,
      ...group.agents.map((token) =>
        token === "*" ? 0 : agent.includes(token) ? token.length : -1,
      ),
    ),
  }));
  const longest = Math.max(-1, ...matches.map(({ score }) => score));
  return matches.filter(({ score }) => score === longest && score >= 0).map(({ group }) => group);
}

export function robotsAllows(file: RobotsFile, url: string, userAgent: string): boolean {
  const target = new URL(url);
  const path = target.pathname + target.search;
  let winner: { length: number; allow: boolean } | undefined;
  for (const group of selectedGroups(file, userAgent)) {
    for (const rule of group.rules) {
      const expression = `^${rule.path
        .split("*")
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join(".*")
        .replace(/\\\$$/, "$")}`;
      if (new RegExp(expression).test(path)) {
        const length = rule.path.replaceAll("*", "").replace(/\$$/, "").length;
        if (!winner || length > winner.length || (length === winner.length && rule.allow))
          winner = { length, allow: rule.allow };
      }
    }
  }
  return winner?.allow ?? true;
}

export function robotsCrawlDelay(file: RobotsFile, userAgent: string): number {
  return Math.max(0, ...selectedGroups(file, userAgent).map((group) => group.crawlDelayMs ?? 0));
}

/** Caches rules in the authoritative host row; HTTP requests retain safe redirects, DNS and byte bounds. */
export async function loadRobots(
  db: Database,
  jobId: string,
  origin: string,
  userAgent: string,
  options: {
    deadline?: Deadline;
    fetchImpl?: FetchPageOptions["fetchImpl"];
    resolver?: FetchPageOptions["resolver"];
    now?: Date;
    ttlMs?: number;
  } = {},
): Promise<RobotsFile> {
  const now = options.now ?? new Date();
  await scheduleCrawlHost(db, jobId, origin);
  const cached = await getCrawlHost(db, jobId, origin);
  if (
    cached?.robotsFetchedAt &&
    cached.robotsBody !== null &&
    now.getTime() - cached.robotsFetchedAt.getTime() < (options.ttlMs ?? ROBOTS_TTL_MS)
  )
    return parseRobots(cached.robotsBody);
  const result = await fetchPage(new URL("/robots.txt", origin), {
    deadline: options.deadline ?? new Deadline(8000),
    maxResponseBytes: MAX_ROBOTS_BYTES,
    headers: { "User-Agent": userAgent },
    fetchImpl: options.fetchImpl,
    resolver: options.resolver,
  });
  // Missing robots allows crawling; inaccessible or broken robots fails closed.
  const body =
    result.statusCode === 404
      ? ""
      : result.statusCode >= 400
        ? "User-agent: *\nDisallow: /"
        : result.body;
  const file = parseRobots(body);
  await saveCrawlRobots(db, jobId, origin, body, robotsCrawlDelay(file, userAgent), now);
  return file;
}
