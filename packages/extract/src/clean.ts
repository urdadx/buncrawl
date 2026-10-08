import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";

const ALWAYS_REMOVE = "script, style, noscript, iframe, canvas, template";
const MAIN_CONTENT_REMOVE = [
  "body > header",
  "body > footer",
  "body > aside",
  "nav",
  "menu",
  "select",
  '[role="navigation"]',
  '[role="banner"]',
  '[role="contentinfo"]',
  ".cookie-banner",
  ".cookie-consent",
  ".advertisement",
  ".recommendations",
  ".related-content",
  '[aria-label="related"]',
];
const MIN_READABLE_TEXT = 200;
const MIN_READABLE_RETENTION = 0.65;
const MIN_READABLE_IMPROVEMENT = 1.05;

export interface CleanHtmlOptions {
  baseUrl: string;
  onlyMainContent?: boolean;
  excludeSelectors?: readonly string[];
}

export function absolutizeHtmlUrls(html: string, documentUrl: string): string {
  let baseUrl = documentUrl;
  const rewriter = new HTMLRewriter();

  rewriter.on("[href]", {
    element(element) {
      const href = element.getAttribute("href");
      if (element.tagName === "base" && href) {
        baseUrl = resolveUrl(href, documentUrl) ?? documentUrl;
      }
      rewriteUrlAttribute(element, "href", element.tagName === "base" ? documentUrl : baseUrl);
    },
  });

  for (const attribute of ["src", "action", "formaction", "poster"] as const) {
    rewriter.on(`[${attribute}]`, {
      element(element) {
        rewriteUrlAttribute(element, attribute, baseUrl);
      },
    });
  }

  rewriter.on("[srcset]", {
    element(element) {
      rewriteSrcsetAttribute(element, baseUrl);
    },
  });
  rewriter.on("[style]", {
    element(element) {
      rewriteCssAttribute(element, baseUrl);
    },
  });
  rewriter.on("style", {
    text(text) {
      text.replace(rewriteCssUrls(text.text, baseUrl));
    },
  });

  return rewriter.transform(html);
}

export function cleanHtml(html: string, options: CleanHtmlOptions): string {
  const rewriter = new HTMLRewriter().on(ALWAYS_REMOVE, {
    element(element) {
      element.remove();
    },
  });

  rewriter.on("a[href]", {
    element(element) {
      rewriteUrlAttribute(element, "href", options.baseUrl);
    },
  });
  rewriter.on("img[src]", {
    element(element) {
      const source = element.getAttribute("src");
      if (source?.startsWith("data:")) {
        element.remove();
        return;
      }
      rewriteUrlAttribute(element, "src", options.baseUrl);
    },
  });
  rewriter.on("source[src]", {
    element(element) {
      rewriteUrlAttribute(element, "src", options.baseUrl);
    },
  });
  rewriter.on("[srcset]", {
    element(element) {
      rewriteSrcsetAttribute(element, options.baseUrl);
    },
  });
  rewriter.on("[style]", {
    element(element) {
      rewriteCssAttribute(element, options.baseUrl);
    },
  });

  if (options.onlyMainContent) {
    for (const selector of MAIN_CONTENT_REMOVE) {
      rewriter.on(selector, {
        element(element) {
          element.remove();
        },
      });
    }
  }

  for (const selector of options.excludeSelectors ?? []) {
    const trimmed = selector.trim();
    if (trimmed) {
      rewriter.on(trimmed, {
        element(element) {
          element.remove();
        },
      });
    }
  }

  const cleaned = rewriter.transform(html);
  return options.onlyMainContent ? selectMainContent(cleaned) : cleaned;
}

// rewrites the URL attribute of an HTML element to be absolute based on the provided base URL. If the attribute value is a relative URL, it will be converted to an absolute URL using the base URL. If the attribute value is already an absolute URL or a data URI, it will remain unchanged. Invalid URLs are left untouched.

function rewriteUrlAttribute(
  element: HTMLRewriterTypes.Element,
  attribute: string,
  baseUrl: string,
) {
  const value = element.getAttribute(attribute);
  if (!value || value.startsWith("#") || /^(?:data|javascript):/i.test(value)) return;

  try {
    element.setAttribute(attribute, new URL(value, baseUrl).href);
  } catch {
    // Invalid document URLs are left untouched; they are content, not fetch targets.
  }
}

function rewriteSrcsetAttribute(element: HTMLRewriterTypes.Element, baseUrl: string) {
  const srcset = element.getAttribute("srcset");
  if (!srcset) return;

  const rewritten = srcset
    .split(",")
    .map((candidate) => {
      const match = candidate.trim().match(/^(\S+)(\s+.+)?$/);
      if (!match) return candidate.trim();
      return `${resolveContentUrl(match[1]!, baseUrl)}${match[2] ?? ""}`;
    })
    .join(", ");
  element.setAttribute("srcset", rewritten);
}

function rewriteCssAttribute(element: HTMLRewriterTypes.Element, baseUrl: string) {
  const style = element.getAttribute("style");
  if (style) element.setAttribute("style", rewriteCssUrls(style, baseUrl));
}

function rewriteCssUrls(css: string, baseUrl: string): string {
  return css.replace(/url\(\s*(["']?)(.*?)\1\s*\)/gi, (_match, quote: string, value: string) => {
    return `url(${quote}${resolveContentUrl(value.trim(), baseUrl)}${quote})`;
  });
}

function resolveContentUrl(value: string, baseUrl: string): string {
  if (!value || value.startsWith("#") || /^(?:data|javascript):/i.test(value)) return value;
  return resolveUrl(value, baseUrl) ?? value;
}

interface ContentQuality {
  score: number;
  textLength: number;
  linkDensity: number;
  semanticCoverage: number;
}

interface TextElement {
  textContent: string | null;
}

function selectMainContent(cleaned: string): string {
  const readable = extractReadableContent(cleaned);
  if (!readable) return cleaned;

  const cleanedQuality = measureContentQuality(cleaned);
  const readableQuality = measureContentQuality(readable);
  const retention = readableQuality.textLength / Math.max(1, cleanedQuality.textLength);
  const canDiscardLinkedNavigation =
    cleanedQuality.linkDensity >= 0.5 && readableQuality.linkDensity < 0.3;

  if (retention < MIN_READABLE_RETENTION && !canDiscardLinkedNavigation) return cleaned;
  const improvesSemanticCoverage =
    readableQuality.semanticCoverage >= cleanedQuality.semanticCoverage + 0.05;
  return readableQuality.score >= cleanedQuality.score * MIN_READABLE_IMPROVEMENT ||
    improvesSemanticCoverage
    ? readable
    : cleaned;
}

function extractReadableContent(html: string): string | undefined {
  try {
    const { document } = parseHTML(html);
    const article = new Readability(document).parse();
    if (!article?.content || (article.textContent?.trim().length ?? 0) < MIN_READABLE_TEXT) {
      return undefined;
    }
    const heading =
      article.title && !/<h1(?:\s|>)/i.test(article.content)
        ? `<h1>${escapeHtml(article.title)}</h1>`
        : "";
    return `<article>${heading}${article.content}</article>`;
  } catch {
    return undefined;
  }
}

function measureContentQuality(html: string): ContentQuality {
  try {
    const { document } = parseHTML(html);
    const textLength = normalizedTextLength(
      document.body?.textContent || document.documentElement?.textContent,
    );
    const linkedText = Array.from(
      document.querySelectorAll("a") as unknown as Iterable<TextElement>,
    ).reduce((total, element) => total + normalizedTextLength(element.textContent), 0);
    const proseLength = Array.from(
      document.querySelectorAll("p, pre, blockquote, td") as unknown as Iterable<TextElement>,
    ).reduce((total, element) => total + normalizedTextLength(element.textContent), 0);
    const semanticLength = Array.from(
      document.querySelectorAll(
        "p, pre, blockquote, td, li, h1, h2, h3",
      ) as unknown as Iterable<TextElement>,
    ).reduce((total, element) => total + normalizedTextLength(element.textContent), 0);
    const headingCount = document.querySelectorAll("h1, h2, h3").length;
    const structuralCount = document.querySelectorAll("p, li, pre, blockquote, tr").length;
    const linkDensity = linkedText / Math.max(1, textLength);
    const semanticCoverage = Math.min(1, semanticLength / Math.max(1, textLength));
    const score =
      Math.min(textLength, 4_000) / 25 +
      Math.min(proseLength, 3_000) / 12 +
      Math.min(headingCount, 12) * 5 +
      Math.min(structuralCount, 40) * 2 -
      linkDensity * 80 +
      semanticCoverage * 80;

    return { score, textLength, linkDensity, semanticCoverage };
  } catch {
    return { score: 0, textLength: 0, linkDensity: 0, semanticCoverage: 0 };
  }
}

function normalizedTextLength(value: string | null | undefined): number {
  return value?.replace(/\s+/g, " ").trim().length ?? 0;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    return `&#${character.charCodeAt(0)};`;
  });
}

function resolveUrl(value: string, baseUrl: string): string | undefined {
  try {
    return new URL(value, baseUrl).href;
  } catch {
    return undefined;
  }
}
