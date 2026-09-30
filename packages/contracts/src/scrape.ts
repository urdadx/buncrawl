export type ScrapeFormat = "markdown" | "html" | "rawHtml" | "links" | "screenshots";

export interface ScrapeRequest {
  url: string;
  formats?: ScrapeFormat[];
  renderJs?: boolean | "auto";
  onlyMainContent?: boolean;
  timeout?: number;
}

export interface ScrapeDocument {
  markdown?: string;
  html?: string;
  rawHtml?: string;
  links?: string[];
  screenshot?: string;
  metadata: {
    sourceURL: string;
    finalURL: string;
    title?: string;
    statusCode: number;
    contentType?: string;
    renderer: "fetch" | "webview";
  };
}

export type ScrapeResponse =
  | { success: true; data: ScrapeDocument; warning?: string }
  | { success: false; error: string; code: string };
