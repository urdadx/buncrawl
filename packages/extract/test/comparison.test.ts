import { describe, expect, test } from "bun:test";

import { extractDocument } from "../src/extract";
import { htmlToMarkdown } from "../src/markdown";

const fixture = (name: string) => Bun.file(new URL(`fixtures/${name}`, import.meta.url)).text();

// Firecrawl reference: apps/api/src/lib/__tests__/html-to-markdown.test.ts
// Commit: 556c12c9d293bc7392feb008946944d54068d04c
describe("Firecrawl converter comparison", () => {
  const cases = [
    ["simple paragraph", "<p>Hello, world!</p>", "Hello, world!"],
    [
      "nested formatting",
      "<div><p>Hello <strong>bold</strong> world!</p><ul><li>List item</li></ul></div>",
      "Hello **bold** world!\n\n- List item",
    ],
    ["unclosed paragraph", "<html><p>Unclosed tag", "Unclosed tag"],
    ["unclosed container", "<div><span>Missing closing div", "Missing closing div"],
    ["incorrect nesting", "<p><strong>Wrong nesting</em></strong></p>", "**Wrong nesting**"],
    [
      "unclosed anchor",
      '<a href="http://example.com">Link without closing tag',
      "[Link without closing tag](http://example.com)",
    ],
  ] as const;

  for (const [name, html, expected] of cases) {
    test(`matches ${name}`, () => {
      expect(htmlToMarkdown(html)).toBe(expected);
    });
  }
});

// CRW references:
// tests/fixtures/blog_article.html and crates/crw-extract/tests/fixtures/listings/docs_toc.html
// Commit: 43b11f717b45cf854ce965d3bf5ed0c436a51fd6
describe("CRW main-content comparison", () => {
  test("retains article structure while removing page chrome", async () => {
    const result = extractDocument(await fixture("reference-article.html"), {
      baseUrl: "https://example.com/posts/ownership",
      onlyMainContent: true,
    });

    for (const content of [
      "# Understanding Rust Ownership",
      "## The Three Rules",
      "1.  Each value in Rust",
      "## Borrowing",
      'let s = String::from("hello");',
      "[Next: Understanding Lifetimes](https://example.com/posts/lifetimes)",
    ]) {
      expect(result.markdown).toContain(content);
    }
    for (const chrome of ["All Posts", "Related Posts", "© 2025 Dev Blog"]) {
      expect(result.markdown).not.toContain(chrome);
    }
  });

  test("retains documentation prose while removing its TOC", async () => {
    const result = extractDocument(await fixture("reference-docs.html"), {
      baseUrl: "https://example.com/docs",
      onlyMainContent: true,
    });

    expect(result.markdown).toContain("# Introduction");
    expect(result.markdown).toContain("## Installation");
    expect(result.markdown).toContain("## Quickstart");
    expect(result.markdown).not.toContain("# Contents");
  });
});
