import { describe, expect, test } from "bun:test";

import { countExecutableScripts, detectRenderNeed, hasClientRedirect } from "./detector";

describe("detectRenderNeed", () => {
  test("keeps a substantive static page on the fetch path", () => {
    const article = "Real article content with useful information. ".repeat(30);
    expect(detectRenderNeed(`<html><body><article>${article}</article></body></html>`)).toEqual({
      render: false,
      visibleTextLength: article.replace(/\s/g, "").length,
    });
  });

  test.each([
    '<div id="root"></div><script src="/app.js"></script>',
    '<div id="__next"></div><script src="/next.js"></script>',
    '<div data-sveltekit-preload-data></div><script src="/app.js"></script>',
  ])("detects an SPA shell", (body) => {
    expect(detectRenderNeed(`<html><body>${body}</body></html>`)).toMatchObject({
      render: true,
      reason: "spa-shell",
    });
  });

  test("detects an explicit JavaScript requirement", () => {
    const result = detectRenderNeed(
      "<html><body><noscript>Please enable JavaScript to continue</noscript></body></html>",
    );
    expect(result).toMatchObject({ render: true, reason: "javascript-required" });
  });

  test("detects a client-side redirect", () => {
    const html =
      '<html><head><meta http-equiv="refresh" content="0; url=/app"></head><body>Redirecting</body></html>';
    expect(detectRenderNeed(html)).toMatchObject({ render: true, reason: "client-redirect" });
  });

  test("detects a thin page with executable scripts", () => {
    const html = "<html><body><div>Starting</div><script>window.startApp()</script></body></html>";
    expect(detectRenderNeed(html)).toMatchObject({ render: true, reason: "thin-scripted" });
  });

  test("ignores data-only script blocks", () => {
    const html =
      '<html><body><p>Small but complete.</p><script type="application/ld+json">{"name":"Page"}</script></body></html>';
    expect(detectRenderNeed(html).render).toBe(false);
  });

  test("detects a loading placeholder", () => {
    expect(
      detectRenderNeed('<html><body><div class="spinner">Loading...</div></body></html>'),
    ).toMatchObject({ render: true, reason: "loading-placeholder" });
  });

  test("detects a known challenge vendor", () => {
    const result = detectRenderNeed(
      "<html><body><h1>Just a moment</h1><script>window._cf_chl_opt = {}</script></body></html>",
    );
    expect(result).toMatchObject({
      render: true,
      reason: "bot-challenge",
      vendor: "cloudflare",
    });
  });

  test("does not classify a long article mentioning access denial as a challenge", () => {
    const article = `${"Detailed article prose. ".repeat(100)} Access denied is discussed here.`;
    expect(detectRenderNeed(`<html><body><article>${article}</article></body></html>`).render).toBe(
      false,
    );
  });

  test("does not render non-HTML content", () => {
    expect(
      detectRenderNeed("window.startApp()", { contentType: "application/javascript" }),
    ).toEqual({
      render: false,
      visibleTextLength: 0,
    });
  });

  test("does not render a 204 response", () => {
    expect(detectRenderNeed("", { contentType: "text/html", statusCode: 204 }).render).toBe(false);
  });

  test("does not mark a large content-rich page as thin when the scan is truncated", () => {
    const article = `<p>${"Content-rich prose. ".repeat(100)}</p>`.repeat(500);
    expect(article.length).toBeGreaterThan(500_000);
    expect(detectRenderNeed(`<html><body>${article}</body></html>`).render).toBe(false);
  });
});

describe("detector helpers", () => {
  test("requires the refresh and URL attributes in the same meta tag", () => {
    expect(hasClientRedirect('<meta http-equiv="refresh" content="0; url=/next">')).toBe(true);
    expect(hasClientRedirect('<meta http-equiv="refresh"><meta name="url" content="/next">')).toBe(
      false,
    );
  });

  test("counts only executable scripts", () => {
    const html = [
      '<script type="application/json">{"state":true}</script>',
      '<script type="application/ld+json">{"name":"Page"}</script>',
      '<script src="/app.js"></script>',
      "<script>window.boot()</script>",
    ].join("");
    expect(countExecutableScripts(html)).toBe(2);
  });
});
