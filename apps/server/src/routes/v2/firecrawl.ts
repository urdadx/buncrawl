import type { JobError, ScrapeDocument, ScrapeResponse } from "@buncrawl/contracts";

import { artifactUrl, type ReadArtifact } from "../artifacts";

import {
  createIssues,
  isObject,
  issuesResponse,
  toFirecrawlDocument,
  toFirecrawlError,
  toFirecrawlJobStatus,
  translateBatchScrapeRequest,
  translateCrawlRequest,
  translateMapRequest,
  translateScrapeRequest,
  type CanonicalJobStatus,
} from "./translate";

/** A canonical v1 handler; job handlers take the job ID for status and cancellation. */
type CanonicalHandler = (request: Request, id?: string) => Promise<Response>;

export interface FirecrawlV2Options {
  scrape: (request: Request) => Promise<Response>;
  batchScrape: CanonicalHandler;
  crawl: CanonicalHandler;
  map: CanonicalHandler;
  /** Signs Firecrawl-style webhooks, which carry no per-request secret. */
  webhookSecret?: string;
  /** How often a synchronous map polls its canonical job. */
  mapPollMs?: number;
  /** Reads stored artifacts, so job documents can carry their large content inline. */
  readArtifact?: ReadArtifact;
}

type JobKind = "batch/scrape" | "crawl";
type CanonicalItem = {
  itemId?: string;
  url: string;
  state: string;
  document?: ScrapeDocument;
  error?: JobError;
};
type CanonicalStatusBody = CanonicalJobStatus & {
  items: CanonicalItem[];
  documents?: ScrapeDocument[];
  urls?: string[];
  next?: string;
};

const CANONICAL_PAGE_LIMIT = 100;
const MAP_WAIT_GRACE_MS = 10_000;
const DEFAULT_MAP_TIMEOUT_MS = 120_000;

/**
 * Firecrawl v2 endpoints as a thin adapter: each request is translated to a canonical
 * request, served by the canonical v1 handler, and its response translated back.
 */
export function createFirecrawlV2Handlers(options: FirecrawlV2Options) {
  const { webhookSecret, mapPollMs = 250 } = options;
  const jobHandlers: Record<JobKind, CanonicalHandler> = {
    "batch/scrape": options.batchScrape,
    crawl: options.crawl,
  };

  async function scrape(request: Request): Promise<Response> {
    const body = await readBody(request, "POST");
    if (body instanceof Response) return body;
    const issues = createIssues();
    const canonical = translateScrapeRequest(body, issues);
    const rejected = issuesResponse(issues);
    if (rejected) return rejected;

    const response = await options.scrape(
      canonicalRequest(request, "/v1/scrape", "POST", canonical),
    );
    const result = (await response.json()) as ScrapeResponse;
    if (!result.success) return toFirecrawlError(response.status, result);
    return Response.json({
      success: true,
      data: toFirecrawlDocument(result.data, result.warning),
      ...(result.warning ? { warning: result.warning } : {}),
    });
  }

  async function submit(request: Request, kind: JobKind): Promise<Response> {
    const body = await readBody(request, "POST");
    if (body instanceof Response) return body;
    const issues = createIssues();
    let submission: Record<string, unknown>;
    let invalidURLs: string[] | undefined;
    if (kind === "batch/scrape")
      ({ submission, invalidURLs } = translateBatchScrapeRequest(body, webhookSecret, issues));
    else submission = translateCrawlRequest(body, webhookSecret, issues);
    const rejected = issuesResponse(issues);
    if (rejected) return rejected;

    const response = await jobHandlers[kind](
      canonicalRequest(request, `/v1/${kind}`, "POST", submission),
    );
    const result = (await response.json()) as { jobId: string };
    if (!response.ok) return toFirecrawlError(response.status, result);
    return Response.json({
      success: true,
      id: result.jobId,
      url: new URL(`/v2/${kind}/${result.jobId}`, request.url).href,
      ...(invalidURLs ? { invalidURLs } : {}),
    });
  }

  async function status(request: Request, kind: JobKind, id: string): Promise<Response> {
    const url = new URL(request.url);
    const skip = url.searchParams.get("skip") ?? "0";
    const limit = url.searchParams.get("limit");
    const pageLimit =
      limit !== null && /^\d+$/.test(limit) && Number(limit) > CANONICAL_PAGE_LIMIT
        ? String(CANONICAL_PAGE_LIMIT)
        : (limit ?? String(CANONICAL_PAGE_LIMIT));
    const response = await jobHandlers[kind](
      canonicalRequest(request, `/v1/${kind}/${id}?cursor=${skip}&limit=${pageLimit}`, "GET"),
      id,
    );
    const job = (await response.json()) as CanonicalStatusBody;
    if (!response.ok) return toFirecrawlError(response.status, job);
    const documents =
      kind === "crawl"
        ? (job.documents ?? [])
        : job.items.flatMap((item) => (item.document ? [item.document] : []));
    let next: string | undefined;
    if (job.next) {
      const cursor = new URL(job.next).searchParams.get("cursor");
      const nextUrl = new URL(`/v2/${kind}/${id}`, request.url);
      nextUrl.searchParams.set("skip", cursor ?? "0");
      if (limit !== null) nextUrl.searchParams.set("limit", limit);
      next = nextUrl.href;
    }
    const resolved = await Promise.all(
      documents.map((document) => resolveArtifacts(document, request.url, options.readArtifact)),
    );
    return Response.json(toFirecrawlJobStatus(job, resolved, next));
  }

  async function cancel(request: Request, kind: JobKind, id: string): Promise<Response> {
    const response = await jobHandlers[kind](
      canonicalRequest(request, `/v1/${kind}/${id}`, "DELETE"),
      id,
    );
    const result = (await response.json()) as { state?: string };
    if (!response.ok) return toFirecrawlError(response.status, result);
    if (result.state === "completed" || result.state === "failed")
      return Response.json(
        { success: false, error: `Job is already ${result.state}` },
        { status: 409 },
      );
    return Response.json({ success: true, status: "cancelled" });
  }

  /** Reads every canonical result page, starting at the first. */
  async function* pages(
    request: Request,
    handler: CanonicalHandler,
    path: string,
    id: string,
  ): AsyncGenerator<{ response: Response; body: CanonicalStatusBody }> {
    let cursor = 0;
    while (true) {
      const response = await handler(
        canonicalRequest(
          request,
          `${path}/${id}?cursor=${cursor}&limit=${CANONICAL_PAGE_LIMIT}`,
          "GET",
        ),
        id,
      );
      const body = (await response.json()) as CanonicalStatusBody;
      yield { response, body };
      if (!response.ok || !body.next) return;
      cursor = Number(new URL(body.next).searchParams.get("cursor"));
    }
  }

  async function errors(request: Request, kind: JobKind, id: string): Promise<Response> {
    if (request.method !== "GET") return methodNotAllowed("GET");
    const errors: Record<string, unknown>[] = [];
    const robotsBlocked: string[] = [];
    for await (const { response, body } of pages(request, jobHandlers[kind], `/v1/${kind}`, id)) {
      if (!response.ok) return toFirecrawlError(response.status, body);
      for (const item of body.items) {
        if (item.state !== "failed" || !item.error) continue;
        if (item.error.code === "ROBOTS_BLOCKED") robotsBlocked.push(item.url);
        else
          errors.push({
            id: item.itemId ?? item.url,
            url: item.url,
            code: item.error.code,
            error: item.error.message,
          });
      }
    }
    return Response.json({ errors, robotsBlocked });
  }

  function job(kind: JobKind) {
    return (request: Request, id?: string): Promise<Response> => {
      if (!id) return submit(request, kind);
      if (request.method === "GET") return status(request, kind, id);
      if (request.method === "DELETE") return cancel(request, kind, id);
      return Promise.resolve(methodNotAllowed("GET, DELETE"));
    };
  }

  /** Firecrawl's map is synchronous: run a canonical map job and wait for its URLs. */
  async function map(request: Request): Promise<Response> {
    const body = await readBody(request, "POST");
    if (body instanceof Response) return body;
    const issues = createIssues();
    const submission = translateMapRequest(body, issues);
    const rejected = issuesResponse(issues);
    if (rejected) return rejected;

    const submitted = await options.map(canonicalRequest(request, "/v1/map", "POST", submission));
    const accepted = (await submitted.json()) as { jobId: string };
    if (!submitted.ok) return toFirecrawlError(submitted.status, accepted);
    const id = accepted.jobId;

    const timeoutMs =
      typeof submission.timeoutMs === "number" ? submission.timeoutMs : DEFAULT_MAP_TIMEOUT_MS;
    const deadline = Date.now() + timeoutMs + MAP_WAIT_GRACE_MS;
    let timedOut = false;
    let state: CanonicalStatusBody;
    while (true) {
      const response = await options.map(
        canonicalRequest(request, `/v1/map/${id}?limit=1`, "GET"),
        id,
      );
      state = (await response.json()) as CanonicalStatusBody;
      if (!response.ok) return toFirecrawlError(response.status, state);
      if (state.state === "completed" || state.state === "failed" || state.state === "cancelled")
        break;
      if (Date.now() >= deadline || request.signal.aborted) {
        timedOut = true;
        await options.map(canonicalRequest(request, `/v1/map/${id}`, "DELETE"), id);
        break;
      }
      await Bun.sleep(mapPollMs);
    }

    const links: { url: string }[] = [];
    for await (const { response, body: page } of pages(request, options.map, "/v1/map", id)) {
      if (!response.ok) return toFirecrawlError(response.status, page);
      for (const url of page.urls ?? []) links.push({ url });
    }
    if (state.state === "failed" && links.length === 0)
      return Response.json(
        {
          success: false,
          id,
          code: state.error?.code ?? "MAP_FAILED",
          error: state.error?.message ?? "Map failed",
        },
        { status: 500 },
      );
    return Response.json({
      success: true,
      id,
      links,
      ...(timedOut ? { warning: "Map timed out; links discovered so far are returned" } : {}),
    });
  }

  return {
    scrape,
    map,
    batchScrape: job("batch/scrape"),
    crawl: job("crawl"),
    batchScrapeErrors: (request: Request, id: string) => errors(request, "batch/scrape", id),
    crawlErrors: (request: Request, id: string) => errors(request, "crawl", id),
    unsupported,
  };
}

/** Any other Firecrawl v2 endpoint, such as extract, search, or agent. */
function unsupported(request: Request): Response {
  const { pathname } = new URL(request.url);
  return Response.json(
    {
      success: false,
      code: "UNSUPPORTED_ENDPOINT",
      error: `Buncrawl does not implement the Firecrawl endpoint ${request.method} ${pathname}`,
    },
    { status: 404 },
  );
}

function methodNotAllowed(allow: string): Response {
  return Response.json(
    { success: false, error: "Method not allowed" },
    { status: 405, headers: { Allow: `${allow}, OPTIONS` } },
  );
}

async function readBody(
  request: Request,
  method: string,
): Promise<Record<string, unknown> | Response> {
  if (request.method !== method) return methodNotAllowed(method);
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { success: false, code: "BAD_REQUEST", error: "Request body must be JSON" },
      { status: 400 },
    );
  }
  if (!isObject(body))
    return Response.json(
      { success: false, code: "BAD_REQUEST", error: "Request body must be a JSON object" },
      { status: 400 },
    );
  return body;
}

/** A request to a canonical v1 handler on the same origin, bound to the client's signal. */
function canonicalRequest(request: Request, path: string, method: string, body?: unknown): Request {
  return new Request(new URL(path, request.url).href, {
    method,
    signal: request.signal,
    ...(body === undefined
      ? {}
      : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
  });
}

/**
 * Firecrawl documents carry their content inline and screenshots as URLs, but job results store
 * large content and screenshots as `artifact://` references. A screenshot becomes its
 * `/v1/artifacts` URL, and large text is read back when the store is available.
 */
async function resolveArtifacts(
  document: ScrapeDocument,
  base: string,
  read: ReadArtifact | undefined,
): Promise<ScrapeDocument> {
  const resolved = { ...document };
  const screenshot = artifactUrl(resolved.screenshot, base);
  if (screenshot) resolved.screenshot = screenshot;
  if (!read) return resolved;
  for (const field of ["markdown", "html", "rawHtml"] as const) {
    const value = resolved[field];
    if (typeof value !== "string" || !value.startsWith("artifact://")) continue;
    const artifact = await read(value.slice("artifact://".length)).catch(() => undefined);
    if (artifact) resolved[field] = new TextDecoder().decode(artifact.data);
  }
  return resolved;
}
