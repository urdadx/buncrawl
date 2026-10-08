import { describe, expect, test } from "bun:test";

import { cleanHtml } from "../src/clean";
import { extractDocument } from "../src/extract";
import { extractLinks } from "../src/links";
import { extractMetadata } from "../src/metadata";

const PAGE = `<!doctype html><html lang="en"><head>
<title>Example Article</title><meta name="description" content="A useful article">
<meta property="og:image" content="/cover.jpg"><link rel="canonical" href="/article">
<link rel="icon" href="/favicon.ico"><base href="https://cdn.example.com/docs/">
<style>.hidden { display: none }</style></head><body>
<header>Site header</header><nav><a href="/home">Home</a></nav><main><article>
<h1>Example Article</h1><p>Hello <strong>world</strong> &amp; Bun.</p>
<p><a href="guide">Read the guide</a></p><img src="/image.png" alt="Example image">
</article></main><aside>Related content</aside><script>window.secret = true</script>
<footer>Site footer</footer></body></html>`;

describe("cleanHtml", () => {
  test("removes executable content and rewrites URLs", () => {
    const cleaned = cleanHtml(PAGE, { baseUrl: "https://example.com/page" });
    expect(cleaned).not.toContain("window.secret");
    expect(cleaned).not.toContain("display: none");
    expect(cleaned).toContain('href="https://example.com/home"');
    expect(cleaned).toContain('src="https://example.com/image.png"');
  });

  test("supports main-content and caller exclusions", () => {
    const cleaned = cleanHtml(`${PAGE}<div class="remove">Drop</div>`, {
      baseUrl: "https://example.com/page",
      onlyMainContent: true,
      excludeSelectors: [".remove"],
    });
    expect(cleaned).not.toContain("Site header");
    expect(cleaned).not.toContain("Site footer");
    expect(cleaned).not.toContain("Drop");
    expect(cleaned).toContain("Example Article");
  });
});

describe("metadata and links", () => {
  test("extracts and resolves common metadata", () => {
    expect(extractMetadata(PAGE, "https://example.com/page")).toEqual({
      title: "Example Article",
      description: "A useful article",
      language: "en",
      canonicalUrl: "https://example.com/article",
      favicon: "https://example.com/favicon.ico",
      ogImage: "https://example.com/cover.jpg",
    });
  });

  test("honors base href, removes fragments, and deduplicates links", () => {
    const links = extractLinks(
      '<base href="/docs/"><a href="guide#one">One</a><a href="guide#two">Two</a><a href="#top">Top</a><a href="mailto:test@example.com">Mail</a>',
      "https://example.com/page",
    );
    expect(links).toEqual(["https://example.com/docs/guide", "mailto:test@example.com"]);
  });
});

describe("extractDocument", () => {
  test("returns the complete extraction result", () => {
    const result = extractDocument(PAGE, {
      baseUrl: "https://example.com/page",
      onlyMainContent: true,
    });
    expect(result.metadata.title).toBe("Example Article");
    expect(result.markdown).toContain("# Example Article");
    expect(result.links).toContain("https://cdn.example.com/home");
    expect(result.html).not.toContain("window.secret");
  });
});
