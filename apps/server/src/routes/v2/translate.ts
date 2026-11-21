import type { JobError, JobProgress, JobState, ScrapeDocument } from "@buncrawl/contracts";

/**
 * Pure translation between Firecrawl v2 request/response shapes and Buncrawl's canonical
 * contracts. Nothing here executes work; the v2 handlers pass translated requests to the
 * canonical v1 handlers and translate their responses back.
 */

type Json = Record<string, unknown>;

/** Problems found while translating a Firecrawl request. */
export interface Issues {
  /** Malformed input, such as a wrong type or an unknown key. */
  invalid: string[];
  /** Valid Firecrawl options that Buncrawl does not implement. */
  unsupported: string[];
}

export function createIssues(): Issues {
  return { invalid: [], unsupported: [] };
}

/** Whether a key may be sent with this value. `true` means accepted and ignored. */
type Rule = true | ((value: unknown) => boolean);

function isEmpty(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (Array.isArray(value)) return value.length === 0;
  return isObject(value) && Object.keys(value).length === 0;
}

export function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Never supported: only an absent or empty value is accepted. */
const never: Rule = isEmpty;
/** Only Firecrawl's default (or another no-op) value is accepted. */
const only =
  (...allowed: unknown[]): Rule =>
  (value) =>
    isEmpty(value) || allowed.includes(value);

const SCRAPE_OPTION_RULES: Record<string, Rule> = {
  headers: never,
  includeTags: never,
  excludeTags: never,
  actions: never,
  parsers: never,
  location: never,
  minAge: never,
  useMock: never,
  redactPII: only(false),
  threatProtection: never,
  auditMetadata: never,
  profile: never,
  safeMode: only(false),
  mobile: only(false),
  onlyCleanContent: only(false),
  skipTlsVerification: only(false),
  lockdown: only(false),
  checkPromptInjection: only(false),
  fastMode: only(false),
  proxy: only("auto", "basic"),
  removeBase64Images: true,
  blockAds: true,
};

const REQUEST_RULES: Record<string, Rule> = {
  origin: true,
  integration: true,
  zeroDataRetention: only(false),
};

const SCRAPE_REQUEST_RULES: Record<string, Rule> = {
  ...SCRAPE_OPTION_RULES,
  ...REQUEST_RULES,
  domainTools: only(false),
  toolDetail: never,
};

const BATCH_REQUEST_RULES: Record<string, Rule> = {
  ...SCRAPE_OPTION_RULES,
  ...REQUEST_RULES,
  maxConcurrency: true,
  appendToId: never,
};

const DISCOVERY_RULES: Record<string, Rule> = {
  ...REQUEST_RULES,
  includePaths: never,
  excludePaths: never,
  maxDiscoveryDepth: never,
  allowExternalLinks: only(false),
  ignoreRobotsTxt: only(false),
  robotsUserAgent: never,
  sitemap: only("include"),
  deduplicateSimilarURLs: true,
  ignoreQueryParameters: true,
  regexOnFullURL: true,
  delay: never,
};

const CRAWL_RULES: Record<string, Rule> = {
  ...DISCOVERY_RULES,
  maxConcurrency: true,
  prompt: never,
};

const MAP_RULES: Record<string, Rule> = {
  ...DISCOVERY_RULES,
  crawlEntireDomain: true,
  search: never,
  filterByPath: true,
  useIndex: true,
  ignoreCache: true,
  location: never,
  headers: never,
  threatProtection: never,
  auditMetadata: never,
  useMock: never,
};

/** Checks every key the caller did not translate against the endpoint's rules. */
function checkRemaining(body: Json, rules: Record<string, Rule>, prefix: string, issues: Issues) {
  for (const [key, value] of Object.entries(body)) {
    // Firecrawl's internal and experimental options start with "__".
    const rule = rules[key] ?? (key.startsWith("__") ? only(false) : undefined);
    if (!rule) issues.invalid.push(`Unrecognized key: ${prefix}${key}`);
    else if (rule !== true && !rule(value)) issues.unsupported.push(`${prefix}${key}`);
  }
}

const SIMPLE_FORMATS = new Set(["markdown", "html", "rawHtml", "links"]);
const UNSUPPORTED_FORMATS = new Set([
  "rawBase64",
  "images",
  "summary",
  "json",
  "deterministicJson",
  "changeTracking",
  "attributes",
  "question",
  "highlights",
  "query",
  "product",
  "menu",
  "audio",
  "video",
]);

/** Firecrawl formats are strings or `{ type, ...options }` objects. */
function translateFormat(format: unknown, prefix: string, issues: Issues): unknown {
  const options = typeof format === "string" ? { type: format } : format;
  if (!isObject(options) || typeof options.type !== "string") {
    issues.invalid.push(`${prefix}formats entries must be strings or objects with a type`);
    return;
  }
  const { type, ...rest } = options;
  const path = `${prefix}formats[${type}]`;
  if (SIMPLE_FORMATS.has(type)) {
    checkRemaining(rest, {}, `${path}.`, issues);
    return type;
  }
  if (type === "screenshot") {
    const { fullPage, viewport, ...other } = rest;
    checkRemaining(other, { quality: never }, `${path}.`, issues);
    return {
      type: "screenshot",
      ...(fullPage === undefined ? {} : { fullPage }),
      ...(viewport === undefined ? {} : { viewport }),
    };
  }
  if (type === "branding") {
    // Firecrawl also accepts and ignores `mode`.
    checkRemaining(rest, { mode: true }, `${path}.`, issues);
    return "branding";
  }
  if (UNSUPPORTED_FORMATS.has(type)) issues.unsupported.push(path);
  else issues.invalid.push(`Unknown format: ${type}`);
}

/**
 * Firecrawl scrape options to canonical scrape options (without `url`). Firecrawl's defaults
 * (markdown, main content only) are applied explicitly rather than inherited.
 */
export function translateScrapeOptions(
  body: Json,
  issues: Issues,
  {
    prefix = "",
    rules = SCRAPE_OPTION_RULES,
  }: { prefix?: string; rules?: Record<string, Rule> } = {},
): Json {
  const { formats, onlyMainContent, timeout, waitFor, maxAge, storeInCache, ...rest } = body;
  checkRemaining(rest, rules, prefix, issues);
  let translatedFormats: unknown = ["markdown"];
  if (formats !== undefined) {
    if (Array.isArray(formats))
      translatedFormats = formats
        .map((format) => translateFormat(format, prefix, issues))
        .filter((format) => format !== undefined);
    else issues.invalid.push(`${prefix}formats must be an array`);
  }
  return {
    formats: translatedFormats,
    onlyMainContent: onlyMainContent ?? true,
    ...(timeout === undefined ? {} : { timeout }),
    // Firecrawl's default waitFor of 0 means no extra wait, which is Buncrawl's default.
    ...(waitFor === undefined || waitFor === 0 ? {} : { waitForMs: waitFor }),
    ...(maxAge === undefined ? {} : { maxAge }),
    ...(storeInCache === undefined ? {} : { storeInCache }),
  };
}

/** POST /v2/scrape body to a canonical scrape request. */
export function translateScrapeRequest(body: Json, issues: Issues): Json {
  const { url, ...rest } = body;
  if (url === undefined) issues.invalid.push("url is required");
  return { url, ...translateScrapeOptions(rest, issues, { rules: SCRAPE_REQUEST_RULES }) };
}

const FIRECRAWL_WEBHOOK_EVENTS = ["started", "page", "completed", "failed"] as const;

/**
 * Firecrawl webhooks are a URL or `{ url, headers, metadata, events }` signed with a team
 * secret; Buncrawl webhooks carry their own secret, so the server-wide secret is used.
 * Event names map to the canonical events that carry the same information.
 */
export function translateWebhook(
  raw: unknown,
  pageEvent: "item_completed" | "page_completed",
  secret: string | undefined,
  issues: Issues,
): Json | undefined {
  if (raw === undefined || raw === null) return;
  const webhook = typeof raw === "string" ? { url: raw } : raw;
  if (!isObject(webhook)) {
    issues.invalid.push("webhook must be a URL or an object");
    return;
  }
  const { url, events = FIRECRAWL_WEBHOOK_EVENTS, ...rest } = webhook;
  checkRemaining(rest, { headers: never, metadata: never }, "webhook.", issues);
  if (!secret) {
    issues.unsupported.push("webhook (set BUNCRAWL_WEBHOOK_SECRET to enable Firecrawl webhooks)");
    return;
  }
  if (!Array.isArray(events)) {
    issues.invalid.push("webhook.events must be an array");
    return;
  }
  const canonical = new Set<string>();
  for (const event of events) {
    if (event === "started" || event === "completed") canonical.add("state_changed");
    else if (event === "failed") canonical.add("state_changed").add("error");
    else if (event === "page") canonical.add(pageEvent);
    else issues.invalid.push(`Unknown webhook event: ${String(event)}`);
  }
  if (canonical.size === 0) issues.invalid.push("webhook.events must not be empty");
  return { url, secret, events: [...canonical] };
}

/** POST /v2/batch/scrape body to a canonical batch submission (without `type`). */
export function translateBatchScrapeRequest(
  body: Json,
  webhookSecret: string | undefined,
  issues: Issues,
): { submission: Json; invalidURLs?: string[] } {
  const { urls, webhook, ignoreInvalidURLs = true, ...rest } = body;
  const options = translateScrapeOptions(rest, issues, { rules: BATCH_REQUEST_RULES });
  const valid: string[] = [];
  const invalid: string[] = [];
  if (!Array.isArray(urls) || urls.length === 0)
    issues.invalid.push("urls must be a non-empty array");
  else
    for (const url of urls) {
      if (typeof url === "string" && /^https?:\/\//i.test(url) && URL.canParse(url))
        valid.push(url);
      else invalid.push(String(url));
    }
  if (invalid.length > 0 && ignoreInvalidURLs !== true)
    issues.invalid.push(`Invalid URLs: ${invalid.join(", ")}`);
  else if (Array.isArray(urls) && urls.length > 0 && valid.length === 0)
    issues.invalid.push("urls contains no valid URLs");
  const translatedWebhook = translateWebhook(webhook, "item_completed", webhookSecret, issues);
  return {
    submission: {
      requests: valid.map((url) => ({ url, ...options })),
      ...(translatedWebhook ? { webhook: translatedWebhook } : {}),
    },
    ...(ignoreInvalidURLs === true ? { invalidURLs: invalid } : {}),
  };
}

/** Firecrawl's crawl `limit` default. */
export const FIRECRAWL_CRAWL_LIMIT = 10_000;
/** Firecrawl's map `limit` default. */
export const FIRECRAWL_MAP_LIMIT = 5000;

/** POST /v2/crawl body to a canonical crawl submission (without `type`). */
export function translateCrawlRequest(
  body: Json,
  webhookSecret: string | undefined,
  issues: Issues,
): Json {
  const {
    url,
    limit = FIRECRAWL_CRAWL_LIMIT,
    allowSubdomains,
    crawlEntireDomain,
    scrapeOptions = {},
    webhook,
    ...rest
  } = body;
  checkRemaining(rest, CRAWL_RULES, "", issues);
  if (url === undefined) issues.invalid.push("url is required");
  if (!isObject(scrapeOptions)) issues.invalid.push("scrapeOptions must be an object");
  const translatedWebhook = translateWebhook(webhook, "page_completed", webhookSecret, issues);
  return {
    url,
    maxPages: limit,
    ...(allowSubdomains === undefined ? {} : { includeSubdomains: allowSubdomains }),
    // Firecrawl crawls only below the start path unless crawlEntireDomain is set.
    ...(typeof crawlEntireDomain === "boolean" ? { pathPrefix: !crawlEntireDomain } : {}),
    scrapeOptions: translateScrapeOptions(isObject(scrapeOptions) ? scrapeOptions : {}, issues, {
      prefix: "scrapeOptions.",
    }),
    ...(translatedWebhook ? { webhook: translatedWebhook } : {}),
  };
}

/** POST /v2/map body to a canonical map submission (without `type`). */
export function translateMapRequest(body: Json, issues: Issues): Json {
  const {
    url,
    limit = FIRECRAWL_MAP_LIMIT,
    includeSubdomains,
    allowSubdomains,
    timeout,
    ...rest
  } = body;
  checkRemaining(rest, MAP_RULES, "", issues);
  if (url === undefined) issues.invalid.push("url is required");
  return {
    url,
    maxUrls: limit,
    // Firecrawl's map includes subdomains by default.
    includeSubdomains: includeSubdomains ?? allowSubdomains ?? true,
    ...(timeout === undefined ? {} : { timeoutMs: timeout }),
  };
}

export type FirecrawlJobStatus = "scraping" | "completed" | "failed" | "cancelled";

/** Firecrawl reports unfinished jobs, including ones still cancelling, as "scraping". */
export function toFirecrawlStatus(state: JobState): FirecrawlJobStatus {
  return state === "completed" || state === "failed" || state === "cancelled" ? state : "scraping";
}

/** A canonical scrape document in Firecrawl's v2 Document shape. */
export function toFirecrawlDocument(document: ScrapeDocument, warning?: string): Json {
  const { metadata, ...content } = document;
  return {
    ...content,
    ...(warning ? { warning } : {}),
    metadata: {
      ...(metadata.title === undefined ? {} : { title: metadata.title }),
      sourceURL: metadata.sourceURL,
      url: metadata.finalURL,
      statusCode: metadata.statusCode,
      ...(metadata.contentType === undefined ? {} : { contentType: metadata.contentType }),
      proxyUsed: "basic",
      ...(metadata.cacheState === undefined ? {} : { cacheState: metadata.cacheState }),
      ...(metadata.cachedAt === undefined ? {} : { cachedAt: metadata.cachedAt }),
    },
  };
}

/** The canonical job status fields the Firecrawl status response needs. */
export interface CanonicalJobStatus {
  state: JobState;
  progress: JobProgress;
  createdAt: string;
  finishedAt?: string;
  error?: JobError;
}

export function toFirecrawlJobStatus(
  job: CanonicalJobStatus,
  documents: ScrapeDocument[],
  next: string | undefined,
): Json {
  const status = toFirecrawlStatus(job.state);
  return {
    success: !(status === "failed" && job.error),
    status,
    completed: job.progress.succeeded,
    total: job.progress.total,
    // Self-hosted Buncrawl has no billing; one credit per scraped page mirrors Firecrawl.
    creditsUsed: job.progress.succeeded,
    createdAt: job.createdAt,
    ...(job.finishedAt ? { completedAt: job.finishedAt } : {}),
    ...(status === "failed" && job.error ? { error: job.error.message } : {}),
    ...(next ? { next } : {}),
    data: documents.map((document) => toFirecrawlDocument(document)),
  };
}

const ERROR_CODES: Record<string, { code: string; status?: number }> = {
  DEADLINE_EXCEEDED: { code: "SCRAPE_TIMEOUT", status: 408 },
  DNS_RESOLUTION_FAILED: { code: "SCRAPE_DNS_RESOLUTION_ERROR" },
  REQUEST_CANCELLED: { code: "SCRAPE_JOB_CANCELLED" },
  JOB_NOT_FOUND: { code: "JOB_NOT_FOUND" },
};

/** A canonical error response body in Firecrawl's `{ success: false, error }` shape. */
export function toFirecrawlError(status: number, body: unknown): Response {
  const canonical = isObject(body) ? body : {};
  const code = typeof canonical.code === "string" ? canonical.code : undefined;
  const mapped = code ? ERROR_CODES[code] : undefined;
  return Response.json(
    {
      success: false,
      ...(code ? { code: mapped?.code ?? code } : {}),
      error: typeof canonical.error === "string" ? canonical.error : "Request failed",
      ...(canonical.details === undefined ? {} : { details: canonical.details }),
    },
    { status: mapped?.status ?? status },
  );
}

/** A 400 response for malformed or unsupported Firecrawl options, or undefined when clean. */
export function issuesResponse(issues: Issues): Response | undefined {
  if (issues.invalid.length > 0)
    return Response.json(
      { success: false, code: "BAD_REQUEST", error: "Bad Request", details: issues.invalid },
      { status: 400 },
    );
  if (issues.unsupported.length > 0)
    return Response.json(
      {
        success: false,
        code: "UNSUPPORTED_OPTION",
        error: `Buncrawl does not support these Firecrawl options: ${issues.unsupported.join(", ")}`,
        details: issues.unsupported,
      },
      { status: 400 },
    );
}
