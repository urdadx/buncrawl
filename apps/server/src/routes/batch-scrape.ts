import type { Database } from "@buncrawl/db";

import { endpoint } from "../http";
import { createBatchScrapeHandler } from "./v1/batch-scrape";
import { createEventsHandler } from "./v1/events";

export function batchScrapeRoutes(db: Database) {
  const batchScrape = createBatchScrapeHandler(db);
  const events = createEventsHandler(db);
  return {
    "/v1/batch/scrape": endpoint((request) => batchScrape(request)),
    "/v1/batch/scrape/:id": endpoint<"/v1/batch/scrape/:id">((request) =>
      batchScrape(request, request.params.id),
    ),
    "/v1/batch/scrape/:id/events": endpoint<"/v1/batch/scrape/:id/events">((request) =>
      events(request, request.params.id, "batch_scrape"),
    ),
  };
}
