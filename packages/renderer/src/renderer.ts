import type { Deadline } from "@buncrawl/core";

export interface RenderRequest {
  url: string;
  deadline: Deadline;
  waitForMs?: number;
  screenshot?: boolean;
  viewport?: {
    width: number;
    height: number;
  };
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
}

export interface RendererCapabilities {
  available: boolean;
  browser: boolean;
  javascript: boolean;
  screenshots: boolean;
  cdp: boolean;
}

export interface Renderer {
  readonly name: string;
  capabilities(): RendererCapabilities;
  render(request: RenderRequest): Promise<RenderResult>;
}
