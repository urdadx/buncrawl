import {
  DEFAULT_SCRAPE_TIMEOUT_MS,
  isScreenshotFormat,
  type ScrapeDocument,
  type ScrapeFormat,
  type ScrapeRequest,
  type ScrapeResponse,
} from "@buncrawl/contracts";
import { Deadline, errorCodeOf } from "@buncrawl/core";
import {
  extractInBackground,
  type ExtractedDocument,
  type ExtractJob,
  type ExtractJobOutput,
} from "@buncrawl/extract";
import { fetchPage, type FetchImplementation, type FetchPageResult } from "@buncrawl/fetcher";
import {
  detectRenderNeed,
  createIsolatedDefaultRenderer,
  isFallbackRenderer,
  type Renderer,
  type RenderRequest,
  type RenderResult,
} from "@buncrawl/renderer";
import { type DnsResolver, validateResolvedUrl } from "@buncrawl/security";

import { scrapeCacheKey, type ScrapeCache } from "./cache";

const DEFAULT_FORMATS: ScrapeFormat[] = ["markdown"];
let defaultRenderer: Renderer | undefined;

type FetchPage = typeof fetchPage;

export interface ScrapeDependencies {
  fetch?: FetchPage;
  renderer?: Renderer;
  /** Runs HTML extraction; defaults to the shared worker pool so parsing never blocks the event loop. */
  extract?: (job: ExtractJob, signal: AbortSignal) => Promise<ExtractJobOutput>;
  /** Serves `maxAge` requests from earlier results and stores new successful ones. */
  cache?: ScrapeCache;
}

export interface ScrapeContext {
  signal?: AbortSignal;
  resolver?: DnsResolver;
  fetchImpl?: FetchImplementation;
  /** Receives per-phase durations once the scrape finishes, whether it succeeded or not. */
  onTimings?: (timings: ScrapeTimings) => void;
}

/** Milliseconds spent in each scrape phase; phases that did not run are omitted. */
export interface ScrapeTimings {
  fetchMs?: number;
  detectMs?: number;
  renderMs?: number;
  extractMs?: number;
  totalMs: number;
  renderer: string;
}

export async function scrape(
  request: ScrapeRequest,
  context: ScrapeContext = {},
  dependencies: ScrapeDependencies = {},
): Promise<ScrapeResponse> {
  const startedAt = performance.now();
  const timings: Omit<ScrapeTimings, "totalMs"> = { renderer: "none" };
  const timed = async <T>(
    phase: "fetchMs" | "detectMs" | "renderMs" | "extractMs",
    work: () => T | Promise<T>,
  ) => {
    const phaseStartedAt = performance.now();
    try {
      return await work();
    } finally {
      timings[phase] = (timings[phase] ?? 0) + performance.now() - phaseStartedAt;
    }
  };
  try {
    const cache = dependencies.cache;
    const cacheKey = cache ? scrapeCacheKey(request) : undefined;
    const maxAge = request.maxAge ?? 0;
    if (cache && cacheKey && maxAge > 0) {
      const hit = await cache.get(cacheKey, maxAge).catch((error: unknown) => {
        console.warn("Scrape cache read failed; scraping fresh", error);
        return undefined;
      });
      if (hit) {
        timings.renderer = "cache";
        const metadata = { ...hit.document.metadata, cacheState: "hit" as const };
        return {
          success: true,
          data: {
            ...hit.document,
            metadata: { ...metadata, cachedAt: hit.cachedAt.toISOString() },
          },
        };
      }
    }

    const response = await scrapeWithTimings(request, context, dependencies, timed, timings);
    if (!response.success || !cache || !cacheKey) return response;
    if (request.storeInCache !== false) {
      await cache.set(cacheKey, request.url, response.data).catch((error: unknown) => {
        console.warn("Scrape cache write failed", error);
      });
    }
    if (maxAge === 0) return response;
    return {
      ...response,
      data: { ...response.data, metadata: { ...response.data.metadata, cacheState: "miss" } },
    };
  } finally {
    context.onTimings?.({ ...timings, totalMs: performance.now() - startedAt });
  }
}

type Timed = <T>(
  phase: "fetchMs" | "detectMs" | "renderMs" | "extractMs",
  work: () => T | Promise<T>,
) => Promise<T>;

async function scrapeWithTimings(
  request: ScrapeRequest,
  context: ScrapeContext,
  dependencies: ScrapeDependencies,
  timed: Timed,
  timings: Omit<ScrapeTimings, "totalMs">,
): Promise<ScrapeResponse> {
  const deadline = new Deadline(request.timeout ?? DEFAULT_SCRAPE_TIMEOUT_MS, context.signal);
  const formats = request.formats ?? DEFAULT_FORMATS;
  const renderMode = request.renderJs ?? "auto";
  const screenshotRequested = formats.some(isScreenshotFormat);
  const screenshotOnly = screenshotRequested && formats.every(isScreenshotFormat);
  const renderer = dependencies.renderer ?? createDefaultRenderer();
  const performFetch = dependencies.fetch ?? fetchPage;

  if (renderMode === false && screenshotRequested) {
    return failure("INVALID_REQUEST", "screenshots require JavaScript rendering");
  }

  try {
    const forcedRenderUrl =
      renderMode === true || screenshotOnly
        ? await timed("fetchMs", () =>
            validateResolvedUrl(request.url, {
              resolver: context.resolver,
              signal: deadline.signal,
            }),
          )
        : undefined;
    let fetched: FetchPageResult | undefined;
    if (renderMode !== true && !screenshotOnly) {
      fetched = await timed("fetchMs", () =>
        performFetch(request.url, {
          deadline,
          resolver: context.resolver,
          fetchImpl: context.fetchImpl,
        }),
      );
      timings.renderer = "fetch";
    }

    const fetchedDecision = fetched
      ? await timed("detectMs", () =>
          detectRenderNeed(fetched.body, {
            contentType: fetched.contentType,
            statusCode: fetched.statusCode,
          }),
        )
      : undefined;
    const browserRequired = renderMode === true || screenshotRequested;
    const shouldRender = browserRequired || (renderMode === "auto" && fetchedDecision?.render);

    const { rendered, warning, unavailable } = shouldRender
      ? await renderPage({
          request,
          renderer,
          url: fetched?.finalUrl ?? forcedRenderUrl?.href ?? request.url,
          deadline,
          fetched,
          fetchedDecision,
          browserRequired,
          timed,
          timings,
        })
      : {};
    if (unavailable) return failure("RENDERER_UNAVAILABLE", "Browser rendering is unavailable");

    const selectedHtml = rendered?.html ?? fetched?.body;
    const finalUrl = rendered?.finalUrl ?? fetched?.finalUrl ?? request.url;
    if (!selectedHtml) {
      return failure("EMPTY_CONTENT", "Scrape returned no HTML content");
    }

    deadline.throwIfExpired();
    const { rawHtml = "", extracted } = await timed("extractMs", () =>
      (dependencies.extract ?? extractInBackground)(
        {
          html: selectedHtml,
          baseUrl: finalUrl,
          onlyMainContent: request.onlyMainContent ?? true,
          includeRawHtml: hasFormat(formats, "rawHtml"),
        },
        deadline.signal,
      ),
    );
    const document = buildDocument(
      request,
      formats,
      extracted,
      fetched,
      rendered,
      finalUrl,
      rawHtml,
    );

    return { success: true, data: document, ...(warning ? { warning } : {}) };
  } catch (error) {
    return failure(errorCode(error, deadline, context.signal), errorMessage(error));
  }
}

interface RenderOutcome {
  rendered?: RenderResult;
  warning?: string;
  /** A browser was required but none is available. */
  unavailable?: true;
}

/**
 * Renders the page in a browser. When fetched content exists, a render only replaces it if it is
 * better, and a failed render degrades to the fetched content with a warning.
 */
async function renderPage(input: {
  request: ScrapeRequest;
  renderer: Renderer;
  url: string;
  deadline: Deadline;
  fetched: FetchPageResult | undefined;
  fetchedDecision: ReturnType<typeof detectRenderNeed> | undefined;
  browserRequired: boolean;
  timed: Timed;
  timings: Omit<ScrapeTimings, "totalMs">;
}): Promise<RenderOutcome> {
  const { request, renderer, fetched, fetchedDecision, browserRequired } = input;
  if (!renderer.capabilities().available) {
    if (browserRequired || !fetched) return { unavailable: true };
    return { warning: "Browser rendering was unavailable; returned fetched content" };
  }
  const renderRequest = buildRenderRequest(request, input.url, input.deadline);
  const accept = (candidate: RenderResult) =>
    renderRequest.screenshot
      ? candidate.screenshot !== undefined && candidate.html.trim().length > 0
      : isRenderedContentBetter(candidate, fetched, fetchedDecision);
  try {
    const candidate = await input.timed("renderMs", () =>
      isFallbackRenderer(renderer)
        ? renderer.renderWithFallback(
            renderRequest,
            accept,
            // In auto mode a render must beat the fetched page and Lightpanda's often does not,
            // so start the fallback renderer alongside it while it has spare capacity.
            fetched && !browserRequired ? { startFallbackAfterMs: 0 } : {},
          )
        : renderer.render(renderRequest),
    );
    if (browserRequired || isRenderedContentBetter(candidate, fetched, fetchedDecision)) {
      input.timings.renderer = candidate.renderer;
      return { rendered: candidate };
    }
    return { warning: "Browser rendering did not improve the fetched content" };
  } catch (error) {
    if (browserRequired || !fetched) throw error;
    return {
      warning: `Browser rendering failed; returned fetched content: ${errorMessage(error)}`,
    };
  }
}

function buildRenderRequest(
  request: ScrapeRequest,
  url: string,
  deadline: Deadline,
): RenderRequest {
  const screenshotFormat = (request.formats ?? DEFAULT_FORMATS).find(isScreenshotFormat);
  const options = typeof screenshotFormat === "object" ? screenshotFormat : undefined;
  return {
    url,
    deadline,
    ...(request.waitForMs === undefined ? {} : { waitForMs: request.waitForMs }),
    ...(screenshotFormat ? { screenshot: { fullPage: options?.fullPage ?? false } } : {}),
    ...(options?.viewport ? { viewport: options.viewport } : {}),
  };
}

function createDefaultRenderer(): Renderer {
  defaultRenderer ??= createIsolatedDefaultRenderer();
  return defaultRenderer;
}

function isRenderedContentBetter(
  rendered: RenderResult,
  fetched: FetchPageResult | undefined,
  fetchedDecision: ReturnType<typeof detectRenderNeed> | undefined,
): boolean {
  if (!rendered.html.trim()) return false;

  const renderedDecision = detectRenderNeed(rendered.html, { contentType: "text/html" });
  if (
    renderedDecision.render &&
    (renderedDecision.reason === "bot-challenge" ||
      renderedDecision.reason === "loading-placeholder")
  ) {
    return false;
  }

  if (!fetched || !fetchedDecision) return true;
  return renderedDecision.visibleTextLength > fetchedDecision.visibleTextLength;
}

function buildDocument(
  request: ScrapeRequest,
  formats: readonly ScrapeFormat[],
  extracted: ExtractedDocument,
  fetched: FetchPageResult | undefined,
  rendered: RenderResult | undefined,
  finalUrl: string,
  rawHtml: string,
): ScrapeDocument {
  const document: ScrapeDocument = {
    metadata: {
      sourceURL: request.url,
      finalURL: finalUrl,
      title: extracted.metadata.title ?? rendered?.title,
      statusCode: fetched?.statusCode ?? 200,
      contentType: fetched?.contentType ?? "text/html",
      renderer: rendered?.renderer ?? "fetch",
    },
  };

  if (hasFormat(formats, "markdown")) document.markdown = extracted.markdown;
  if (hasFormat(formats, "html")) document.html = extracted.html;
  if (hasFormat(formats, "rawHtml")) document.rawHtml = rawHtml;
  if (hasFormat(formats, "links")) document.links = extracted.links;
  if (formats.some(isScreenshotFormat) && rendered?.screenshot) {
    document.screenshot = screenshotDataUrl(rendered.screenshot);
  }
  return document;
}

function hasFormat(formats: readonly ScrapeFormat[], expected: ScrapeFormat): boolean {
  return formats.includes(expected);
}

function screenshotDataUrl(screenshot: NonNullable<RenderResult["screenshot"]>): string {
  if (screenshot.data.startsWith("data:")) return screenshot.data;
  return `data:${screenshot.mimeType};base64,${screenshot.data}`;
}

function errorCode(error: unknown, deadline: Deadline, parentSignal?: AbortSignal): string {
  if (parentSignal?.aborted) return "REQUEST_CANCELLED";
  if (deadline.expired || deadline.signal.aborted) return "DEADLINE_EXCEEDED";
  return errorCodeOf(error) ?? "SCRAPE_FAILED";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Scrape failed";
}

function failure(code: string, error: string): ScrapeResponse {
  return { success: false, code, error };
}
