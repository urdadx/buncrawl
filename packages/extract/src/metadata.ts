export interface DocumentMetadata {
  title?: string;
  description?: string;
  language?: string;
  canonicalUrl?: string;
  favicon?: string;
  robots?: string;
  keywords?: string;
  ogTitle?: string;
  ogDescription?: string;
  ogImage?: string;
}

export function extractMetadata(html: string, baseUrl: string): DocumentMetadata {
  let title = "";
  let language: string | undefined;
  let canonicalUrl: string | undefined;
  let favicon: string | undefined;
  const metadata = new Map<string, string>();

  const rewriter = new HTMLRewriter()
    .on("title", {
      text(text) {
        title += text.text;
      },
    })
    .on("html[lang]", {
      element(element) {
        language ??= cleanValue(element.getAttribute("lang"));
      },
    })
    .on("meta[content]", {
      element(element) {
        const key =
          element.getAttribute("name") ??
          element.getAttribute("property") ??
          element.getAttribute("itemprop");
        const content = cleanValue(element.getAttribute("content"));
        if (key && content && !metadata.has(key.toLowerCase())) {
          metadata.set(key.toLowerCase(), content);
        }
      },
    })
    .on('link[rel="canonical"][href]', {
      element(element) {
        canonicalUrl ??= resolveUrl(element.getAttribute("href"), baseUrl);
      },
    })
    .on('link[rel~="icon"][href]', {
      element(element) {
        favicon ??= resolveUrl(element.getAttribute("href"), baseUrl);
      },
    });

  rewriter.transform(html);

  return compactMetadata({
    title: cleanValue(title),
    description: metadata.get("description"),
    language,
    canonicalUrl,
    favicon,
    robots: metadata.get("robots"),
    keywords: metadata.get("keywords"),
    ogTitle: metadata.get("og:title"),
    ogDescription: metadata.get("og:description"),
    ogImage: resolveUrl(metadata.get("og:image"), baseUrl),
  });
}

function compactMetadata(metadata: DocumentMetadata): DocumentMetadata {
  return Object.fromEntries(
    Object.entries(metadata).filter((entry): entry is [string, string] => Boolean(entry[1])),
  );
}

function cleanValue(value: string | null | undefined): string | undefined {
  const cleaned = value?.replace(/\s+/g, " ").trim();
  return cleaned || undefined;
}

function resolveUrl(value: string | null | undefined, baseUrl: string): string | undefined {
  if (!value) return undefined;
  try {
    return new URL(value, baseUrl).href;
  } catch {
    return undefined;
  }
}
