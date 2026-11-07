import { errorCodeOf } from "@buncrawl/core";

import type { RenderRequest, Renderer, RendererCapabilities, RenderResult } from "./renderer";

export type RenderResultAcceptance = (result: RenderResult) => boolean;

export interface FallbackOptions {
  /**
   * Start the next renderer this many milliseconds after the previous one started, instead of
   * waiting for it to fail or be rejected, provided the next renderer has idle capacity. The first
   * accepted result wins. Omit to run renderers strictly one after another.
   */
  startFallbackAfterMs?: number;
}

export interface FallbackRenderer extends Renderer {
  renderWithFallback(
    request: RenderRequest,
    accept: RenderResultAcceptance,
    options?: FallbackOptions,
  ): Promise<RenderResult>;
}

export class RendererChain implements FallbackRenderer {
  readonly name = "renderer-chain";

  constructor(private readonly renderers: readonly Renderer[]) {
    if (renderers.length === 0) throw new TypeError("RendererChain requires at least one renderer");
  }

  capabilities(): RendererCapabilities {
    const available = this.renderers.filter((renderer) => renderer.capabilities().available);
    return {
      available: available.length > 0,
      browser: available.some((renderer) => renderer.capabilities().browser),
      javascript: available.some((renderer) => renderer.capabilities().javascript),
      screenshots: available.some((renderer) => renderer.capabilities().screenshots),
      cdp: available.some((renderer) => renderer.capabilities().cdp),
    };
  }

  render(request: RenderRequest): Promise<RenderResult> {
    return this.renderWithFallback(request, () => true);
  }

  renderWithFallback(
    request: RenderRequest,
    accept: RenderResultAcceptance,
    options: FallbackOptions = {},
  ): Promise<RenderResult> {
    const renderers = this.orderedRenderers(request);
    const signal = request.deadline.signal;
    const results: RenderResult[] = [];
    let lastError: unknown;
    let started = 0;
    let running = 0;
    let done = false;
    let hedge: ReturnType<typeof setTimeout> | undefined;

    return new Promise<RenderResult>((resolve, reject) => {
      const finish = (settle: () => void) => {
        if (done) return;
        done = true;
        clearTimeout(hedge);
        settle();
      };

      // Losers are not cancelled: aborting an isolated render kills its warm worker, which costs
      // more than letting it finish within the request deadline.
      const startNext = (): boolean => {
        if (done || started >= renderers.length) return false;
        const stopped = request.deadline.stopReason();
        if (stopped !== undefined) {
          finish(() => reject(stopped));
          return false;
        }
        const index = started++;
        running++;
        Promise.resolve()
          .then(() => renderers[index]!.render(request))
          .then(
            (result) => {
              running--;
              results[index] = result;
              if (accept(result)) finish(() => resolve(result));
              else continueOrSettle();
            },
            (error: unknown) => {
              running--;
              if (isTerminalError(error, signal)) finish(() => reject(error));
              else {
                lastError = error;
                continueOrSettle();
              }
            },
          )
          .catch((error: unknown) => finish(() => reject(error)));
        scheduleRace();
        return true;
      };

      const continueOrSettle = () => {
        if (done || startNext() || running > 0) return;
        // Nothing was accepted: keep the latest renderer's result, as sequential fallback did.
        const latest = results.findLast((result) => result !== undefined);
        finish(() =>
          latest
            ? resolve(latest)
            : reject(lastError ?? new Error("No browser renderer is available")),
        );
      };

      const scheduleRace = () => {
        clearTimeout(hedge);
        const delay = options.startFallbackAfterMs;
        if (delay === undefined || started >= renderers.length) return;
        hedge = setTimeout(() => {
          if (renderers[started]?.hasIdleCapacity?.() !== false) startNext();
        }, delay);
      };

      if (!startNext()) finish(() => reject(new Error("No browser renderer is available")));
    });
  }

  close(): void {
    for (const renderer of this.renderers) {
      if ("close" in renderer && typeof renderer.close === "function") renderer.close();
    }
  }

  private orderedRenderers(request: RenderRequest): Renderer[] {
    const available = this.renderers.filter((renderer) => renderer.capabilities().available);
    if (!request.screenshot) return available;

    // Lightpanda's CLI requires separate navigations for HTML and PNG. Prefer
    // WebView, which captures both from one loaded page, when it is available.
    return available.sort((left, right) => screenshotPriority(left) - screenshotPriority(right));
  }
}

export function isFallbackRenderer(renderer: Renderer): renderer is FallbackRenderer {
  return "renderWithFallback" in renderer && typeof renderer.renderWithFallback === "function";
}

function screenshotPriority(renderer: Renderer): number {
  if (renderer.name.includes("webview")) return 0;
  if (renderer.name.includes("lightpanda")) return 2;
  return 1;
}

function isTerminalError(error: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return true;
  return [
    "INVALID_URL",
    "BLOCKED_DESTINATION",
    "DNS_RESOLUTION_FAILED",
    "REQUEST_CANCELLED",
    "DEADLINE_EXCEEDED",
  ].includes(errorCodeOf(error) ?? "");
}
