import type { ScrapeDocument, ScrapeFormat, ScrapeRequest } from "@buncrawl/contracts";

export interface ScrapeCache {
  get(
    key: string,
    maxAgeMs: number,
  ): Promise<{ document: ScrapeDocument; cachedAt: Date } | undefined>;
  set(key: string, url: string, document: ScrapeDocument): Promise<void>;
}

/**
 * Identifies a result by the URL and every option that changes the output. Timeouts are left out
 * on purpose: they do not change a successful result. Returns undefined for requests that are not
 * cached: screenshots are large base64 blobs that belong in artifact storage, not this table.
 */
export function scrapeCacheKey(request: ScrapeRequest): string | undefined {
  const formats = request.formats ?? ["markdown"];
  if (formats.some(isScreenshotFormat)) return;
  const url = new URL(request.url);
  url.hash = "";
  const identity = JSON.stringify({
    url: url.href,
    formats: formats.map((format) => format as string).sort(),
    onlyMainContent: request.onlyMainContent ?? true,
    renderJs: request.renderJs ?? "auto",
    waitForMs: request.waitForMs ?? 0,
  });
  return new Bun.CryptoHasher("sha256").update(identity).digest("hex");
}

function isScreenshotFormat(format: ScrapeFormat): boolean {
  return format === "screenshots" || typeof format === "object";
}
