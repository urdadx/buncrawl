import { describe, expect, test } from "bun:test";

import { absolutizeHtmlUrls, cleanHtml } from "../src/clean";
import { extractDocument } from "../src/extract";
import { htmlToMarkdown } from "../src/markdown";

const fixture = (name: string) => Bun.file(new URL(`fixtures/${name}`, import.meta.url)).text();

describe("HTML-to-Markdown fixture corpus", () => {
  test("preserves GFM tables, nested lists, and fenced code", async () => {
    const markdown = htmlToMarkdown(await fixture("complex.html"));
    expect(markdown).toContain("| Name | Value |");
    expect(markdown).toContain("1.  First\n    - Nested A\n    - Nested B");
    expect(markdown).toContain("````\nconst fence = ```;\nconsole.log(fence);\n````");
  });

  test("handles malformed HTML and entities", async () => {
    const markdown = htmlToMarkdown(await fixture("malformed.html"));
    expect(markdown).toContain("# Fish & Chips");
    expect(markdown).toContain("Copyright © 2026 Bun");
    expect(markdown).toContain("Second paragraph **still works**");
  });

  test("handles large documents without dropping content", () => {
    const paragraphs = Array.from(
      { length: 2_000 },
      (_, index) => `<p>Paragraph ${index}: deterministic fixture content.</p>`,
    ).join("");
    const markdown = htmlToMarkdown(`<article>${paragraphs}</article>`);
    expect(markdown).toContain("Paragraph 0: deterministic fixture content.");
    expect(markdown).toContain("Paragraph 1999: deterministic fixture content.");
  });
});

describe("content URL normalization", () => {
  test("resolves srcset and CSS URLs against the document base", () => {
    const html = absolutizeHtmlUrls(
      '<base href="/assets/"><style>.hero{background:url("bg.png")}</style><img srcset="small.png 1x, /large.png 2x" style="background-image: url(thumb.png)">',
      "https://example.com/story",
    );
    expect(html).toContain(
      'srcset="https://example.com/assets/small.png 1x, https://example.com/large.png 2x"',
    );
    expect(html).toContain('url("https://example.com/assets/bg.png")');
    expect(html).toContain("url(https://example.com/assets/thumb.png)");
  });
});

describe("main-content extraction", () => {
  test("uses readability for substantial noisy articles", async () => {
    const cleaned = cleanHtml(await fixture("noisy-article.html"), {
      baseUrl: "https://example.com/story",
      onlyMainContent: true,
    });
    expect(cleaned).toContain("This is the opening paragraph");
    expect(cleaned).not.toContain("Trending links");
    expect(cleaned).not.toContain("Recommended products");
  });

  test("keeps short useful pages when readability has no article", () => {
    const result = extractDocument("<main><h1>Short page</h1><p>Useful answer.</p></main>", {
      baseUrl: "https://example.com",
      onlyMainContent: true,
    });
    expect(result.markdown).toBe("# Short page\n\nUseful answer.");
  });

  test("does not collapse a card listing to one item", async () => {
    const result = extractDocument(await fixture("card-grid.html"), {
      baseUrl: "https://example.com/articles",
      onlyMainContent: true,
    });
    expect(result.markdown).toContain("How to raise seed funding");
    expect(result.markdown).toContain("From bootstrapped to series A");
    expect(result.markdown).not.toContain("Copyright 2026");
  });

  test("preserves every post in a multi-article forum thread", async () => {
    const result = extractDocument(await fixture("forum-thread.html"), {
      baseUrl: "https://example.com/thread",
      onlyMainContent: true,
    });
    for (const author of ["alice", "bob", "carol", "dave"]) {
      expect(result.markdown).toContain(author);
    }
  });

  test("keeps useful reference lists with article prose", async () => {
    const result = extractDocument(await fixture("reference-heavy.html"), {
      baseUrl: "https://example.com/photosynthesis",
      onlyMainContent: true,
    });
    expect(result.markdown).toContain("# Photosynthesis");
    expect(result.markdown).toContain("## References");
    expect(result.markdown).toContain("Smith, Plant Biology, 2019");
    expect(result.markdown).toContain("Lee, Carbon Fixation, 2022");
  });
});
