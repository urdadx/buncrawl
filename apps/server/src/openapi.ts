import {
  jobErrorSchema,
  jobEventSchema,
  jobIdSchema,
  jobItemIdSchema,
  jobLimitsSchema,
  jobProgressSchema,
  jobStateSchema,
  jobSubmissionResponseSchema,
  jobSubmissionSchema,
  jobTimestampSchema,
  jsonSelectorSchema,
  scrapeDocumentSchema,
  scrapeRequestSchema,
} from "@buncrawl/contracts";
import { toJsonSchemaDefs } from "@valibot/to-json-schema";
import * as v from "valibot";

/*
 * The OpenAPI document for the v1 API, generated from the same valibot schemas the server
 * validates requests with (packages/contracts). Response schemas below mirror what the handlers
 * return; test/openapi.test.ts checks real handler responses against them and that
 * apps/docs/openapi.json is up to date (`pnpm --filter server openapi` regenerates it).
 */

// --- Request bodies -------------------------------------------------------------------------

/** One variant of the job submission union, without the `type` the route supplies. */
function submissionBody(type: "batch_scrape" | "map" | "crawl") {
  const option = jobSubmissionSchema.options.find((entry) => entry.entries.type.literal === type);
  if (!option) throw new Error(`No ${type} submission schema`);
  return v.omit(option, ["type"]);
}

// --- Responses --------------------------------------------------------------------------------

const itemState = v.picklist(["queued", "running", "completed", "failed", "cancelled"]);

export const scrapeSuccessSchema = v.object({
  success: v.literal(true),
  data: scrapeDocumentSchema,
  warning: v.optional(v.string()),
});

export const scrapeErrorSchema = v.object({
  success: v.literal(false),
  code: v.string(),
  error: v.string(),
  details: v.optional(v.array(v.string())),
});

/** Errors from the job, events and artifact endpoints (artifacts add `success: false`). */
export const apiErrorSchema = v.object({
  success: v.optional(v.literal(false)),
  code: v.string(),
  error: v.string(),
  details: v.optional(v.array(v.string())),
});

const jobStatusFields = {
  jobId: jobIdSchema,
  state: jobStateSchema,
  createdAt: jobTimestampSchema,
  updatedAt: jobTimestampSchema,
  startedAt: v.optional(jobTimestampSchema),
  finishedAt: v.optional(jobTimestampSchema),
  error: v.optional(jobErrorSchema),
  progress: jobProgressSchema,
  limits: jobLimitsSchema,
  next: v.optional(v.pipe(v.string(), v.url())),
};

const discoveryItemSchema = v.object({
  url: v.string(),
  finalUrl: v.nullable(v.string()),
  depth: v.number(),
  state: itemState,
  document: v.optional(scrapeDocumentSchema),
  error: v.optional(jobErrorSchema),
});

export const crawlStatusSchema = v.object({
  ...jobStatusFields,
  type: v.literal("crawl"),
  items: v.array(discoveryItemSchema),
  documents: v.array(scrapeDocumentSchema),
});

export const mapStatusSchema = v.object({
  ...jobStatusFields,
  type: v.literal("map"),
  items: v.array(discoveryItemSchema),
  urls: v.array(v.string()),
});

export const batchScrapeStatusSchema = v.object({
  ...jobStatusFields,
  type: v.literal("batch_scrape"),
  cancellationRequestedAt: v.optional(jobTimestampSchema),
  items: v.array(
    v.object({
      itemId: jobItemIdSchema,
      index: v.number(),
      url: v.string(),
      state: itemState,
      document: v.optional(scrapeDocumentSchema),
      error: v.optional(jobErrorSchema),
    }),
  ),
});

export const jobCancelledSchema = v.object({
  jobId: jobIdSchema,
  state: jobStateSchema,
  requestedAt: jobTimestampSchema,
});

const rendererCapabilitiesSchema = v.object({
  available: v.boolean(),
  browser: v.boolean(),
  javascript: v.boolean(),
  screenshots: v.boolean(),
  cdp: v.boolean(),
  computedStyles: v.optional(v.boolean()),
});

export const capabilitiesSchema = v.object({
  success: v.literal(true),
  data: v.object({
    checkedAt: v.string(),
    renderers: v.array(
      v.object({
        name: v.picklist(["lightpanda", "webview"]),
        executable: v.nullable(v.string()),
        version: v.nullable(v.string()),
        capabilities: rendererCapabilitiesSchema,
        error: v.optional(v.string()),
      }),
    ),
    summary: rendererCapabilitiesSchema,
  }),
});

/** Named schemas, emitted as components/schemas and referenced from the operations. */
const components = {
  ScrapeRequest: scrapeRequestSchema,
  // Recursive: a selector's `fields` hold more selectors.
  JsonSelector: jsonSelectorSchema,
  ScrapeDocument: scrapeDocumentSchema,
  ScrapeResponse: scrapeSuccessSchema,
  ScrapeError: scrapeErrorSchema,
  ApiError: apiErrorSchema,
  CrawlRequest: submissionBody("crawl"),
  MapRequest: submissionBody("map"),
  BatchScrapeRequest: submissionBody("batch_scrape"),
  JobSubmitted: jobSubmissionResponseSchema,
  JobError: jobErrorSchema,
  JobProgress: jobProgressSchema,
  CrawlStatus: crawlStatusSchema,
  MapStatus: mapStatusSchema,
  BatchScrapeStatus: batchScrapeStatusSchema,
  JobCancelled: jobCancelledSchema,
  JobEvent: jobEventSchema,
  Capabilities: capabilitiesSchema,
};

// --- Descriptions and defaults ------------------------------------------------------------------

/** [description, default?] for request fields; the generator fails if a field disappears. */
type FieldNotes = Record<string, [string, unknown?]>;

const discoveryNotes = (noun: "crawl" | "map"): FieldNotes => ({
  url: [`Where the ${noun} starts.`],
  maxDepth: ["How many path segments below the start URL to go.", 10],
  maxBytes: ["Most content to download in total, in bytes.", 52_428_800],
  timeoutMs: [`Deadline for the whole ${noun}, in milliseconds.`, 120_000],
  includeSubdomains: ["Also include the site's subdomains.", false],
  pathPrefix:
    noun === "crawl"
      ? ["Stay under the start URL's path; `false` crawls the whole site.", true]
      : ["Stay under the start URL's path.", false],
  webhook: ["Where to POST the job's events, signed with `secret`."],
});

const notes: Partial<Record<keyof typeof components, FieldNotes>> = {
  ScrapeRequest: {
    url: ["The page to scrape: an `http` or `https` URL."],
    formats: ["What to return, each format at most once.", ["markdown"]],
    renderJs: [
      "`auto` renders in a browser only when the page needs JavaScript; `true` always renders; `false` never does.",
      "auto",
    ],
    onlyMainContent: ["Keep only the main content, without navigation, headers and footers.", true],
    waitForMs: ["Extra time to let a rendered page settle, in milliseconds."],
    timeout: ["Deadline for the whole scrape, in milliseconds.", 30_000],
    maxAge: [
      "Accept a cached result up to this many milliseconds old; `0` always scrapes fresh.",
      0,
    ],
    storeInCache: ["Save the result for later `maxAge` requests.", true],
  },
  CrawlRequest: {
    ...discoveryNotes("crawl"),
    maxPages: ["Most pages to crawl.", 100],
    scrapeOptions: ["Scrape options for every page: the fields of `ScrapeRequest` without `url`."],
  },
  MapRequest: { ...discoveryNotes("map"), maxUrls: ["Most URLs to discover.", 100] },
  BatchScrapeRequest: {
    requests: ["The pages to scrape, each a full `ScrapeRequest`."],
    webhook: ["Where to POST the job's events, signed with `secret`."],
  },
};

function annotate(schemas: Record<string, unknown>): void {
  for (const [component, fields] of Object.entries(notes)) {
    const properties = (schemas[component] as { properties?: Record<string, Json> }).properties;
    for (const [field, [description, defaultValue]] of Object.entries(fields ?? {})) {
      const property = properties?.[field];
      if (!property)
        throw new Error(`OpenAPI notes describe ${component}.${field}, which no longer exists`);
      property.description = description;
      if (defaultValue !== undefined) property.default = defaultValue;
    }
  }
}

/** A fixed value (`v.literal`) converts to `{const}` without a type; renderers need the type. */
function typeConstants(node: unknown): void {
  if (Array.isArray(node)) return node.forEach(typeConstants);
  if (typeof node !== "object" || node === null) return;
  const schema = node as Json;
  if ("const" in schema && schema.type === undefined) {
    const value = schema.const;
    schema.type =
      typeof value === "number" ? (Number.isInteger(value) ? "integer" : "number") : typeof value;
  }
  Object.values(schema).forEach(typeConstants);
}

/** Realistic request bodies, so Try it and the code samples don't start from minimum values. */
const examples = {
  scrape: { url: "https://example.com", formats: ["markdown", "links"] },
  crawl: {
    url: "https://example.com/docs",
    maxPages: 50,
    scrapeOptions: { formats: ["markdown"] },
  },
  map: { url: "https://example.com", maxUrls: 500 },
  batch: {
    requests: [{ url: "https://example.com" }, { url: "https://example.org", formats: ["html"] }],
  },
};

// --- Document ----------------------------------------------------------------------------------

type Json = Record<string, unknown>;

const ref = (name: keyof typeof components) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema: Json, description: string) => ({
  description,
  content: { "application/json": { schema } },
});
const error = (description: string) => json(ref("ApiError"), description);

const jobIdParameter = {
  name: "id",
  in: "path",
  required: true,
  description: "The job ID returned when the job was submitted.",
  schema: { type: "string", pattern: "^job_[0-9a-f]{32}$" },
};

const commonErrors = {
  "401": { $ref: "#/components/responses/Unauthorized" },
};

/** POST, GET, DELETE and events for one job kind. */
function jobPaths(kind: {
  path: string;
  tag: string;
  noun: string;
  request: keyof typeof components;
  status: keyof typeof components;
  submitDescription: string;
  operation: string;
  example: Json;
  jobType: "crawl" | "map" | "batch_scrape";
}): Record<string, Json> {
  return {
    [kind.path]: {
      post: {
        tags: [kind.tag],
        operationId: `start${kind.operation}`,
        summary: `Start a ${kind.noun}`,
        description: kind.submitDescription,
        requestBody: {
          required: true,
          content: { "application/json": { schema: ref(kind.request), example: kind.example } },
        },
        responses: {
          "202": {
            description: "The job was queued.",
            content: {
              "application/json": {
                schema: ref("JobSubmitted"),
                example: {
                  jobId: "job_3f2c9a1b7d4e4c0f8a6b5d2e1c0f9a8b",
                  type: kind.jobType,
                  state: "queued",
                  createdAt: "2026-11-23T10:00:00.000Z",
                },
              },
            },
          },
          "400": error(
            "The request is invalid (`INVALID_JSON`, `INVALID_REQUEST`, `INVALID_URL`).",
          ),
          ...commonErrors,
          "429": error("The server's job queue is full (`QUEUE_FULL`)."),
        },
      },
    },
    [`${kind.path}/{id}`]: {
      parameters: [jobIdParameter],
      get: {
        tags: [kind.tag],
        operationId: `get${kind.operation}`,
        summary: `Get a ${kind.noun}`,
        description:
          "The job's state and progress, and one page of its items. Follow `next` until it is absent; a page also stops at 1 MiB of items. Screenshots and content of 64 KiB or more appear as `artifact://<key>` references; download them from `/v1/artifacts/{key}`.",
        parameters: [
          {
            name: "cursor",
            in: "query",
            description: "Index of the first item to return.",
            schema: { type: "integer", minimum: 0, default: 0 },
          },
          {
            name: "limit",
            in: "query",
            description: "Most items to return.",
            schema: { type: "integer", minimum: 1, maximum: 100, default: 100 },
          },
        ],
        responses: {
          "200": json(ref(kind.status), "The job and a page of its items."),
          "400": error("Invalid job ID or pagination (`INVALID_JOB_ID`, `INVALID_PAGINATION`)."),
          ...commonErrors,
          "404": error("No job of this kind has this ID (`JOB_NOT_FOUND`)."),
        },
      },
      delete: {
        tags: [kind.tag],
        operationId: `cancel${kind.operation}`,
        summary: `Cancel a ${kind.noun}`,
        description:
          "Cancels queued items at once. The job is `cancelled` when nothing was running, else `cancelling` until running items finish. A finished job keeps its state.",
        responses: {
          "200": json(ref("JobCancelled"), "Cancellation was requested."),
          "400": error("Invalid job ID (`INVALID_JOB_ID`)."),
          ...commonErrors,
          "404": error("No job of this kind has this ID (`JOB_NOT_FOUND`)."),
        },
      },
    },
    [`${kind.path}/{id}/events`]: {
      parameters: [jobIdParameter],
      get: {
        tags: [kind.tag],
        operationId: `stream${kind.operation}Events`,
        summary: `Stream ${kind.noun} events`,
        description:
          "Server-sent events. The stream opens with a `snapshot` event (the job's `state` and `progress`), then sends each stored event with its sequence as the SSE `id`; each event's data is a `JobEvent`. Resume with `Last-Event-ID` or `?after=`. The stream closes after the job finishes.",
        parameters: [
          {
            name: "after",
            in: "query",
            description: "Resume after this event sequence. `Last-Event-ID` does the same.",
            schema: { type: "integer", minimum: 0 },
          },
          {
            name: "Last-Event-ID",
            in: "header",
            description: "The last event sequence received, to resume a stream.",
            schema: { type: "string" },
          },
        ],
        responses: {
          "200": {
            description: "An event stream; each event's data is a `JobEvent` (see components).",
            content: { "text/event-stream": { schema: { type: "string" } } },
          },
          "400": error("Invalid job ID or event ID (`INVALID_JOB_ID`, `INVALID_EVENT_ID`)."),
          ...commonErrors,
          "404": error("No job of this kind has this ID (`JOB_NOT_FOUND`)."),
        },
      },
    },
  };
}

export function buildOpenApiDocument(): Json {
  const schemas = toJsonSchemaDefs(components, {
    target: "draft-2020-12",
    // Cross-field checks (e.g. unique formats, progress counters adding up) have no JSON Schema
    // equivalent; the server still enforces them.
    errorMode: "ignore",
  });
  // A recursive (v.lazy) schema comes out as an unnamed numbered definition that its named alias
  // only points to; fold it into the alias so every component has a real name.
  const named: Record<string, unknown> = { ...schemas };
  for (const [name, schema] of Object.entries(schemas)) {
    const target = /^#\/\$defs\/(\d+)$/.exec((schema as { $ref?: string }).$ref ?? "")?.[1];
    if (target === undefined || /^\d+$/.test(name)) continue;
    named[name] = named[target];
    delete named[target];
  }
  const unnamed = Object.keys(named).filter((name) => /^\d+$/.test(name));
  if (unnamed.length > 0) {
    throw new Error(`Add a name to the OpenAPI components for definitions ${unnamed.join(", ")}`);
  }
  annotate(named);
  typeConstants(named);
  // The converter links definitions as #/$defs/<name>; OpenAPI keeps them in components.
  const componentSchemas = JSON.parse(
    JSON.stringify(named).replaceAll('"#/$defs/', '"#/components/schemas/'),
  ) as Json;

  return {
    openapi: "3.1.0",
    info: {
      title: "Buncrawl API",
      version: "v1",
      description:
        "Scrape, crawl and map websites into clean Markdown, HTML, links, screenshots and structured JSON. Send your `BUNCRAWL_API_KEY` as a Bearer token. Firecrawl v2-compatible endpoints live under `/v2`; see the Firecrawl compatibility guide.",
      license: { name: "MIT", identifier: "MIT" },
    },
    // Every reader runs their own server; Try it offers a custom base URL for anything else.
    servers: [
      {
        url: "http://localhost:3000",
        description: "Your buncrawl server (enter its URL if remote)",
      },
    ],
    security: [{ bearerAuth: [] }],
    tags: [
      { name: "Scrape", description: "Scrape one page." },
      { name: "Crawl", description: "Follow links from a start page and scrape every page." },
      { name: "Map", description: "Discover a site's URLs." },
      { name: "Batch scrape", description: "Scrape a list of URLs." },
      { name: "Artifacts", description: "Screenshots and large content from job results." },
      { name: "Server", description: "Health and capabilities." },
    ],
    paths: {
      "/v1/scrape": {
        post: {
          tags: ["Scrape"],
          operationId: "scrape",
          summary: "Scrape a page",
          description:
            "Fetches one page and returns it in the requested formats. JavaScript-heavy pages are rendered in a browser when `renderJs` is `auto` (the default) or `true`.",
          requestBody: {
            required: true,
            content: {
              "application/json": { schema: ref("ScrapeRequest"), example: examples.scrape },
            },
          },
          responses: {
            "200": json(ref("ScrapeResponse"), "The scraped page."),
            "400": json(
              ref("ScrapeError"),
              "The request or URL is invalid (`INVALID_JSON`, `INVALID_REQUEST`, `INVALID_URL`, `BLOCKED_DESTINATION`).",
            ),
            ...commonErrors,
            "502": json(
              ref("ScrapeError"),
              "The page could not be fetched (`DNS_RESOLUTION_FAILED`, `FETCH_FAILED`, `INVALID_REDIRECT`, `TOO_MANY_REDIRECTS`, `RESPONSE_TOO_LARGE`).",
            ),
            "503": json(
              ref("ScrapeError"),
              "A browser was needed and none is available (`RENDERER_UNAVAILABLE`).",
            ),
            "504": json(ref("ScrapeError"), "The scrape timed out (`DEADLINE_EXCEEDED`)."),
          },
        },
      },
      ...jobPaths({
        path: "/v1/crawl",
        tag: "Crawl",
        noun: "crawl",
        operation: "Crawl",
        request: "CrawlRequest",
        status: "CrawlStatus",
        example: examples.crawl,
        jobType: "crawl",
        submitDescription:
          "Starts a background job that follows links from `url` within the same site, respecting robots.txt, and scrapes each page with `scrapeOptions`.",
      }),
      ...jobPaths({
        path: "/v1/map",
        tag: "Map",
        noun: "map",
        operation: "Map",
        request: "MapRequest",
        status: "MapStatus",
        example: examples.map,
        jobType: "map",
        submitDescription:
          "Starts a background job that discovers the site's URLs from its sitemaps and links.",
      }),
      ...jobPaths({
        path: "/v1/batch/scrape",
        tag: "Batch scrape",
        noun: "batch scrape",
        operation: "BatchScrape",
        request: "BatchScrapeRequest",
        status: "BatchScrapeStatus",
        example: examples.batch,
        jobType: "batch_scrape",
        submitDescription:
          "Starts a background job that scrapes up to 1,000 URLs, each with its own scrape options. The job has 120 seconds in total.",
      }),
      "/v1/artifacts/{key}": {
        parameters: [
          {
            name: "key",
            in: "path",
            required: true,
            description: "The key from an `artifact://<key>` reference in a job result.",
            schema: { type: "string", pattern: "^[0-9a-f]{32}\\.[a-z0-9]{1,10}$" },
          },
        ],
        get: {
          tags: ["Artifacts"],
          operationId: "getArtifact",
          summary: "Download an artifact",
          description:
            "A screenshot or large page content referenced from a job result, with its original content type. Responses are sandboxed so stored HTML never runs scripts.",
          responses: {
            "200": {
              description: "The stored file.",
              content: {
                "image/png": { schema: { type: "string", contentMediaType: "image/png" } },
                "text/markdown": { schema: { type: "string" } },
                "text/html": { schema: { type: "string" } },
              },
            },
            "400": error("The key is malformed (`INVALID_ARTIFACT_KEY`)."),
            ...commonErrors,
            "404": error("No artifact has this key (`ARTIFACT_NOT_FOUND`)."),
            "502": error("The artifact store could not be read (`ARTIFACT_STORE_FAILED`)."),
          },
        },
      },
      "/v1/capabilities": {
        get: {
          tags: ["Server"],
          operationId: "getCapabilities",
          summary: "Get browser capabilities",
          description:
            "The report of the server's startup check: which browsers it found, their versions, and what they can do.",
          responses: {
            "200": json(ref("Capabilities"), "The capability report."),
            ...commonErrors,
          },
        },
      },
      "/": {
        get: {
          tags: ["Server"],
          operationId: "health",
          summary: "Health check",
          description: "Answers `OK` without an API key.",
          security: [],
          responses: {
            "200": {
              description: "The server is up.",
              content: { "text/plain": { schema: { type: "string", const: "OK" } } },
            },
          },
        },
      },
    },
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          description: "A key from the server's `BUNCRAWL_API_KEY`.",
        },
      },
      responses: {
        Unauthorized: json(
          ref("ApiError"),
          "The server requires an API key and none, or a wrong one, was sent (`UNAUTHORIZED`).",
        ),
      },
      schemas: componentSchemas,
    },
  };
}
