import type { JsonSelectors } from "@buncrawl/contracts";

import { absolutizeHtmlUrls } from "./clean";
import { extractDocument, type ExtractedDocument } from "./extract";
import { extractJson } from "./json";

export interface ExtractJob {
  html: string;
  baseUrl: string;
  onlyMainContent: boolean;
  /** Return the absolutized HTML as well; skip it when unused to avoid copying it between threads. */
  includeRawHtml?: boolean;
  /** Selectors for the `json` format, applied to the absolutized full page. */
  jsonSelectors?: JsonSelectors;
}

export interface ExtractJobOutput {
  extracted: ExtractedDocument;
  rawHtml?: string;
  json?: Record<string, unknown>;
}

export interface ExtractJobMessage {
  id: number;
  job: ExtractJob;
}

export type ExtractJobReply =
  | { id: number; output: ExtractJobOutput }
  | { id: number; error: string };

export function runExtractJob(job: ExtractJob): ExtractJobOutput {
  const rawHtml = absolutizeHtmlUrls(job.html, job.baseUrl);
  const extracted = extractDocument(rawHtml, {
    baseUrl: job.baseUrl,
    onlyMainContent: job.onlyMainContent,
  });
  return {
    extracted,
    ...(job.includeRawHtml ? { rawHtml } : {}),
    ...(job.jsonSelectors ? { json: extractJson(rawHtml, job.jsonSelectors) } : {}),
  };
}
