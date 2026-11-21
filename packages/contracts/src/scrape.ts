import * as v from "valibot";

/** Applies when a scrape request sets no `timeout`. */
export const DEFAULT_SCRAPE_TIMEOUT_MS = 30_000;

/** Cached scrape results are kept, and may be requested, for at most 30 days. */
export const MAX_CACHE_AGE_MS = 30 * 24 * 60 * 60 * 1000;

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
  v.picklist(["markdown", "html", "rawHtml", "links", "screenshots", "branding"]),
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
      v.maxLength(6, "Too many formats"),
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
  /** Accept a cached result scraped at most this many milliseconds ago; 0 (default) scrapes fresh. */
  maxAge: v.optional(
    v.pipe(
      v.number(),
      v.integer("maxAge must be an integer"),
      v.minValue(0, "maxAge cannot be negative"),
      v.maxValue(MAX_CACHE_AGE_MS, `maxAge cannot exceed ${MAX_CACHE_AGE_MS}ms`),
    ),
  ),
  /** Store a successful result for later maxAge requests; defaults to true. */
  storeInCache: v.optional(v.boolean()),
});

export type ScrapeFormat = v.InferOutput<typeof scrapeFormatSchema>;
export type ScreenshotFormat = v.InferOutput<typeof screenshotFormatSchema>;
export type ScrapeRequest = v.InferOutput<typeof scrapeRequestSchema>;

function formatKey(format: v.InferInput<typeof scrapeFormatSchema>): string {
  return typeof format === "string" ? format : "screenshots";
}

/** True for the "screenshots" format and for screenshot option objects. */
export function isScreenshotFormat(format: ScrapeFormat): boolean {
  return format === "screenshots" || typeof format === "object";
}

/** Formats that can only be produced by a real browser, never from fetched HTML. */
export function isBrowserOnlyFormat(format: ScrapeFormat): boolean {
  return isScreenshotFormat(format) || format === "branding";
}

const brandingColorsSchema = v.strictObject({
  primary: v.optional(v.string()),
  secondary: v.optional(v.string()),
  accent: v.optional(v.string()),
  background: v.optional(v.string()),
  textPrimary: v.optional(v.string()),
  textSecondary: v.optional(v.string()),
  link: v.optional(v.string()),
});

const brandingComponentSchema = v.strictObject({
  background: v.optional(v.string()),
  textColor: v.optional(v.string()),
  borderColor: v.optional(v.string()),
  borderRadius: v.optional(v.string()),
  shadow: v.optional(v.string()),
});

const optionalUrl = v.optional(v.nullable(v.string()));

/**
 * A page's visual identity, measured from computed styles in the browser. Field names follow
 * Firecrawl's branding format; values are deterministic (no LLM), and colors are hex strings.
 */
export const brandingProfileSchema = v.strictObject({
  colorScheme: v.optional(v.picklist(["light", "dark"])),
  brandName: v.optional(v.string()),
  logo: optionalUrl,
  colors: v.optional(brandingColorsSchema),
  fonts: v.optional(v.array(v.strictObject({ family: v.string() }))),
  typography: v.optional(
    v.strictObject({
      fontFamilies: v.optional(
        v.strictObject({
          primary: v.optional(v.string()),
          heading: v.optional(v.string()),
          code: v.optional(v.string()),
        }),
      ),
      fontStacks: v.optional(
        v.strictObject({
          primary: v.optional(v.array(v.string())),
          heading: v.optional(v.array(v.string())),
          code: v.optional(v.array(v.string())),
        }),
      ),
      fontSizes: v.optional(
        v.strictObject({
          h1: v.optional(v.string()),
          h2: v.optional(v.string()),
          h3: v.optional(v.string()),
          body: v.optional(v.string()),
        }),
      ),
      lineHeights: v.optional(
        v.strictObject({ heading: v.optional(v.number()), body: v.optional(v.number()) }),
      ),
      fontWeights: v.optional(
        v.strictObject({ regular: v.optional(v.number()), bold: v.optional(v.number()) }),
      ),
    }),
  ),
  spacing: v.optional(
    v.strictObject({ baseUnit: v.optional(v.number()), borderRadius: v.optional(v.string()) }),
  ),
  components: v.optional(
    v.strictObject({
      buttonPrimary: v.optional(brandingComponentSchema),
      buttonSecondary: v.optional(brandingComponentSchema),
      input: v.optional(brandingComponentSchema),
    }),
  ),
  images: v.optional(
    v.strictObject({
      logo: optionalUrl,
      logoHref: optionalUrl,
      logoAlt: optionalUrl,
      favicon: optionalUrl,
      ogImage: optionalUrl,
    }),
  ),
});

export type BrandingProfile = v.InferOutput<typeof brandingProfileSchema>;

export const scrapeDocumentSchema = v.strictObject({
  markdown: v.optional(v.string()),
  html: v.optional(v.string()),
  rawHtml: v.optional(v.string()),
  links: v.optional(v.array(v.string())),
  screenshot: v.optional(v.string()),
  branding: v.optional(brandingProfileSchema),
  metadata: v.strictObject({
    sourceURL: v.string(),
    finalURL: v.string(),
    title: v.optional(v.string()),
    statusCode: v.pipe(v.number(), v.integer()),
    contentType: v.optional(v.string()),
    renderer: v.string(),
    /** Present when the request set maxAge: whether the result came from the cache. */
    cacheState: v.optional(v.picklist(["hit", "miss"])),
    /** When a cached result was originally scraped (ISO 8601); only on cache hits. */
    cachedAt: v.optional(v.string()),
  }),
});

export type ScrapeDocument = v.InferOutput<typeof scrapeDocumentSchema>;

export type ScrapeResponse =
  | { success: true; data: ScrapeDocument; warning?: string }
  | { success: false; error: string; code: string };
