import { appRouter } from "@buncrawl/api/routers/index";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";

import { createContext } from "./context";
import { ENV } from "./env.server";
import { handleScrape } from "./routes/v1/scrape";
import { SERVER_IDLE_TIMEOUT_SECONDS } from "./server-config";

const corsHeaders = {
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
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

// a preflight request in HTTP is an automatic check sent by a browser using the OPTIONS
// method to see if a server allows a cross-origin request before sending the actual data
function preflight(request: Request): Response | undefined {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204 });
  }
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

export default server;
