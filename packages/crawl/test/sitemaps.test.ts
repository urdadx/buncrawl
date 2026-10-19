import { expect, test } from "bun:test";
import { Deadline } from "@buncrawl/core";
import { gzipSync } from "node:zlib";

import { discoverSitemapUrls, parseSitemap } from "../src";

const origin = "https://site.example";
const scope = { url: origin };
const resolver = async () => ["8.8.8.8"];

test("fetches sibling sitemaps in bounded parallel and interleaves capped leaves", async () => {
  const index = `<sitemapindex>${["a", "b", "c", "d"].map((id) => `<sitemap><loc>${origin}/${id}.xml</loc></sitemap>`).join("")}</sitemapindex>`;
  let active = 0;
  let peak = 0;
  const results = await discoverSitemapUrls([`${origin}/index.xml`], scope, {
    deadline: new Deadline(5000),
    resolver,
    maxConcurrency: 2,
    maxUrls: 4,
    fetchImpl: async (request) => {
      const url = String(request);
      if (url.endsWith("/index.xml")) return new Response(index);
      peak = Math.max(peak, ++active);
      await Bun.sleep(15);
      active--;
      const name = url.split("/").at(-1)![0];
      return new Response(
        `<urlset>${[1, 2, 3].map((n) => `<url><loc>${origin}/${name}${n}</loc></url>`).join("")}</urlset>`,
      );
    },
  });
  expect(peak).toBe(2);
  expect(results).toEqual([`${origin}/a1`, `${origin}/b1`, `${origin}/c1`, `${origin}/d1`]);
});

test("reads raw .xml.gz and rejects decompression bombs and HTML soft-404s", async () => {
  const xml = `<urlset><url><loc>${origin}/good</loc></url></urlset>`;
  const documents = new Map<string, string | Buffer>([
    [`${origin}/valid.xml.gz`, gzipSync(xml)],
    [
      `${origin}/bomb.xml.gz`,
      gzipSync(
        `<urlset><!-- ${"x".repeat(4000)} --><url><loc>${origin}/wrong</loc></url></urlset>`,
      ),
    ],
    [
      `${origin}/soft404.xml`,
      `<html><body><urlset><url><loc>${origin}/wrong</loc></url></urlset></body></html>`,
    ],
  ]);
  const urls = await discoverSitemapUrls([...documents.keys()], scope, {
    deadline: new Deadline(5000),
    resolver,
    maxBytes: 500,
    fetchImpl: async (request) => new Response(documents.get(String(request))),
  });
  expect(urls).toEqual([`${origin}/good`]);
  expect(() =>
    parseSitemap(`<html><urlset><url><loc>${origin}/wrong</loc></url></urlset></html>`),
  ).toThrow("Invalid sitemap root");
});

test("checks every sitemap redirect before requesting its target", async () => {
  const visited: string[] = [];
  const urls = await discoverSitemapUrls([`${origin}/redirect.xml`, `${origin}/valid.xml`], scope, {
    deadline: new Deadline(5000),
    resolver,
    fetchImpl: async (request) => {
      const url = String(request);
      visited.push(url);
      if (url.endsWith("/redirect.xml"))
        return new Response(null, {
          status: 302,
          headers: { Location: "https://evil.example/secret.xml" },
        });
      return new Response(`<urlset><url><loc>${origin}/good</loc></url></urlset>`);
    },
  });
  expect(visited).not.toContain("https://evil.example/secret.xml");
  expect(urls).toEqual([`${origin}/good`]);
});

test("parses crw-style namespaced sitemaps with Bun.XML", () => {
  // Representative entries from crw/docs/sitemap.xml (declaration, default namespace, metadata).
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
    <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
      <url><loc>https://docs.fastcrw.com/</loc><priority>1.0</priority><changefreq>weekly</changefreq></url>
      <url><loc>https://docs.fastcrw.com/introduction</loc><priority>0.9</priority></url>
    </urlset>`;
  expect(parseSitemap(xml)).toEqual({
    type: "urls",
    locations: ["https://docs.fastcrw.com/", "https://docs.fastcrw.com/introduction"],
  });
  expect(parseSitemap("<urlset/>")).toEqual({ type: "urls", locations: [] });
});

test("expands XML entities and CDATA, reads prefixed elements and encoded document bytes", () => {
  const xml = `<x:sitemapindex xmlns:x="urn:sitemap"><x:sitemap>
    <x:loc><![CDATA[https://site.example/a?x=1&y=2]]></x:loc>
    </x:sitemap><x:sitemap><x:loc xml:lang="en">https://site.example/b?x=1&amp;y=2</x:loc></x:sitemap>
    </x:sitemapindex>`;
  expect(parseSitemap(xml)).toEqual({
    type: "index",
    locations: ["https://site.example/a?x=1&y=2", "https://site.example/b?x=1&y=2"],
  });
  const utf16 = Buffer.concat([
    Buffer.from([0xff, 0xfe]),
    Buffer.from(
      `<?xml version="1.0" encoding="UTF-16"?><urlset><url><loc>https://site.example/encoded</loc></url></urlset>`,
      "utf16le",
    ),
  ]);
  expect(parseSitemap(utf16).locations).toEqual(["https://site.example/encoded"]);
  expect(() => parseSitemap("<urlset><url><loc>broken</url></urlset>")).toThrow(SyntaxError);
});
