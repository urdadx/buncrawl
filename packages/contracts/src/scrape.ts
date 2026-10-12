import * as v from "valibot";

const screenshotViewportSchema = v.strictObject({
  width: v.pipe(
    v.number(),
    v.integer("Viewport width must be an integer"),
    v.minValue(1, "Viewport width must be positive"),
    v.maxValue(7680, "Viewport width cannot exceed 7680"),
  ),
  height: v.pipe(
    v.number(),
    v.integer("Viewport height must be an integer"),
    v.minValue(1, "Viewport height must be positive"),
    v.maxValue(4320, "Viewport height cannot exceed 4320"),
  ),
});

export const screenshotFormatSchema = v.strictObject({
  type: v.literal("screenshot"),
  fullPage: v.optional(v.boolean()),
  viewport: v.optional(screenshotViewportSchema),
});

export const scrapeFormatSchema = v.union([
  v.picklist(["markdown", "html", "rawHtml", "links", "screenshots"]),
  screenshotFormatSchema,
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
      v.check(
        (formats) => new Set(formats.map(formatKey)).size === formats.length,
        "Formats must be unique",
      ),
    ),
  ),
  renderJs: v.optional(v.union([v.boolean(), v.literal("auto")])),
  onlyMainContent: v.optional(v.boolean()),
  waitForMs: v.optional(
    v.pipe(
      v.number(),
      v.integer("waitForMs must be an integer"),
      v.minValue(0, "waitForMs cannot be negative"),
      v.maxValue(30_000, "waitForMs cannot exceed 30000ms"),
    ),
  ),
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
export type ScreenshotFormat = v.InferOutput<typeof screenshotFormatSchema>;
export type ScrapeRequest = v.InferOutput<typeof scrapeRequestSchema>;

function formatKey(format: v.InferInput<typeof scrapeFormatSchema>): string {
  return typeof format === "string" ? format : "screenshots";
}

export const scrapeDocumentSchema = v.strictObject({
  markdown: v.optional(v.string()),
  html: v.optional(v.string()),
  rawHtml: v.optional(v.string()),
  links: v.optional(v.array(v.string())),
  screenshot: v.optional(v.string()),
  metadata: v.strictObject({
    sourceURL: v.string(),
    finalURL: v.string(),
    title: v.optional(v.string()),
    statusCode: v.pipe(v.number(), v.integer()),
    contentType: v.optional(v.string()),
    renderer: v.string(),
  }),
});

export type ScrapeDocument = v.InferOutput<typeof scrapeDocumentSchema>;

export type ScrapeResponse =
  | { success: true; data: ScrapeDocument; warning?: string }
  | { success: false; error: string; code: string };
