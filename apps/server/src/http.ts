import type { BunRequest } from "bun";

import { ENV } from "./env.server";

export const corsHeaders = {
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

/** Applies CORS headers and logs the method, path, status and duration of every request. */
export async function handle(
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

export function preflight(request: Request): Response | undefined {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204 });
  }
}

/** Wraps a route handler with CORS preflight, CORS headers and request logging. */
export function endpoint<Path extends string>(
  handler: (request: BunRequest<Path>) => Response | Promise<Response>,
) {
  return (request: BunRequest<Path>) =>
    handle(request, () => preflight(request) ?? handler(request));
}
