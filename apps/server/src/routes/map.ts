import type { Database } from "@buncrawl/db";

import { endpoint } from "../http";
import { createDiscoveryHandler } from "./v1/discovery";
import { createEventsHandler } from "./v1/events";

export function mapRoutes(db: Database) {
  const map = createDiscoveryHandler(db, "map");
  const events = createEventsHandler(db);
  return {
    "/v1/map": endpoint((request) => map(request)),
    "/v1/map/:id": endpoint<"/v1/map/:id">((request) => map(request, request.params.id)),
    "/v1/map/:id/events": endpoint<"/v1/map/:id/events">((request) =>
      events(request, request.params.id, "map"),
    ),
  };
}
