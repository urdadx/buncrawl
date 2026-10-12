import {
  installBrowserNetworkGuard,
  type BrowserNetworkGuard,
  type BrowserNetworkSafetyOptions,
  type CdpEvent,
} from "./browser-safety";
import type { RenderRequest, Renderer, RendererCapabilities, RenderResult } from "./renderer";

const DEFAULT_WIDTH = 1280;
const DEFAULT_HEIGHT = 800;
const DEFAULT_STABILITY_TIMEOUT_MS = 2000;
const STABILITY_POLL_MS = 100;
const REQUIRED_STABLE_SAMPLES = 2;
const MEANINGFUL_TEXT_LENGTH = 20;
const MAX_SCREENSHOT_PIXELS = 100_000_000;
const MAX_LAZY_LOAD_MS = 2500;
const MAX_LAZY_SCROLL_STEPS = 80;
const LAZY_SCROLL_PAUSE_MS = 50;
const MAX_ASSET_WAIT_MS = 1000;
const MAX_NAVIGATION_WAIT_MS = 10_000;

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
    const timings: Record<string, number> = {};
    let view: WebViewLike;
    const createStartedAt = performance.now();
    try {
      view = this.factory({
        width: request.viewport?.width ?? DEFAULT_WIDTH,
        height: request.viewport?.height ?? DEFAULT_HEIGHT,
        ...(this.launchBackend ? { backend: this.launchBackend } : {}),
        dataStore: "ephemeral",
      });
      timings.createViewMs = performance.now() - createStartedAt;
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
      const navigationStartedAt = performance.now();
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
        } else if (this.usesCdpNavigation()) {
          // Bun creates the CDP session on the first WebView navigation.
          await view.navigate("about:blank");
        }
        if (request.viewport && view.cdp) {
          await view.cdp("Emulation.setDeviceMetricsOverride", {
            width: request.viewport.width,
            height: request.viewport.height,
            deviceScaleFactor: 1,
            mobile: false,
          });
        }
        if (this.usesCdpNavigation() && this.networkSafety === false && view.cdp) {
          const navigation = await view.cdp("Page.navigate", { url: request.url });
          const errorText = readNavigationError(navigation);
          if (errorText) throw new Error(errorText);
        } else {
          await waitForNavigation(
            view.navigate(request.url),
            Math.min(MAX_NAVIGATION_WAIT_MS, request.deadline.remainingMs),
            request.deadline.signal,
          );
        }
        await networkGuard?.settled(2000);
        networkGuard?.throwIfBlocked();
        timings.navigationMs = performance.now() - navigationStartedAt;
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
        const waitStartedAt = performance.now();
        await sleepWithinDeadline(request.waitForMs, request.deadline.signal);
        timings.explicitWaitMs = performance.now() - waitStartedAt;
      }
      const settleStartedAt = performance.now();
      const readiness = await waitForDomReadiness(
        view,
        Math.min(this.stabilityTimeoutMs, request.deadline.remainingMs),
        request.deadline.signal,
      );
      await networkGuard?.settled(250);
      networkGuard?.throwIfBlocked();
      timings.initialSettleMs = performance.now() - settleStartedAt;
      timings.meaningfulContent = readiness.meaningful ? 1 : 0;

      const fullPage = typeof request.screenshot === "object" && request.screenshot.fullPage;
      if (fullPage) {
        const lazyLoadStartedAt = performance.now();
        await activateLazyContent(
          view,
          request.viewport?.height ?? DEFAULT_HEIGHT,
          Math.min(MAX_LAZY_LOAD_MS, request.deadline.remainingMs),
          request.deadline.signal,
        );
        timings.lazyLoadMs = performance.now() - lazyLoadStartedAt;
      }
      if (request.screenshot) {
        const assetWaitStartedAt = performance.now();
        await waitForVisualAssets(view, Math.min(MAX_ASSET_WAIT_MS, request.deadline.remainingMs));
        timings.assetWaitMs = performance.now() - assetWaitStartedAt;
      }

      const htmlStartedAt = performance.now();
      const html = await view.evaluate("document.documentElement.outerHTML");
      await networkGuard?.settled(250);
      networkGuard?.throwIfBlocked();
      if (typeof html !== "string") {
        throw new WebViewRendererError(
          "WEBVIEW_INVALID_RESULT",
          "WebView returned a non-string document",
        );
      }
      timings.htmlMs = performance.now() - htmlStartedAt;

      let screenshot: RenderResult["screenshot"];
      if (request.screenshot) {
        const screenshotStartedAt = performance.now();
        const data = fullPage
          ? await captureFullPageScreenshot(view)
          : await view.screenshot({ format: "png", encoding: "base64" });
        if (typeof data !== "string") {
          throw new WebViewRendererError(
            "WEBVIEW_INVALID_RESULT",
            "WebView returned an unexpected screenshot encoding",
          );
        }
        screenshot = { data, mimeType: "image/png" };
        timings.screenshotMs = performance.now() - screenshotStartedAt;
      }

      timings.totalMs = performance.now() - startedAt;
      console.info(JSON.stringify({ event: "webview_render", timings }));

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

  private usesCdpNavigation(): boolean {
    if (this.customFactory) return false;
    return (
      this.backend === "chrome" || (this.backend === undefined && process.platform !== "darwin")
    );
  }
}

function readNavigationError(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || !("errorText" in value)) return;
  return typeof value.errorText === "string" && value.errorText ? value.errorText : undefined;
}

async function waitForNavigation(
  navigation: Promise<void>,
  maxWaitMs: number,
  signal: AbortSignal,
): Promise<void> {
  if (maxWaitMs <= 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectTimeout: ((reason?: unknown) => void) | undefined;
  const abort = () => {
    if (timer) clearTimeout(timer);
    rejectTimeout?.(signal.reason ?? new Error("Render aborted"));
  };
  const timeout = new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new Error("Render aborted"));
      return;
    }
    rejectTimeout = reject;
    timer = setTimeout(resolve, maxWaitMs);
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    await Promise.race([navigation, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}

async function waitForVisualAssets(view: WebViewLike, timeoutMs: number): Promise<void> {
  if (timeoutMs <= 0) return;
  await view.evaluate(`(async () => {
    const waitForImage = async (image) => {
      if (!image.complete) {
        await new Promise((resolve) => {
          image.addEventListener("load", resolve, { once: true });
          image.addEventListener("error", resolve, { once: true });
        });
      }
      if (image.naturalWidth > 0 && image.decode) await image.decode().catch(() => undefined);
    };
    await Promise.race([
      Promise.allSettled([
        document.fonts?.ready,
        ...Array.from(document.images).map(waitForImage),
      ]),
      new Promise((resolve) => setTimeout(resolve, ${Math.floor(timeoutMs)})),
    ]);
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  })()`);
}

async function activateLazyContent(
  view: WebViewLike,
  viewportHeight: number,
  budgetMs: number,
  signal: AbortSignal,
): Promise<void> {
  if (budgetMs <= 0) return;
  const expiresAt = performance.now() + budgetMs;
  const original = await readScrollState(view);
  if (!original) return;

  let state = original;
  let stableBottomSamples = 0;
  for (let step = 0; step < MAX_LAZY_SCROLL_STEPS && performance.now() < expiresAt; step++) {
    throwIfAborted(signal);
    const nextY = Math.min(
      Math.max(0, state.scrollHeight - viewportHeight),
      state.scrollY + Math.max(1, Math.floor(viewportHeight * 0.8)),
    );
    await view.evaluate(`window.scrollTo({ top: ${nextY}, behavior: "instant" })`);
    await sleepWithinDeadline(
      Math.min(LAZY_SCROLL_PAUSE_MS, Math.max(1, expiresAt - performance.now())),
      signal,
    );
    const next = await readScrollState(view);
    if (!next) break;

    const atBottom = next.scrollY + next.innerHeight >= next.scrollHeight - 1;
    stableBottomSamples =
      atBottom && next.scrollHeight === state.scrollHeight ? stableBottomSamples + 1 : 0;
    state = next;
    if (stableBottomSamples >= 2) break;
  }

  await view.evaluate(`window.scrollTo({ top: ${original.scrollY}, behavior: "instant" })`);
}

async function readScrollState(view: WebViewLike): Promise<ScrollState | undefined> {
  const value = await view.evaluate(`(() => {
    const root = document.scrollingElement || document.documentElement;
    return {
      scrollY: root.scrollTop,
      scrollHeight: root.scrollHeight,
      innerHeight: window.innerHeight,
    };
  })()`);
  if (typeof value !== "object" || value === null) return;
  const state = value as Partial<ScrollState>;
  if (
    typeof state.scrollY !== "number" ||
    typeof state.scrollHeight !== "number" ||
    typeof state.innerHeight !== "number"
  ) {
    return;
  }
  return state as ScrollState;
}

interface ScrollState {
  scrollY: number;
  scrollHeight: number;
  innerHeight: number;
}

async function captureFullPageScreenshot(view: WebViewLike): Promise<string> {
  if (!view.cdp) {
    throw new WebViewRendererError(
      "WEBVIEW_UNAVAILABLE",
      "Full-page screenshots require the Chromium backend",
    );
  }

  const metrics = await view.cdp("Page.getLayoutMetrics");
  const contentSize = readContentSize(metrics);
  const width = Math.ceil(contentSize.width);
  const height = Math.ceil(contentSize.height);
  if (width * height > MAX_SCREENSHOT_PIXELS) {
    throw new WebViewRendererError(
      "WEBVIEW_INVALID_RESULT",
      `Full-page screenshot exceeds ${MAX_SCREENSHOT_PIXELS} pixels`,
    );
  }

  const captured = await view.cdp("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
    captureBeyondViewport: true,
    clip: { x: 0, y: 0, width, height, scale: 1 },
  });
  if (
    typeof captured !== "object" ||
    captured === null ||
    !("data" in captured) ||
    typeof captured.data !== "string"
  ) {
    throw new WebViewRendererError(
      "WEBVIEW_INVALID_RESULT",
      "Chromium returned an invalid full-page screenshot",
    );
  }
  return captured.data;
}

function readContentSize(value: unknown): { width: number; height: number } {
  if (typeof value !== "object" || value === null || !("contentSize" in value)) {
    throw new WebViewRendererError("WEBVIEW_INVALID_RESULT", "Chromium returned no layout metrics");
  }
  const contentSize = value.contentSize;
  if (typeof contentSize !== "object" || contentSize === null) {
    throw new WebViewRendererError("WEBVIEW_INVALID_RESULT", "Chromium returned no content size");
  }
  const { width, height } = contentSize as { width?: unknown; height?: unknown };
  if (
    typeof width !== "number" ||
    !Number.isFinite(width) ||
    width <= 0 ||
    typeof height !== "number" ||
    !Number.isFinite(height) ||
    height <= 0
  ) {
    throw new WebViewRendererError(
      "WEBVIEW_INVALID_RESULT",
      "Chromium returned invalid content size",
    );
  }
  return { width, height };
}

async function waitForDomReadiness(
  view: WebViewLike,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<{ meaningful: boolean }> {
  const expiresAt = performance.now() + Math.max(0, timeoutMs);
  let previousSignature = "";
  let stableSamples = 0;
  let meaningful = false;

  while (performance.now() < expiresAt) {
    throwIfAborted(signal);
    const state = await view.evaluate(
      `(() => {
        const body = document.body;
        const textLength = (body?.innerText || "").trim().length;
        const visualCount = body
          ? body.querySelectorAll("img, picture, video, canvas, iframe").length
          : 0;
        const appRootChildren = Array.from(
          document.querySelectorAll("#root, #app, #__next, #__nuxt, [data-reactroot]")
        ).reduce((count, root) => count + root.childElementCount, 0);
        return {
          readyState: document.readyState,
          htmlLength: document.documentElement.outerHTML.length,
          textLength,
          visualCount,
          appRootChildren,
        };
      })()`,
    );
    if (!isDomState(state)) return { meaningful: true };

    meaningful =
      state.textLength === undefined ||
      state.textLength >= MEANINGFUL_TEXT_LENGTH ||
      (state.visualCount ?? 0) > 0;
    const signature = `${state.htmlLength}:${state.textLength ?? "?"}:${state.visualCount ?? "?"}:${state.appRootChildren ?? "?"}`;

    if (meaningful && state.readyState === "complete" && signature === previousSignature) {
      stableSamples += 1;
      if (stableSamples >= REQUIRED_STABLE_SAMPLES) return { meaningful: true };
    } else {
      stableSamples = 0;
    }
    previousSignature = signature;
    await sleepWithinDeadline(STABILITY_POLL_MS, signal);
  }
  return { meaningful };
}

// how do we detect a DOM state? We detect a DOM state by evaluating a script in the WebView that returns an object containing the document's readyState and the length of the outerHTML of the document's root element. This allows us to monitor changes in the DOM and determine if it has stabilized.
function isDomState(value: unknown): value is {
  readyState: string;
  htmlLength: number;
  textLength?: number;
  visualCount?: number;
  appRootChildren?: number;
} {
  if (typeof value !== "object" || value === null) return false;
  const state = value as Record<string, unknown>;
  return (
    typeof state.readyState === "string" &&
    typeof state.htmlLength === "number" &&
    (state.textLength === undefined || typeof state.textLength === "number") &&
    (state.visualCount === undefined || typeof state.visualCount === "number") &&
    (state.appRootChildren === undefined || typeof state.appRootChildren === "number")
  );
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
