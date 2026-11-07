import { absolutizeHtmlUrls } from "./clean";
import { extractDocument, type ExtractedDocument } from "./extract";

export interface ExtractJob {
  html: string;
  baseUrl: string;
  onlyMainContent: boolean;
  /** Return the absolutized HTML as well; skip it when unused to avoid copying it between threads. */
  includeRawHtml?: boolean;
}

export interface ExtractJobOutput {
  extracted: ExtractedDocument;
  rawHtml?: string;
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
  return { extracted, ...(job.includeRawHtml ? { rawHtml } : {}) };
}
