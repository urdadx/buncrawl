import { Deadline } from "@buncrawl/core";
import { fetchPage, type FetchPageOptions } from "@buncrawl/fetcher";

import { canonicalCrawlUrl, withinCrawlScope, type CrawlScope } from "./urls";

const MAX_SITEMAP_BYTES = 2 * 1024 * 1024;

function decodeXml(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, entity: string) => {
    const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
    if (entity[0] !== "#") return named[entity.toLowerCase()] ?? "";
    const point =
      entity[1]?.toLowerCase() === "x"
        ? parseInt(entity.slice(2), 16)
        : parseInt(entity.slice(1), 10);
    return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff)
      ? String.fromCodePoint(point)
      : "";
  });
}

export function parseSitemap(
  xml: string,
  maxUrls = 10_000,
): { type: "index" | "urls"; locations: string[] } {
  if (/<!DOCTYPE\b|<!ENTITY\b/i.test(xml)) throw new Error("Sitemap entities are not supported");
  const root = /<(?:(?:[\w.-]+):)?(urlset|sitemapindex)\b/i.exec(xml)?.[1]?.toLowerCase();
  if (!root) throw new Error("Invalid sitemap root");
  const locations: string[] = [];
  const entries = root === "urlset" ? "url" : "sitemap";
  const entry = new RegExp(
    `<(?:[\\w.-]+:)?${entries}\\b[^>]*>([\\s\\S]*?)<\\/(?:[\\w.-]+:)?${entries}\\s*>`,
    "gi",
  );
  for (const match of xml.matchAll(entry)) {
    if (locations.length >= maxUrls) throw new Error("Sitemap URL limit exceeded");
    const raw = /<(?:[\w.-]+:)?loc\b[^>]*>([^<]*)<\/(?:[\w.-]+:)?loc\s*>/i.exec(
      match[1] ?? "",
    )?.[1];
    if (raw) locations.push(decodeXml(raw.trim()));
  }
  return { type: root === "urlset" ? "urls" : "index", locations };
}

export async function discoverSitemapUrls(
  seeds: readonly string[],
  scope: CrawlScope,
  options: {
    deadline: Deadline;
    fetchImpl?: FetchPageOptions["fetchImpl"];
    resolver?: FetchPageOptions["resolver"];
    maxDepth?: number;
    maxSitemaps?: number;
    maxUrls?: number;
    maxBytes?: number;
  },
): Promise<string[]> {
  const maxDepth = options.maxDepth ?? 3;
  const maxSitemaps = options.maxSitemaps ?? 20;
  const maxUrls = options.maxUrls ?? 10_000;
  const maxBytes = options.maxBytes ?? MAX_SITEMAP_BYTES;
  if (![maxDepth, maxSitemaps, maxUrls, maxBytes].every((n) => Number.isSafeInteger(n) && n > 0))
    throw new TypeError("Invalid sitemap limits");
  const pending = seeds.map((url) => ({ url, depth: 0 }));
  const visited = new Set<string>();
  const urls = new Set<string>();
  while (pending.length) {
    options.deadline.throwIfExpired();
    const current = pending.shift()!;
    const sitemapUrl = canonicalCrawlUrl(current.url);
    if (
      !sitemapUrl ||
      !withinCrawlScope(sitemapUrl, { ...scope, pathPrefix: false }) ||
      visited.has(sitemapUrl)
    )
      continue;
    if (visited.size >= maxSitemaps) throw new Error("Sitemap file limit exceeded");
    visited.add(sitemapUrl);
    const result = await fetchPage(sitemapUrl, {
      deadline: options.deadline,
      maxResponseBytes: maxBytes,
      fetchImpl: options.fetchImpl,
      resolver: options.resolver,
    });
    if (result.statusCode >= 400) continue;
    const { type, locations } = parseSitemap(result.body, maxUrls);
    for (const value of locations) {
      const url = canonicalCrawlUrl(value);
      if (
        !url ||
        !withinCrawlScope(url, type === "index" ? { ...scope, pathPrefix: false } : scope)
      )
        continue;
      if (type === "index") {
        if (current.depth >= maxDepth) throw new Error("Sitemap nesting limit exceeded");
        pending.push({ url, depth: current.depth + 1 });
      } else {
        urls.add(url);
        if (urls.size > maxUrls) throw new Error("Sitemap URL limit exceeded");
      }
    }
  }
  return [...urls];
}
