import { Deadline } from "@buncrawl/core";
import { fetchPage, type FetchPageOptions } from "@buncrawl/fetcher";
import { Readable } from "node:stream";
import { createGunzip } from "node:zlib";

import { canonicalCrawlUrl, withinCrawlScope, type CrawlScope } from "./urls";

const DEFAULT_MAX_SITEMAP_BYTES = 8 * 1024 * 1024;
const MAX_SITEMAP_BYTES = 50 * 1024 * 1024;
const MAX_SITEMAP_CONCURRENCY = 8;
const MAX_PARALLEL_BYTES = 64 * 1024 * 1024;
const SITEMAP_FETCH_TIMEOUT_MS = 15_000;
const MAX_FILE_URLS = 50_000;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function localName(name: string): string {
  return name.slice(name.lastIndexOf(":") + 1);
}

function children(node: Record<string, unknown>, name: string): unknown[] {
  return Object.entries(node)
    .filter(([key]) => localName(key) === name)
    .flatMap(([, value]) => (Array.isArray(value) ? value : [value]));
}

export function parseSitemap(
  xml: string | Uint8Array,
  maxUrls = MAX_FILE_URLS,
): { type: "index" | "urls"; locations: string[] } {
  const guardText =
    typeof xml === "string" ? xml : new TextDecoder().decode(xml).replaceAll("\0", "");
  if (/<!DOCTYPE\b|<!ENTITY\b/i.test(guardText))
    throw new Error("Sitemap entities are not supported");

  const document: unknown = Bun.XML.parse(xml);
  if (!record(document)) throw new Error("Invalid sitemap root");

  const [[rootName, rootNode] = []] = Object.entries(document);
  const root = rootName && localName(rootName);
  if (root !== "urlset" && root !== "sitemapindex") throw new Error("Invalid sitemap root");

  const locations: string[] = [];
  if (!record(rootNode)) return { type: root === "urlset" ? "urls" : "index", locations };

  for (const entry of children(rootNode, root === "urlset" ? "url" : "sitemap")) {
    if (locations.length >= maxUrls) throw new Error("Sitemap URL limit exceeded");
    if (!record(entry)) continue;

    const loc = children(entry, "loc")[0];
    const value = typeof loc === "string" ? loc : record(loc) ? loc["#text"] : undefined;
    if (typeof value === "string" && value.trim()) locations.push(value.trim());
  }
  return { type: root === "urlset" ? "urls" : "index", locations };
}

/** Decode raw .xml.gz responses without buffering more than maxBytes of expanded XML. */
async function inflateSitemap(bytes: Uint8Array, maxBytes: number): Promise<Uint8Array> {
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return bytes;
  const stream = Readable.from([bytes]).pipe(createGunzip());
  const chunks: Uint8Array[] = [];

  let size = 0;

  try {
    for await (const chunk of stream) {
      size += chunk.byteLength;
      if (size > maxBytes) throw new Error("Decompressed sitemap exceeds byte limit");
      chunks.push(chunk);
    }
  } finally {
    stream.destroy();
  }
  return Buffer.concat(chunks, size);
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
    maxConcurrency?: number;
  },
): Promise<string[]> {
  const maxDepth = options.maxDepth ?? 3;
  const maxSitemaps = options.maxSitemaps ?? 20;
  const maxUrls = options.maxUrls ?? 10_000;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_SITEMAP_BYTES;
  const maxConcurrency = options.maxConcurrency ?? 4;

  if (
    ![maxDepth, maxSitemaps, maxUrls, maxBytes, maxConcurrency].every(
      (n) => Number.isSafeInteger(n) && n > 0,
    ) ||
    maxBytes > MAX_SITEMAP_BYTES
  )
    throw new TypeError("Invalid sitemap limits");

  const concurrency = Math.min(
    maxConcurrency,
    MAX_SITEMAP_CONCURRENCY,
    Math.max(1, Math.floor(MAX_PARALLEL_BYTES / maxBytes)),
  );

  const sitemapScope = { ...scope, pathPrefix: false };
  const visited = new Set<string>();
  const urls = new Set<string>();

  let current = seeds.map((url) => canonicalCrawlUrl(url)).filter((url): url is string => !!url);

  for (let depth = 0; current.length; depth++) {
    options.deadline.throwIfExpired();
    const batch: string[] = [];

    for (const url of current) {
      if (!withinCrawlScope(url, sitemapScope) || visited.has(url)) continue;
      if (visited.size >= maxSitemaps) throw new Error("Sitemap file limit exceeded");
      visited.add(url);
      batch.push(url);
    }
    if (!batch.length) break;

    // Fetch each BFS level in parallel, preserving input order for deterministic output.
    const results: ({ type: "index" | "urls"; locations: string[] } | undefined)[] = Array.from(
      { length: batch.length },
      () => undefined,
    );

    let nextIndex = 0;

    await Promise.all(
      Array.from({ length: Math.min(batch.length, concurrency) }, async () => {
        while (nextIndex < batch.length) {
          const index = nextIndex++;
          const url = batch[index]!;

          const fetchDeadline = new Deadline(
            Math.min(options.deadline.remainingMs, SITEMAP_FETCH_TIMEOUT_MS),
            options.deadline.signal,
          );

          try {
            const response = await fetchPage(url, {
              deadline: fetchDeadline,
              maxResponseBytes: maxBytes,
              fetchImpl: options.fetchImpl,
              resolver: options.resolver,
              beforeRedirect: async (target) => {
                if (!withinCrawlScope(target.href, sitemapScope))
                  throw new Error("Sitemap redirected outside crawl scope");
              },
            });

            if (response.statusCode >= 400 || !withinCrawlScope(response.finalUrl, sitemapScope))
              continue;
            const xml = await inflateSitemap(response.rawBody, maxBytes);
            results[index] = parseSitemap(xml);
          } catch (error) {
            if (options.deadline.signal.aborted || options.deadline.expired) throw error;
            // One malformed, blocked or unavailable sitemap should not discard sibling results.
          }
        }
      }),
    );

    const next: string[] = [];
    const leaves: string[][] = [];

    for (const result of results) {
      if (!result) continue;
      if (result.type === "index") {
        if (depth >= maxDepth && result.locations.length)
          throw new Error("Sitemap nesting limit exceeded");
        for (const value of result.locations) {
          const url = canonicalCrawlUrl(value);
          if (url && withinCrawlScope(url, sitemapScope) && !visited.has(url)) next.push(url);
        }
      } else {
        leaves.push(result.locations);
      }
    }
    // Round-robin leaves so a large first sitemap cannot consume the entire URL cap.
    for (let i = 0; leaves.some((leaf) => i < leaf.length) && urls.size < maxUrls; i++) {
      for (const leaf of leaves) {
        const entry = leaf[i];
        const url = entry ? canonicalCrawlUrl(entry) : undefined;
        if (url && withinCrawlScope(url, scope)) urls.add(url);
        if (urls.size >= maxUrls) break;
      }
    }
    if (urls.size >= maxUrls) break;
    current = next;
  }
  return [...urls];
}
