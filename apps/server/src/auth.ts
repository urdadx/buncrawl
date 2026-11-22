import { timingSafeEqual } from "node:crypto";

const MIN_KEY_LENGTH = 16;

/**
 * Parses BUNCRAWL_API_KEY: one key, or several separated by commas so a new key can be rolled out
 * before the old one is removed. Returns SHA-256 digests, so checks compare equal-length values.
 */
export function parseApiKeys(value: string | undefined): Uint8Array[] {
  const keys = (value ?? "")
    .split(",")
    .map((key) => key.trim())
    .filter((key) => key !== "");
  for (const key of keys) {
    if (key.length < MIN_KEY_LENGTH) {
      throw new Error(`Each BUNCRAWL_API_KEY must be at least ${MIN_KEY_LENGTH} characters`);
    }
  }
  return keys.map(digest);
}

/** True when no keys are configured, or the request carries one as `Authorization: Bearer`. */
export function isAuthorized(request: Request, keys: readonly Uint8Array[]): boolean {
  if (keys.length === 0) return true;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(request.headers.get("authorization") ?? "");
  if (!match) return false;
  const presented = digest(match[1]!);
  // Compare against every key, so the response time does not reveal which one matched.
  let authorized = false;
  for (const key of keys) authorized = timingSafeEqual(presented, key) || authorized;
  return authorized;
}

export function unauthorized(): Response {
  return Response.json(
    { success: false, code: "UNAUTHORIZED", error: "Missing or invalid API key" },
    { status: 401, headers: { "WWW-Authenticate": 'Bearer realm="buncrawl"' } },
  );
}

function digest(value: string): Uint8Array {
  return new Bun.CryptoHasher("sha256").update(value).digest();
}
