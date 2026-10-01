import { cleanHtml, type CleanHtmlOptions } from "./clean";
import { extractLinks } from "./links";
import { htmlToMarkdown } from "./markdown";
import { extractMetadata, type DocumentMetadata } from "./metadata";

export interface ExtractDocumentOptions extends CleanHtmlOptions {}

export interface ExtractedDocument {
  html: string;
  markdown: string;
  links: string[];
  metadata: DocumentMetadata;
}

export function extractDocument(
  rawHtml: string,
  options: ExtractDocumentOptions,
): ExtractedDocument {
  // Metadata and links are read before cleaning so head elements and navigation
  // links remain available even when they are omitted from main-content output.
  const metadata = extractMetadata(rawHtml, options.baseUrl);
  const links = extractLinks(rawHtml, options.baseUrl);
  const html = cleanHtml(rawHtml, options);
  const markdown = htmlToMarkdown(html);

  return { html, markdown, links, metadata };
}
