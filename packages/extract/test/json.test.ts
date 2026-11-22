import { describe, expect, test } from "bun:test";

import { extractJson, invalidJsonSelector, MAX_JSON_MATCHES } from "../src/json";
import { runExtractJob } from "../src/job";

const page = `<html><head>
  <meta property="og:image" content="https://example.com/cover.png">
</head><body>
  <h1>  Spring   catalogue </h1>
  <ul>
    <li class="product"><span class="name">Kettle</span><a href="/p/kettle">view</a><b class="price">20</b></li>
    <li class="product"><span class="name">Toaster</span><a href="/p/toaster">view</a></li>
  </ul>
</body></html>`;

describe("selector-based json extraction", () => {
  test("reads text, attributes, lists and nested records", () => {
    expect(
      extractJson(page, {
        title: "h1",
        cover: { selector: "meta[property='og:image']", attribute: "content" },
        names: { selector: ".product .name", all: true },
        products: {
          selector: ".product",
          all: true,
          fields: { name: ".name", price: ".price", link: { selector: "a", attribute: "href" } },
        },
      }),
    ).toEqual({
      title: "Spring catalogue",
      cover: "https://example.com/cover.png",
      names: ["Kettle", "Toaster"],
      products: [
        { name: "Kettle", price: "20", link: "/p/kettle" },
        { name: "Toaster", price: null, link: "/p/toaster" },
      ],
    });
  });

  test("returns null for a missing match or attribute and [] for an empty list", () => {
    expect(
      extractJson(page, {
        subtitle: "h2",
        missingAttribute: { selector: "h1", attribute: "data-id" },
        reviews: { selector: ".review", all: true },
      }),
    ).toEqual({ subtitle: null, missingAttribute: null, reviews: [] });
  });

  test("caps list results", () => {
    const many = `<ul>${"<li>x</li>".repeat(MAX_JSON_MATCHES + 50)}</ul>`;
    expect(
      (extractJson(many, { items: { selector: "li", all: true } }).items as unknown[]).length,
    ).toBe(MAX_JSON_MATCHES);
  });

  test("runs on the absolutized full page inside an extraction job", () => {
    const output = runExtractJob({
      html: page,
      baseUrl: "https://shop.example/catalogue",
      onlyMainContent: true,
      jsonSelectors: { first: { selector: ".product a", attribute: "href" } },
    });
    expect(output.json).toEqual({ first: "https://shop.example/p/kettle" });
    expect(
      runExtractJob({ html: page, baseUrl: "https://e.com", onlyMainContent: true }).json,
    ).toBeUndefined();
  });

  test("reports the first selector that is not valid CSS, including nested ones", () => {
    expect(
      invalidJsonSelector({ ok: "h1", list: { selector: "li", fields: { a: "a" } } }),
    ).toBeUndefined();
    expect(invalidJsonSelector({ broken: "div[" })).toContain("div[");
    expect(invalidJsonSelector({ list: { selector: "li", fields: { bad: ":::" } } })).toContain(
      ":::",
    );
  });
});
