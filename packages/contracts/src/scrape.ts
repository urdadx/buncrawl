import * as v from "valibot";

export const scrapeFormatSchema = v.picklist([
  "markdown",
  "html",
  "rawHtml",
  "links",
  "screenshots",
]);

export const scrapeRequestSchema = v.strictObject({
  url: v.pipe(
    v.string(),
    v.nonEmpty("URL is required"),
    v.url("URL must be valid"),
    v.regex(/^https?:\/\//i, "URL must use HTTP or HTTPS"),
  ),
  formats: v.optional(
    v.pipe(
      v.array(scrapeFormatSchema),
      v.minLength(1, "At least one format is required"),
      v.maxLength(5, "Too many formats"),
      v.check((formats) => new Set(formats).size === formats.length, "Formats must be unique"),
    ),
  ),
  renderJs: v.optional(v.union([v.boolean(), v.literal("auto")])),
  onlyMainContent: v.optional(v.boolean()),
  timeout: v.optional(
    v.pipe(
      v.number(),
      v.integer("Timeout must be an integer"),
      v.minValue(1, "Timeout must be positive"),
      v.maxValue(120_000, "Timeout cannot exceed 120000ms"),
    ),
  ),
});

export type ScrapeFormat = v.InferOutput<typeof scrapeFormatSchema>;
export type ScrapeRequest = v.InferOutput<typeof scrapeRequestSchema>;

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
    renderer: string;
  };
}

export type ScrapeResponse =
  | { success: true; data: ScrapeDocument; warning?: string }
  | { success: false; error: string; code: string };
