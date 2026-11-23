import { createScrapeCache, type Database } from "@buncrawl/db";
import { scrape } from "@buncrawl/scrape";

import { ENV } from "#env";
import { endpoint } from "../http";
import { readStoredArtifact } from "./artifacts";
import { createBatchScrapeHandler } from "./v1/batch-scrape";
import { createDiscoveryHandler } from "./v1/discovery";
import { createScrapeHandler } from "./v1/scrape";
import { createFirecrawlV2Handlers } from "./v2/firecrawl";

/** Firecrawl v2-compatible routes over the canonical v1 handlers. */
export function firecrawlRoutes(db: Database) {
  const cache = createScrapeCache(db);
  const v2 = createFirecrawlV2Handlers({
    scrape: createScrapeHandler((request, context) => scrape(request, context, { cache })),
    batchScrape: createBatchScrapeHandler(db),
    crawl: createDiscoveryHandler(db, "crawl"),
    map: createDiscoveryHandler(db, "map"),
    webhookSecret: ENV.BUNCRAWL_WEBHOOK_SECRET,
    readArtifact: readStoredArtifact,
  });
  return {
    "/v2/scrape": endpoint(v2.scrape),
    "/v2/map": endpoint(v2.map),
    "/v2/batch/scrape": endpoint((request) => v2.batchScrape(request)),
    "/v2/batch/scrape/:id": endpoint<"/v2/batch/scrape/:id">((request) =>
      v2.batchScrape(request, request.params.id),
    ),
    "/v2/batch/scrape/:id/errors": endpoint<"/v2/batch/scrape/:id/errors">((request) =>
      v2.batchScrapeErrors(request, request.params.id),
    ),
    "/v2/crawl": endpoint((request) => v2.crawl(request)),
    "/v2/crawl/:id": endpoint<"/v2/crawl/:id">((request) => v2.crawl(request, request.params.id)),
    "/v2/crawl/:id/errors": endpoint<"/v2/crawl/:id/errors">((request) =>
      v2.crawlErrors(request, request.params.id),
    ),
    "/v2/*": endpoint(v2.unsupported),
  };
}
