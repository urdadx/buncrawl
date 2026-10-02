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
];

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

  return rewriter.transform(html);
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

function resolveUrl(value: string, baseUrl: string): string | undefined {
  try {
    return new URL(value, baseUrl).href;
  } catch {
    return undefined;
  }
}
