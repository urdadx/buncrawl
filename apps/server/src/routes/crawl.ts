import type { Database } from "@buncrawl/db";

import { endpoint } from "../http";
import { createDiscoveryHandler } from "./v1/discovery";
import { createEventsHandler } from "./v1/events";

export function crawlRoutes(db: Database) {
  const crawl = createDiscoveryHandler(db, "crawl");
  const events = createEventsHandler(db);
  return {
    "/v1/crawl": endpoint((request) => crawl(request)),
    "/v1/crawl/:id": endpoint<"/v1/crawl/:id">((request) => crawl(request, request.params.id)),
    "/v1/crawl/:id/events": endpoint<"/v1/crawl/:id/events">((request) =>
      events(request, request.params.id, "crawl"),
    ),
  };
}
