import { scrapeRequestSchema, type ScrapeRequest, type ScrapeResponse } from "@buncrawl/contracts";
import { scrape } from "@buncrawl/scrape";
import * as v from "valibot";

type Scrape = (request: ScrapeRequest, context: { signal: AbortSignal }) => Promise<ScrapeResponse>;

export function createScrapeHandler(scrapePage: Scrape = scrape) {
  return async function handleScrape(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return json(
        { success: false, code: "METHOD_NOT_ALLOWED", error: "Method not allowed" },
        405,
        { Allow: "POST, OPTIONS" },
      );
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json(
        { success: false, code: "INVALID_JSON", error: "Request body must be JSON" },
        400,
      );
    }

    const parsed = v.safeParse(scrapeRequestSchema, body);
    if (!parsed.success) {
      return json(
        {
          success: false,
          code: "INVALID_REQUEST",
          error: "Invalid scrape request",
          details: parsed.issues.map((issue) => issue.message),
        },
        400,
      );
    }

    const response = await scrapePage(parsed.output, { signal: request.signal });
    return json(response, response.success ? 200 : statusForError(response.code));
  };
}

export const handleScrape = createScrapeHandler();

function statusForError(code: string): number {
  switch (code) {
    case "INVALID_REQUEST":
    case "INVALID_URL":
    case "BLOCKED_DESTINATION":
      return 400;
    case "REQUEST_CANCELLED":
      return 499;
    case "DEADLINE_EXCEEDED":
      return 504;
    case "RENDERER_UNAVAILABLE":
      return 503;
    case "DNS_RESOLUTION_FAILED":
    case "FETCH_FAILED":
    case "INVALID_REDIRECT":
    case "TOO_MANY_REDIRECTS":
    case "RESPONSE_TOO_LARGE":
      return 502;
    default:
      return 500;
  }
}

function json(body: unknown, status: number, headers?: Record<string, string>): Response {
  return Response.json(body, { status, headers });
}
