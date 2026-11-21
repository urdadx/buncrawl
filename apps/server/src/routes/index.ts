import type { Database } from "@buncrawl/db";
import type { RendererCapabilityReport } from "@buncrawl/renderer";

import { batchScrapeRoutes } from "./batch-scrape";
import { capabilitiesRoutes } from "./capabilities";
import { crawlRoutes } from "./crawl";
import { firecrawlRoutes } from "./firecrawl";
import { healthRoutes } from "./health";
import { mapRoutes } from "./map";
import { scrapeRoutes } from "./scrape";
import { trpcRoutes } from "./trpc";

export {
  batchScrapeRoutes,
  capabilitiesRoutes,
  crawlRoutes,
  firecrawlRoutes,
  healthRoutes,
  mapRoutes,
  scrapeRoutes,
  trpcRoutes,
};

export function createRoutes(db: Database, capabilities: Promise<RendererCapabilityReport>) {
  return {
    ...healthRoutes,
    ...capabilitiesRoutes(capabilities),
    ...trpcRoutes,
    ...scrapeRoutes(db),
    ...batchScrapeRoutes(db),
    ...mapRoutes(db),
    ...crawlRoutes(db),
    ...firecrawlRoutes(db),
  };
}
