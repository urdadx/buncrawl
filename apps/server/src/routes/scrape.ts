import { createScrapeCache, type Database } from "@buncrawl/db";
import { scrape } from "@buncrawl/scrape";

import { endpoint } from "../http";
import { createScrapeHandler } from "./v1/scrape";

export function scrapeRoutes(db: Database) {
  const cache = createScrapeCache(db);
  return {
    "/v1/scrape": endpoint(
      createScrapeHandler((request, context) => scrape(request, context, { cache })),
    ),
  };
}
