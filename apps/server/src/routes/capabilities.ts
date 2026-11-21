import type { RendererCapabilityReport } from "@buncrawl/renderer";

import { endpoint } from "../http";

/** Serves the renderer capability report from the server's startup check. */
export function capabilitiesRoutes(report: Promise<RendererCapabilityReport>) {
  return {
    "/v1/capabilities": endpoint(async (request) =>
      request.method === "GET"
        ? Response.json({ success: true, data: await report })
        : Response.json(
            { code: "METHOD_NOT_ALLOWED", error: "Method not allowed" },
            { status: 405, headers: { Allow: "GET, OPTIONS" } },
          ),
    ),
  };
}
