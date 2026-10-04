import {
  installBrowserNetworkGuard,
  type BrowserNetworkGuard,
  type BrowserNetworkSafetyOptions,
  type CdpEvent,
} from "./browser-safety";
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
  backend?:
    | WebViewBackend
    | {
        type: WebViewBackend;
        path?: string;
        argv?: string[];
        url?: string | false;
        stdout?: "inherit" | "ignore";
        stderr?: "inherit" | "ignore";
      };
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
  cdp?(method: string, params?: Record<string, unknown>): Promise<unknown>;
  addEventListener?(type: string, listener: (event: CdpEvent) => void): void;
  removeEventListener?(type: string, listener: (event: CdpEvent) => void): void;
  close(): void;
}

type WebViewFactory = (options: WebViewOptions) => WebViewLike;

export interface ChromeLaunchOptions {
  path?: string;
  argv?: readonly string[];
  proxyUrl?: string;
  proxyBypassList?: string;
  stdout?: "inherit" | "ignore";
  stderr?: "inherit" | "ignore";
}

export interface WebViewRendererOptions {
  backend?: WebViewBackend;
  chrome?: ChromeLaunchOptions;
  stabilityTimeoutMs?: number;
  networkSafety?: BrowserNetworkSafetyOptions | false;
  // creates a WebViewLike instance with the given options.
  // It allows for custom implementations of the WebView interface,
  // enabling flexibility in how the renderer interacts with different
  // webview backends or environments.
  factory?: WebViewFactory;
}

export type WebViewRendererErrorCode =
  | "WEBVIEW_INVALID_CONFIG"
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
  private readonly launchBackend?: WebViewOptions["backend"];
  private readonly stabilityTimeoutMs: number;
  private readonly factory: WebViewFactory;
  private readonly customFactory: boolean;
  private readonly networkSafety: BrowserNetworkSafetyOptions | false;

  constructor(options: WebViewRendererOptions = {}) {
    if (options.chrome && options.backend === "webkit") {
      throw new WebViewRendererError(
        "WEBVIEW_INVALID_CONFIG",
        "Chrome launch options cannot be used with the WebKit backend",
      );
    }
    this.backend = options.chrome ? "chrome" : options.backend;
    this.launchBackend = buildLaunchBackend(options.backend, options.chrome);
    this.stabilityTimeoutMs = options.stabilityTimeoutMs ?? DEFAULT_STABILITY_TIMEOUT_MS;
    this.factory = options.factory ?? createNativeWebView;
    this.customFactory = options.factory !== undefined;
    this.networkSafety = options.networkSafety ?? {};
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
        ...(this.launchBackend ? { backend: this.launchBackend } : {}),
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
    let networkGuard: BrowserNetworkGuard | undefined;

    try {
      try {
        if (this.networkSafety !== false) {
          if (!view.cdp || !view.addEventListener || !view.removeEventListener) {
            throw new WebViewRendererError(
              "WEBVIEW_UNAVAILABLE",
              "Safe browser request interception requires the Chromium backend",
            );
          }
          await view.navigate("about:blank");
          networkGuard = await installBrowserNetworkGuard(
            {
              cdp: view.cdp.bind(view),
              addEventListener: view.addEventListener.bind(view),
              removeEventListener: view.removeEventListener.bind(view),
            },
            request.deadline.signal,
            this.networkSafety,
          );
        }
        await view.navigate(request.url);
        await networkGuard?.settled();
        networkGuard?.throwIfBlocked();
      } catch (cause) {
        if (request.deadline.signal.aborted) {
          throw request.deadline.signal.reason ?? cause;
        }
        if (cause instanceof WebViewRendererError || hasSafetyErrorCode(cause)) throw cause;
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
      await networkGuard?.settled();
      networkGuard?.throwIfBlocked();

      const html = await view.evaluate("document.documentElement.outerHTML");
      await networkGuard?.settled();
      networkGuard?.throwIfBlocked();
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
      networkGuard?.close();
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
  // what is stableSamples? It is a counter that tracks how many consecutive samples of the DOM's outerHTML length have remained the same, indicating that the DOM has stabilized and is no longer changing significantly.
  let stableSamples = 0;

  // what is performance.now()? It is a high-resolution timer that provides the current time in milliseconds since the page was loaded. It is used here to measure elapsed time and determine if the DOM has stabilized within the specified timeout.

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

// how do we detect a DOM state? We detect a DOM state by evaluating a script in the WebView that returns an object containing the document's readyState and the length of the outerHTML of the document's root element. This allows us to monitor changes in the DOM and determine if it has stabilized.
function isDomState(value: unknown): value is { readyState: string; htmlLength: number } {
  if (typeof value !== "object" || value === null) return false;
  const state = value as Record<string, unknown>;
  return typeof state.readyState === "string" && typeof state.htmlLength === "number";
}

// sleeps for the specified number of milliseconds, but respects the abort signal.
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

function hasSafetyErrorCode(error: unknown): error is { code: string } {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  return ["INVALID_URL", "BLOCKED_DESTINATION", "DNS_RESOLUTION_FAILED"].includes(
    String(error.code),
  );
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

function buildLaunchBackend(
  backend: WebViewBackend | undefined,
  chrome: ChromeLaunchOptions | undefined,
): WebViewOptions["backend"] {
  if (!chrome) return backend;

  const argv = [...(chrome.argv ?? [])];
  if (chrome.proxyUrl) {
    if (argv.some((argument) => argument.startsWith("--proxy-server"))) {
      throw new WebViewRendererError(
        "WEBVIEW_INVALID_CONFIG",
        "proxyUrl conflicts with an explicit --proxy-server argument",
      );
    }
    argv.push(`--proxy-server=${normalizeProxyUrl(chrome.proxyUrl)}`);
    argv.push(`--proxy-bypass-list=${chrome.proxyBypassList ?? "<-loopback>"}`);
  } else if (chrome.proxyBypassList) {
    throw new WebViewRendererError("WEBVIEW_INVALID_CONFIG", "proxyBypassList requires proxyUrl");
  }

  return {
    type: "chrome",
    // Spawn a dedicated headless browser instead of attaching to a user's
    // existing Chrome, where launch flags and proxy routing cannot be enforced.
    url: false,
    ...(chrome.path ? { path: chrome.path } : {}),
    ...(argv.length > 0 ? { argv } : {}),
    ...(chrome.stdout ? { stdout: chrome.stdout } : {}),
    ...(chrome.stderr ? { stderr: chrome.stderr } : {}),
  };
}

function normalizeProxyUrl(value: string): string {
  let proxy: URL;
  try {
    proxy = new URL(value);
  } catch (cause) {
    throw new WebViewRendererError("WEBVIEW_INVALID_CONFIG", "Invalid Chrome proxy URL", {
      cause,
    });
  }

  if (!["http:", "https:", "socks4:", "socks5:"].includes(proxy.protocol)) {
    throw new WebViewRendererError(
      "WEBVIEW_INVALID_CONFIG",
      "Chrome proxy must use HTTP, HTTPS, SOCKS4, or SOCKS5",
    );
  }
  if (proxy.username || proxy.password) {
    throw new WebViewRendererError(
      "WEBVIEW_INVALID_CONFIG",
      "Authenticated Chrome proxies require CDP authentication and are not supported yet",
    );
  }
  if ((proxy.pathname && proxy.pathname !== "/") || proxy.search || proxy.hash) {
    throw new WebViewRendererError(
      "WEBVIEW_INVALID_CONFIG",
      "Chrome proxy URL cannot contain a path, query, or fragment",
    );
  }

  return `${proxy.protocol}//${proxy.host}`;
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
