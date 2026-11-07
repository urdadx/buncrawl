import { validateUrl } from "@buncrawl/security";

/** Discovery canonicalization is deliberately conservative: query order can change page meaning. */
export function canonicalCrawlUrl(input: string, base?: string): string | undefined {
  try {
    const url = validateUrl(base ? new URL(input, base) : input);
    url.hash = "";
    return url.href;
  } catch {
    return undefined;
  }
}

export interface CrawlScope {
  url: string;
  includeSubdomains?: boolean;
  pathPrefix?: boolean;
}

/** `www.` and the bare domain are the same site; sites commonly redirect between the two. */
function siteHostname(hostname: string): string {
  return hostname.startsWith("www.") ? hostname.slice(4) : hostname;
}

export function withinCrawlScope(candidate: string, scope: CrawlScope): boolean {
  const base = canonicalCrawlUrl(scope.url);
  const target = canonicalCrawlUrl(candidate);

  if (!base || !target) return false;
  const root = new URL(base);
  const url = new URL(target);

  if (root.protocol !== url.protocol || root.port !== url.port) return false;
  const rootHost = siteHostname(root.hostname);
  const host = siteHostname(url.hostname);
  if (host !== rootHost && !(scope.includeSubdomains && host.endsWith(`.${rootHost}`)))
    return false;
  if (!scope.pathPrefix) return true;

  const prefix = root.pathname.endsWith("/") ? root.pathname : `${root.pathname}/`;
  return url.pathname === root.pathname || url.pathname.startsWith(prefix);
}

export function discoveredCrawlUrls(
  links: readonly string[],
  base: string,
  scope: CrawlScope,
  depth: number,
  maxDepth: number,
): string[] {
  if (depth >= maxDepth) return [];
  return [
    ...new Set(
      links
        .filter((link) => !link.trim().startsWith("#"))
        .map((link) => canonicalCrawlUrl(link, base))
        .filter((url): url is string => !!url && withinCrawlScope(url, scope)),
    ),
  ];
}
