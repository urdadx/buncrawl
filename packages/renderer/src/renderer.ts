import type { BrandingProfile } from "@buncrawl/contracts";
import type { Deadline } from "@buncrawl/core";

export interface RenderRequest {
  url: string;
  deadline: Deadline;
  waitForMs?: number;
  screenshot?: boolean | ScreenshotOptions;
  /** Measure the page's branding from computed styles; needs a renderer that can run scripts. */
  branding?: boolean;
  viewport?: {
    width: number;
    height: number;
  };
}

export interface ScreenshotOptions {
  fullPage?: boolean;
}

export interface RenderResult {
  sourceUrl: string;
  finalUrl: string;
  title: string;
  html: string;
  renderer: string;
  elapsedMs: number;
  screenshot?: {
    data: string;
    mimeType: "image/png";
  };
  branding?: BrandingProfile;
}

export interface RendererCapabilities {
  available: boolean;
  browser: boolean;
  javascript: boolean;
  screenshots: boolean;
  cdp: boolean;
  /** Can read computed page styles, which branding needs; Lightpanda cannot. */
  computedStyles?: boolean;
}

export interface Renderer {
  readonly name: string;
  capabilities(): RendererCapabilities;
  render(request: RenderRequest): Promise<RenderResult>;
  /** Whether a render could start now without queueing; used to decide whether to race renderers. */
  hasIdleCapacity?(): boolean;
}
