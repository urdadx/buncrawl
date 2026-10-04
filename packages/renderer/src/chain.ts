import type { RenderRequest, Renderer, RendererCapabilities, RenderResult } from "./renderer";

export type RenderResultAcceptance = (result: RenderResult) => boolean;

export interface FallbackRenderer extends Renderer {
  renderWithFallback(
    request: RenderRequest,
    accept: RenderResultAcceptance,
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

  async renderWithFallback(
    request: RenderRequest,
    accept: RenderResultAcceptance,
  ): Promise<RenderResult> {
    const renderers = this.orderedRenderers(request);
    let lastResult: RenderResult | undefined;
    let lastError: unknown;

    for (const renderer of renderers) {
      if (request.deadline.signal.aborted || request.deadline.expired) {
        throw request.deadline.signal.reason ?? new Error("Render deadline expired");
      }
      try {
        const result = await renderer.render(request);
        lastResult = result;
        if (accept(result)) return result;
      } catch (error) {
        if (isTerminalError(error, request.deadline.signal)) throw error;
        lastError = error;
      }
    }

    if (lastResult) return lastResult;
    throw lastError ?? new Error("No browser renderer is available");
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
  return (
    "renderWithFallback" in renderer &&
    typeof renderer.renderWithFallback === "function"
  );
}

function screenshotPriority(renderer: Renderer): number {
  if (renderer.name.includes("webview")) return 0;
  if (renderer.name.includes("lightpanda")) return 2;
  return 1;
}

function isTerminalError(error: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return true;
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  return [
    "INVALID_URL",
    "BLOCKED_DESTINATION",
    "DNS_RESOLUTION_FAILED",
    "REQUEST_CANCELLED",
    "DEADLINE_EXCEEDED",
  ].includes(String(error.code));
}
