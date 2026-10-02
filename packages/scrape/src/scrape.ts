import type {
  ScrapeDocument,
  ScrapeFormat,
  ScrapeRequest,
  ScrapeResponse,
} from "@buncrawl/contracts";
import { Deadline } from "@buncrawl/core";
import { absolutizeHtmlUrls, extractDocument } from "@buncrawl/extract";
import { fetchPage, type FetchImplementation, type FetchPageResult } from "@buncrawl/fetcher";
import {
  detectRenderNeed,
  LightpandaRenderer,
  type Renderer,
  type RenderResult,
  WebViewRenderer,
} from "@buncrawl/renderer";
import { type DnsResolver, validateResolvedUrl } from "@buncrawl/security";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_FORMATS: ScrapeFormat[] = ["markdown"];

type FetchPage = typeof fetchPage;

export interface ScrapeDependencies {
  fetch?: FetchPage;
  renderer?: Renderer;
}

export interface ScrapeContext {
  signal?: AbortSignal;
  resolver?: DnsResolver;
  fetchImpl?: FetchImplementation;
}

export async function scrape(
  request: ScrapeRequest,
  context: ScrapeContext = {},
  dependencies: ScrapeDependencies = {},
): Promise<ScrapeResponse> {
  const deadline = new Deadline(request.timeout ?? DEFAULT_TIMEOUT_MS, context.signal);
  const formats = request.formats ?? DEFAULT_FORMATS;
  const renderMode = request.renderJs ?? "auto";
  const screenshotRequested = formats.includes("screenshots");
  const renderer = dependencies.renderer ?? createDefaultRenderer();
  const performFetch = dependencies.fetch ?? fetchPage;

  if (renderMode === false && screenshotRequested) {
    return failure("INVALID_REQUEST", "screenshots require JavaScript rendering");
  }

  try {
    const forcedRenderUrl =
      renderMode === true
        ? await validateResolvedUrl(request.url, {
            resolver: context.resolver,
            signal: deadline.signal,
          })
        : undefined;
    let fetched: FetchPageResult | undefined;
    if (renderMode !== true) {
      fetched = await performFetch(request.url, {
        deadline,
        resolver: context.resolver,
        fetchImpl: context.fetchImpl,
      });
    }

    const fetchedDecision = fetched
      ? detectRenderNeed(fetched.body, {
          contentType: fetched.contentType,
          statusCode: fetched.statusCode,
        })
      : undefined;
    const browserRequired = renderMode === true || screenshotRequested;
    const shouldRender = browserRequired || (renderMode === "auto" && fetchedDecision?.render);

    let rendered: RenderResult | undefined;
    let warning: string | undefined;
    if (shouldRender) {
      if (!renderer.capabilities().available) {
        if (browserRequired || !fetched) {
          return failure("RENDERER_UNAVAILABLE", "Browser rendering is unavailable");
        }
        warning = "Browser rendering was unavailable; returned fetched content";
      } else {
        try {
          const candidate = await renderer.render({
            url: fetched?.finalUrl ?? forcedRenderUrl?.href ?? request.url,
            deadline,
            screenshot: screenshotRequested,
          });
          if (browserRequired || isRenderedContentBetter(candidate, fetched, fetchedDecision)) {
            rendered = candidate;
          } else {
            warning = "Browser rendering did not improve the fetched content";
          }
        } catch (error) {
          if (browserRequired || !fetched) throw error;
          warning = `Browser rendering failed; returned fetched content: ${errorMessage(error)}`;
        }
      }
    }

    const selectedHtml = rendered?.html ?? fetched?.body;
    const finalUrl = rendered?.finalUrl ?? fetched?.finalUrl ?? request.url;
    if (!selectedHtml) {
      return failure("EMPTY_CONTENT", "Scrape returned no HTML content");
    }

    deadline.throwIfExpired();
    const rawHtml = absolutizeHtmlUrls(selectedHtml, finalUrl);
    const extracted = extractDocument(rawHtml, {
      baseUrl: finalUrl,
      onlyMainContent: request.onlyMainContent ?? true,
    });
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

function createDefaultRenderer(): Renderer {
  const lightpanda = new LightpandaRenderer();
  return lightpanda.capabilities().available ? lightpanda : new WebViewRenderer();
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
  extracted: ReturnType<typeof extractDocument>,
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
      renderer: rendered ? "webview" : "fetch",
    },
  };

  if (formats.includes("markdown")) document.markdown = extracted.markdown;
  if (formats.includes("html")) document.html = extracted.html;
  if (formats.includes("rawHtml")) document.rawHtml = rawHtml;
  if (formats.includes("links")) document.links = extracted.links;
  if (formats.includes("screenshots") && rendered?.screenshot) {
    document.screenshot = rendered.screenshot.data;
  }
  return document;
}

function errorCode(error: unknown, deadline: Deadline, parentSignal?: AbortSignal): string {
  if (parentSignal?.aborted) return "REQUEST_CANCELLED";
  if (deadline.expired || deadline.signal.aborted) return "DEADLINE_EXCEEDED";
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return "SCRAPE_FAILED";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Scrape failed";
}

function failure(code: string, error: string): ScrapeResponse {
  return { success: false, code, error };
}
