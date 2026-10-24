import { appRouter } from "@buncrawl/api/routers/index";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { DiscoveryWorker, JobWorker, WebhookWorker } from "@buncrawl/jobs";
import { pruneJobEvents } from "@buncrawl/db";

import { createContext } from "./context";
import { ENV } from "./env.server";
import { handleScrape } from "./routes/v1/scrape";
import { createBatchScrapeHandler } from "./routes/v1/batch-scrape";
import { createDiscoveryHandler } from "./routes/v1/discovery";
import { createEventsHandler } from "./routes/v1/events";
import { SERVER_IDLE_TIMEOUT_SECONDS } from "./server-config";
import { db, persistJobDocument, servicesReady } from "./services";

const corsHeaders = {
  "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
  "Access-Control-Allow-Origin": ENV.CORS_ORIGIN,
};

function withCors(request: Request, response: Response): Response {
  const headers = new Headers(response.headers);

  for (const [name, value] of Object.entries(corsHeaders)) {
    headers.set(name, value);
  }

  const requestedHeaders = request.headers.get("Access-Control-Request-Headers");
  if (requestedHeaders) {
    headers.set("Access-Control-Allow-Headers", requestedHeaders);
    headers.append("Vary", "Access-Control-Request-Headers");
  }

  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}

async function handle(
  request: Request,
  handler: () => Response | Promise<Response>,
): Promise<Response> {
  const startedAt = performance.now();
  let status = 500;

  try {
    const response = withCors(request, await handler());
    status = response.status;
    return response;
  } finally {
    const pathname = new URL(request.url).pathname;
    console.info(
      `${request.method} ${pathname} ${status} ${(performance.now() - startedAt).toFixed(1)}ms`,
    );
  }
}

function preflight(request: Request): Response | undefined {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204 });
  }
}

async function main(): Promise<void> {
  await servicesReady;

  const batchScrape = createBatchScrapeHandler(db);
  const map = createDiscoveryHandler(db, "map");
  const crawl = createDiscoveryHandler(db, "crawl");
  const events = createEventsHandler(db);
  const worker = new JobWorker({ db, persistDocument: persistJobDocument });
  await worker.start();
  const discoveryWorker = new DiscoveryWorker({ db, persistDocument: persistJobDocument });
  await discoveryWorker.start();
  const webhooks = new WebhookWorker(db);
  webhooks.start();
  await pruneJobEvents(db);
  const retention = setInterval(() => void pruneJobEvents(db).catch(console.error), 60 * 60 * 1000);

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      clearInterval(retention);
      void Promise.all([worker.stop(), discoveryWorker.stop(), webhooks.stop()]).finally(() =>
        process.exit(0),
      );
    });
  }

  const server = Bun.serve({
    idleTimeout: SERVER_IDLE_TIMEOUT_SECONDS,
    routes: {
      "/": (request) =>
        handle(request, () => {
          const response = preflight(request);
          if (response) return response;

          return request.method === "GET"
            ? new Response("OK")
            : new Response("Not Found", { status: 404 });
        }),
      "/trpc/*": (request) =>
        handle(request, () => {
          const response = preflight(request);
          if (response) return response;

          return fetchRequestHandler({
            endpoint: "/trpc",
            req: request,
            router: appRouter,
            createContext,
          });
        }),
      "/v1/scrape": (request) =>
        handle(request, () => {
          const response = preflight(request);
          return response ?? handleScrape(request);
        }),
      "/v1/batch/scrape": (request) =>
        handle(request, () => preflight(request) ?? batchScrape(request)),
      "/v1/batch/scrape/:id": (request) =>
        handle(request, () => preflight(request) ?? batchScrape(request, request.params.id)),
      "/v1/batch/scrape/:id/events": (request) =>
        handle(
          request,
          () => preflight(request) ?? events(request, request.params.id, "batch_scrape"),
        ),
      "/v1/map": (request) => handle(request, () => preflight(request) ?? map(request)),
      "/v1/map/:id": (request) =>
        handle(request, () => preflight(request) ?? map(request, request.params.id)),
      "/v1/map/:id/events": (request) =>
        handle(request, () => preflight(request) ?? events(request, request.params.id, "map")),
      "/v1/crawl": (request) => handle(request, () => preflight(request) ?? crawl(request)),
      "/v1/crawl/:id": (request) =>
        handle(request, () => preflight(request) ?? crawl(request, request.params.id)),
      "/v1/crawl/:id/events": (request) =>
        handle(request, () => preflight(request) ?? events(request, request.params.id, "crawl")),
    },
    fetch(request) {
      return handle(request, () => {
        const response = preflight(request);
        return response ?? new Response("Not Found", { status: 404 });
      });
    },
    error(error) {
      console.error(error);
      return new Response("Internal Server Error", {
        headers: corsHeaders,
        status: 500,
      });
    },
  });

  console.info(`Server listening at ${server.url}`);
}

main().catch((error) => {
  console.error("Server startup failed", error);
  process.exitCode = 1;
});
