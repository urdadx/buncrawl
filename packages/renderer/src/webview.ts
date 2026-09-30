import type { RenderRequest, Renderer, RendererCapabilities, RenderResult } from "./renderer";

const DEFAULT_WIDTH = 1280;
const DEFAULT_HEIGHT = 720;
const DEFAULT_STABILITY_TIMEOUT_MS = 2000;
const STABILITY_POLL_MS = 100;
const REQUIRED_STABLE_SAMPLES = 2;

type WebViewBackend = "chrome" | "webkit";

interface WebViewOptions {
  width: number;
  height: number;
  backend?: WebViewBackend | { type: WebViewBackend; url?: string | false };
  dataStore: "ephemeral";
}

interface WebViewLike {
  readonly url: string;
  readonly title: string;
  navigate(url: string): Promise<void>;
  evaluate(script: string): Promise<unknown>;
  screenshot(options: {
    format: "png";
    encoding: "base64";
  }): Promise<string | Blob | Buffer | { name: string; size: number }>;
  close(): void;
}

type WebViewFactory = (options: WebViewOptions) => WebViewLike;

export interface WebViewRendererOptions {
  backend?: WebViewBackend;
  stabilityTimeoutMs?: number;
  factory?: WebViewFactory;
}

export type WebViewRendererErrorCode =
  | "WEBVIEW_UNAVAILABLE"
  | "WEBVIEW_NAVIGATION_FAILED"
  | "WEBVIEW_INVALID_RESULT";

export class WebViewRendererError extends Error {
  constructor(
    readonly code: WebViewRendererErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "WebViewRendererError";
  }
}

export class WebViewRenderer implements Renderer {
  readonly name = "webview";

  private readonly backend?: WebViewBackend;
  private readonly stabilityTimeoutMs: number;
  private readonly factory: WebViewFactory;
  private readonly customFactory: boolean;

  constructor(options: WebViewRendererOptions = {}) {
    this.backend = options.backend;
    this.stabilityTimeoutMs = options.stabilityTimeoutMs ?? DEFAULT_STABILITY_TIMEOUT_MS;
    this.factory = options.factory ?? createNativeWebView;
    this.customFactory = options.factory !== undefined;
  }

  capabilities(): RendererCapabilities {
    const chrome =
      this.backend === "chrome" || (this.backend === undefined && process.platform !== "darwin");
    const available =
      this.customFactory || (hasNativeWebView() && (!chrome || hasChromeExecutable()));
    return {
      available,
      browser: available,
      javascript: available,
      screenshots: available,
      cdp: available && chrome,
    };
  }

  async render(request: RenderRequest): Promise<RenderResult> {
    if (request.deadline.signal.aborted || request.deadline.expired) {
      throw request.deadline.signal.reason ?? new Error("Render deadline expired");
    }

    const startedAt = performance.now();
    let view: WebViewLike;
    try {
      view = this.factory({
        width: request.viewport?.width ?? DEFAULT_WIDTH,
        height: request.viewport?.height ?? DEFAULT_HEIGHT,
        ...(this.backend ? { backend: this.backend } : {}),
        dataStore: "ephemeral",
      });
    } catch (cause) {
      throw new WebViewRendererError("WEBVIEW_UNAVAILABLE", "Bun.WebView is unavailable", {
        cause,
      });
    }

    // Native WebView operations do not accept AbortSignal. Closing the view is
    // the only reliable way to interrupt navigation or evaluation at deadline.
    const abort = () => view.close();
    request.deadline.signal.addEventListener("abort", abort, { once: true });

    try {
      try {
        await view.navigate(request.url);
      } catch (cause) {
        if (request.deadline.signal.aborted) {
          throw request.deadline.signal.reason ?? cause;
        }
        throw new WebViewRendererError(
          "WEBVIEW_NAVIGATION_FAILED",
          `WebView failed to navigate to ${request.url}`,
          { cause },
        );
      }

      if (request.waitForMs && request.waitForMs > 0) {
        await sleepWithinDeadline(request.waitForMs, request.deadline.signal);
      }
      await waitForDomStability(
        view,
        Math.min(this.stabilityTimeoutMs, request.deadline.remainingMs),
        request.deadline.signal,
      );

      const html = await view.evaluate("document.documentElement.outerHTML");
      if (typeof html !== "string") {
        throw new WebViewRendererError(
          "WEBVIEW_INVALID_RESULT",
          "WebView returned a non-string document",
        );
      }

      let screenshot: RenderResult["screenshot"];
      if (request.screenshot) {
        const data = await view.screenshot({ format: "png", encoding: "base64" });
        if (typeof data !== "string") {
          throw new WebViewRendererError(
            "WEBVIEW_INVALID_RESULT",
            "WebView returned an unexpected screenshot encoding",
          );
        }
        screenshot = { data, mimeType: "image/png" };
      }

      return {
        sourceUrl: request.url,
        finalUrl: view.url,
        title: view.title,
        html,
        renderer: this.name,
        elapsedMs: performance.now() - startedAt,
        ...(screenshot ? { screenshot } : {}),
      };
    } finally {
      request.deadline.signal.removeEventListener("abort", abort);
      view.close();
    }
  }
}

async function waitForDomStability(
  view: WebViewLike,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<void> {
  const expiresAt = performance.now() + Math.max(0, timeoutMs);
  let previousLength = -1;
  let stableSamples = 0;

  while (performance.now() < expiresAt) {
    throwIfAborted(signal);
    const state = await view.evaluate(
      "({ readyState: document.readyState, htmlLength: document.documentElement.outerHTML.length })",
    );
    if (!isDomState(state)) return;

    if (state.readyState === "complete" && state.htmlLength === previousLength) {
      stableSamples += 1;
      if (stableSamples >= REQUIRED_STABLE_SAMPLES) return;
    } else {
      stableSamples = 0;
    }
    previousLength = state.htmlLength;
    await sleepWithinDeadline(STABILITY_POLL_MS, signal);
  }
}

function isDomState(value: unknown): value is { readyState: string; htmlLength: number } {
  if (typeof value !== "object" || value === null) return false;
  const state = value as Record<string, unknown>;
  return typeof state.readyState === "string" && typeof state.htmlLength === "number";
}

function sleepWithinDeadline(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new Error("Render aborted"));
      return;
    }

    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", abort, { once: true });

    function finish() {
      signal.removeEventListener("abort", abort);
      resolve();
    }

    function abort() {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("Render aborted"));
    }
  });
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new Error("Render aborted");
}

function hasNativeWebView(): boolean {
  return typeof (Bun as unknown as { WebView?: unknown }).WebView === "function";
}

function hasChromeExecutable(): boolean {
  if (process.env.BUN_CHROME_PATH) return true;
  const candidates =
    process.platform === "win32"
      ? ["chrome", "chromium", "brave", "msedge"]
      : [
          "google-chrome-stable",
          "google-chrome",
          "chromium-browser",
          "chromium",
          "brave-browser",
          "microsoft-edge",
          "chrome",
        ];
  return candidates.some((candidate) => Bun.which(candidate) !== null);
}

function createNativeWebView(options: WebViewOptions): WebViewLike {
  const WebView = (
    Bun as unknown as {
      WebView?: new (options: WebViewOptions) => WebViewLike;
    }
  ).WebView;
  if (!WebView) {
    throw new WebViewRendererError("WEBVIEW_UNAVAILABLE", "This Bun runtime has no WebView API");
  }
  return new WebView(options);
}
