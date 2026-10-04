import { describe, expect, test } from "bun:test";

import {
  UrlSafetyError,
  isBlockedIp,
  resolveSafeUrl,
  validateRedirectUrl,
  validateResolvedUrl,
  validateUrl,
} from "./url-safety";

describe("validateUrl", () => {
  test("accepts public HTTP URLs", () => {
    expect(validateUrl("https://example.com/path").href).toBe("https://example.com/path");
  });

  test.each(["file:///etc/passwd", "ftp://example.com", "data:text/plain,test"])(
    "rejects non-HTTP URL %s",
    (url) => expect(() => validateUrl(url)).toThrow(UrlSafetyError),
  );

  test.each([
    "http://localhost",
    "http://api.localhost",
    "http://metadata.google.internal",
    "http://127.0.0.1",
    "http://10.0.0.1",
    "http://172.16.0.1",
    "http://192.168.1.1",
    "http://169.254.169.254",
    "http://127.0.0.1.nip.io",
    "http://[::1]",
    "http://[fe80::1]",
    "http://[fd00::1]",
    "http://[::ffff:127.0.0.1]",
    "http://[64:ff9b::a9fe:a9fe]",
    "http://[2002:a00:1::1]",
  ])("rejects unsafe destination %s", (url) => {
    expect(() => validateUrl(url)).toThrow(UrlSafetyError);
  });

  test("rejects embedded credentials", () => {
    expect(() => validateUrl("https://user:password@example.com")).toThrow(UrlSafetyError);
  });
});

describe("isBlockedIp", () => {
  test.each(["93.184.216.34", "2606:4700:4700::1111", "64:ff9b::5db8:d822"])(
    "allows public address %s",
    (address) => expect(isBlockedIp(address)).toBe(false),
  );

  test.each(["0.0.0.0", "100.64.0.1", "224.0.0.1", "fc00::1", "ff02::1"])(
    "blocks special address %s",
    (address) => expect(isBlockedIp(address)).toBe(true),
  );
});

describe("validateResolvedUrl", () => {
  test("accepts a hostname when every DNS answer is public", async () => {
    const url = await validateResolvedUrl("https://example.com", {
      resolver: async () => ["93.184.216.34", "2606:4700:4700::1111"],
    });
    expect(url.hostname).toBe("example.com");
  });

  test("returns validated addresses for connection pinning", async () => {
    const resolved = await resolveSafeUrl("https://example.com", {
      resolver: async () => ["93.184.216.34", "2606:4700:4700::1111"],
    });
    expect(resolved.url.hostname).toBe("example.com");
    expect(resolved.addresses).toEqual(["93.184.216.34", "2606:4700:4700::1111"]);
  });

  test("fails closed when any DNS answer is private", async () => {
    expect(
      validateResolvedUrl("https://example.com", {
        resolver: async () => ["93.184.216.34", "127.0.0.1"],
      }),
    ).rejects.toMatchObject({ code: "BLOCKED_DESTINATION" });
  });

  test("distinguishes DNS failure from blocked destinations", async () => {
    expect(
      validateResolvedUrl("https://example.com", {
        resolver: async () => {
          throw new Error("resolver unavailable");
        },
      }),
    ).rejects.toMatchObject({ code: "DNS_RESOLUTION_FAILED" });
  });
});

describe("validateRedirectUrl", () => {
  test("resolves and validates relative redirects", async () => {
    const url = await validateRedirectUrl("/next", "https://example.com/start", {
      resolver: async () => ["93.184.216.34"],
    });
    expect(url.href).toBe("https://example.com/next");
  });

  test("blocks redirects to private destinations", async () => {
    expect(
      validateRedirectUrl("http://169.254.169.254/metadata", "https://example.com"),
    ).rejects.toMatchObject({ code: "BLOCKED_DESTINATION" });
  });
});
