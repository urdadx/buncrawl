import type { Database } from "@buncrawl/db";

import { batchScrapeRoutes } from "./batch-scrape";
import { crawlRoutes } from "./crawl";
import { healthRoutes } from "./health";
import { mapRoutes } from "./map";
import { scrapeRoutes } from "./scrape";
import { trpcRoutes } from "./trpc";

export { batchScrapeRoutes, crawlRoutes, healthRoutes, mapRoutes, scrapeRoutes, trpcRoutes };

export function createRoutes(db: Database) {
  return {
    ...healthRoutes,
    ...trpcRoutes,
    ...scrapeRoutes(db),
    ...batchScrapeRoutes(db),
    ...mapRoutes(db),
    ...crawlRoutes(db),
  };
}
