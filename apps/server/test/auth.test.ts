import { describe, expect, test } from "bun:test";
import type { BunRequest } from "bun";

import { isAuthorized, parseApiKeys } from "../src/auth";
import { endpoint } from "../src/http";

const key = "test-key-0123456789";
const otherKey = "other-key-0123456789";

function request(headers: Record<string, string> = {}, method = "POST"): BunRequest<"/v1/scrape"> {
  return new Request("http://localhost/v1/scrape", { method, headers }) as BunRequest<"/v1/scrape">;
}

describe("parseApiKeys", () => {
  test("reads one key or a comma-separated list", () => {
    expect(parseApiKeys(undefined)).toHaveLength(0);
    expect(parseApiKeys("")).toHaveLength(0);
    expect(parseApiKeys(` ${key} , ${otherKey} ,`)).toHaveLength(2);
  });

  test("rejects keys too short to resist guessing", () => {
    expect(() => parseApiKeys(`${key},short`)).toThrow("at least 16 characters");
  });
});

describe("isAuthorized", () => {
  const keys = parseApiKeys(`${key},${otherKey}`);

  test("accepts any configured key as a Bearer token", () => {
    expect(isAuthorized(request({ authorization: `Bearer ${key}` }), keys)).toBe(true);
    expect(isAuthorized(request({ authorization: `bearer ${otherKey}` }), keys)).toBe(true);
  });

  test("rejects missing, wrong and non-Bearer credentials", () => {
    expect(isAuthorized(request(), keys)).toBe(false);
    expect(isAuthorized(request({ authorization: `Bearer ${key}x` }), keys)).toBe(false);
    expect(isAuthorized(request({ authorization: key }), keys)).toBe(false);
    expect(isAuthorized(request({ authorization: `Basic ${btoa(`user:${key}`)}` }), keys)).toBe(
      false,
    );
  });

  test("allows everything when no key is configured", () => {
    expect(isAuthorized(request(), [])).toBe(true);
  });
});

describe("endpoint", () => {
  const apiKeys = parseApiKeys(key);
  const handler = () => new Response("handled");

  test("returns 401 without a valid key and calls the handler with one", async () => {
    const protectedEndpoint = endpoint(handler, { apiKeys });

    const denied = await protectedEndpoint(request());
    expect(denied.status).toBe(401);
    expect(denied.headers.get("www-authenticate")).toContain("Bearer");
    expect(denied.headers.get("access-control-allow-methods")).not.toBeNull();
    expect(await denied.json()).toMatchObject({ success: false, code: "UNAUTHORIZED" });

    const allowed = await protectedEndpoint(request({ authorization: `Bearer ${key}` }));
    expect(allowed.status).toBe(200);
    expect(await allowed.text()).toBe("handled");
  });

  test("answers CORS preflight and public endpoints without a key", async () => {
    const preflight = await endpoint(handler, { apiKeys })(request({}, "OPTIONS"));
    expect(preflight.status).toBe(204);

    const health = await endpoint(handler, { public: true, apiKeys })(request({}, "GET"));
    expect(await health.text()).toBe("handled");
  });
});
