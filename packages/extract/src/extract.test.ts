import { describe, expect, test } from "bun:test";

import { cleanHtml } from "./clean";
import { extractDocument } from "./extract";
import { extractLinks } from "./links";
import { htmlToMarkdown } from "./markdown";
import { extractMetadata } from "./metadata";

const PAGE = `<!doctype html>
<html lang="en">
  <head>
    <title>Example Article</title>
    <meta name="description" content="A useful article">
    <meta property="og:image" content="/cover.jpg">
    <link rel="canonical" href="/article">
    <link rel="icon" href="/favicon.ico">
    <base href="https://cdn.example.com/docs/">
    <style>.hidden { display: none }</style>
  </head>
  <body>
    <header>Site header</header>
    <nav><a href="/home">Home</a></nav>
    <main>
      <article>
        <h1>Example Article</h1>
        <p>Hello <strong>world</strong> &amp; Bun.</p>
        <p><a href="guide">Read the guide</a></p>
        <img src="/image.png" alt="Example image">
      </article>
    </main>
    <aside>Related content</aside>
    <script>window.secret = true</script>
    <footer>Site footer</footer>
  </body>
</html>`;

describe("cleanHtml", () => {
  test("removes executable content and rewrites URLs", () => {
    const cleaned = cleanHtml(PAGE, { baseUrl: "https://example.com/page" });
    expect(cleaned).not.toContain("window.secret");
    expect(cleaned).not.toContain("display: none");
    expect(cleaned).toContain('href="https://example.com/home"');
    expect(cleaned).toContain('src="https://example.com/image.png"');
  });

  test("removes site chrome in main-content mode", () => {
    const cleaned = cleanHtml(PAGE, {
      baseUrl: "https://example.com/page",
      onlyMainContent: true,
    });
    expect(cleaned).not.toContain("Site header");
    expect(cleaned).not.toContain("Site footer");
    expect(cleaned).not.toContain("Related content");
    expect(cleaned).toContain("Example Article");
  });

  test("supports caller-provided exclusion selectors", () => {
    const cleaned = cleanHtml('<main><p>Keep</p><div class="remove">Drop</div></main>', {
      baseUrl: "https://example.com",
      excludeSelectors: [".remove"],
    });
    expect(cleaned).toContain("Keep");
    expect(cleaned).not.toContain("Drop");
  });
});

describe("extractMetadata", () => {
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
});

describe("extractLinks", () => {
  test("honors base href, removes fragments, and deduplicates", () => {
    const links = extractLinks(
      '<base href="/docs/"><a href="guide#one">One</a><a href="guide#two">Two</a><a href="#top">Top</a><a href="mailto:test@example.com">Mail</a>',
      "https://example.com/page",
    );
    expect(links).toEqual(["https://example.com/docs/guide", "mailto:test@example.com"]);
  });
});

describe("htmlToMarkdown", () => {
  test("converts core semantic elements", () => {
    const markdown = htmlToMarkdown(
      '<h1>Title</h1><p>Hello <strong>world</strong> &amp; <a href="https://example.com">link</a>.</p><ul><li>One</li><li>Two</li></ul>',
    );
    expect(markdown).toBe(
      "# Title\n\nHello **world** & [link](https://example.com).\n\n- One\n- Two",
    );
  });

  test("converts images and code", () => {
    const markdown = htmlToMarkdown(
      '<p><img src="https://example.com/a.png" alt="A"></p><pre>const x = 1;</pre>',
    );
    expect(markdown).toContain("![A](https://example.com/a.png)");
    expect(markdown).toContain("```\nconst x = 1;\n```");
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
