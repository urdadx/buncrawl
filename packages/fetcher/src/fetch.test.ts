import { describe, expect, test } from "bun:test";
import { Deadline } from "@buncrawl/core";

import { FetchError, fetchPage } from "./fetch";

const publicResolver = async () => ["93.184.216.34"];

describe("fetchPage", () => {
  test("returns response metadata and decoded body", async () => {
    const result = await fetchPage("https://example.com", {
      deadline: new Deadline(1000),
      resolver: publicResolver,
      fetchImpl: async () =>
        new Response("<h1>Hello</h1>", {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
    });

    expect(result.statusCode).toBe(200);
    expect(result.contentType).toBe("text/html");
    expect(result.charset).toBe("utf-8");
    expect(result.body).toBe("<h1>Hello</h1>");
    expect(result.redirectCount).toBe(0);
  });

  test("validates and follows redirects manually", async () => {
    const requested: string[] = [];
    const result = await fetchPage("https://example.com/start", {
      deadline: new Deadline(1000),
      resolver: publicResolver,
      fetchImpl: async (input) => {
        const url = input.toString();
        requested.push(url);
        return url.endsWith("/start")
          ? new Response(null, { status: 302, headers: { location: "/final" } })
          : new Response("done", { status: 200 });
      },
    });

    expect(requested).toEqual(["https://example.com/start", "https://example.com/final"]);
    expect(result.finalUrl).toBe("https://example.com/final");
    expect(result.redirectCount).toBe(1);
  });

  test("blocks redirects to private addresses before fetching them", async () => {
    let requestCount = 0;
    const promise = fetchPage("https://example.com", {
      deadline: new Deadline(1000),
      resolver: publicResolver,
      fetchImpl: async () => {
        requestCount += 1;
        return new Response(null, {
          status: 302,
          headers: { location: "http://169.254.169.254/metadata" },
        });
      },
    });

    await expect(promise).rejects.toMatchObject({ code: "BLOCKED_DESTINATION" });
    expect(requestCount).toBe(1);
  });

  test("does not forward credentials across origins", async () => {
    const seenAuthorization: Array<string | null> = [];
    await fetchPage("https://example.com", {
      deadline: new Deadline(1000),
      resolver: publicResolver,
      headers: { authorization: "Bearer secret" },
      fetchImpl: async (input, init) => {
        seenAuthorization.push(new Headers(init?.headers).get("authorization"));
        return input.toString() === "https://example.com/"
          ? new Response(null, { status: 302, headers: { location: "https://other.test/" } })
          : new Response("done");
      },
    });

    expect(seenAuthorization).toEqual(["Bearer secret", null]);
  });

  test("rejects an oversized declared response", async () => {
    const promise = fetchPage("https://example.com", {
      deadline: new Deadline(1000),
      resolver: publicResolver,
      maxResponseBytes: 4,
      fetchImpl: async () => new Response("large", { headers: { "content-length": "5" } }),
    });

    await expect(promise).rejects.toBeInstanceOf(FetchError);
    await expect(promise).rejects.toMatchObject({ code: "RESPONSE_TOO_LARGE" });
  });

  test("rejects a streamed response that exceeds the limit", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("123"));
        controller.enqueue(new TextEncoder().encode("456"));
        controller.close();
      },
    });
    const promise = fetchPage("https://example.com", {
      deadline: new Deadline(1000),
      resolver: publicResolver,
      maxResponseBytes: 5,
      fetchImpl: async () => new Response(stream),
    });

    await expect(promise).rejects.toMatchObject({ code: "RESPONSE_TOO_LARGE" });
  });

  test("honors a declared non-UTF-8 charset", async () => {
    const result = await fetchPage("https://example.com", {
      deadline: new Deadline(1000),
      resolver: publicResolver,
      fetchImpl: async () =>
        new Response(Uint8Array.from([0x63, 0x61, 0x66, 0xe9]), {
          headers: { "content-type": "text/html; charset=windows-1252" },
        }),
    });

    expect(result.body).toBe("café");
  });

  test("enforces the redirect limit", async () => {
    const promise = fetchPage("https://example.com/0", {
      deadline: new Deadline(1000),
      resolver: publicResolver,
      maxRedirects: 1,
      fetchImpl: async (input) => {
        const current = Number(new URL(input.toString()).pathname.slice(1));
        return new Response(null, {
          status: 302,
          headers: { location: `/${current + 1}` },
        });
      },
    });

    await expect(promise).rejects.toMatchObject({ code: "TOO_MANY_REDIRECTS" });
  });
});
