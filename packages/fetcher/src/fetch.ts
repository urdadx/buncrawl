import type { Deadline } from "@buncrawl/core";
import { type DnsResolver, validateRedirectUrl, validateResolvedUrl } from "@buncrawl/security";

const DEFAULT_MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_REDIRECTS = 10;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const SENSITIVE_HEADERS = ["authorization", "cookie", "proxy-authorization"];

export type FetchErrorCode =
  | "FETCH_FAILED"
  | "RESPONSE_TOO_LARGE"
  | "TOO_MANY_REDIRECTS"
  | "INVALID_REDIRECT";

export class FetchError extends Error {
  constructor(
    readonly code: FetchErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "FetchError";
  }
}

export type FetchImplementation = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface FetchPageOptions {
  deadline: Deadline;
  headers?: ConstructorParameters<typeof Headers>[0];
  maxRedirects?: number;
  maxResponseBytes?: number;
  resolver?: DnsResolver;
  fetchImpl?: FetchImplementation;
}

export interface FetchPageResult {
  sourceUrl: string;
  finalUrl: string;
  statusCode: number;
  headers: Headers;
  contentType?: string;
  charset?: string;
  body: string;
  rawBody: Uint8Array;
  elapsedMs: number;
  redirectCount: number;
}

export async function fetchPage(
  input: string | URL,
  options: FetchPageOptions,
): Promise<FetchPageResult> {
  const startedAt = performance.now();
  const sourceUrl = input instanceof URL ? input.href : input;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  if (!Number.isInteger(maxRedirects) || maxRedirects < 0) {
    throw new TypeError("maxRedirects must be a non-negative integer");
  }
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1) {
    throw new TypeError("maxResponseBytes must be a positive safe integer");
  }

  let currentUrl = await validateResolvedUrl(input, {
    resolver: options.resolver,
    signal: options.deadline.signal,
  });
  let headers = new Headers(options.headers);
  let redirectCount = 0;

  while (true) {
    options.deadline.throwIfExpired();

    let response: Response;
    try {
      response = await fetchImpl(currentUrl, {
        method: "GET",
        headers,
        redirect: "manual",
        signal: options.deadline.signal,
      });
    } catch (cause) {
      // Preserve the deadline's abort reason so callers can distinguish a timeout
      // or client cancellation from an ordinary transport failure.
      if (options.deadline.signal.aborted) {
        throw options.deadline.signal.reason ?? cause;
      }
      throw new FetchError("FETCH_FAILED", `Failed to fetch ${currentUrl.href}`, { cause });
    }

    if (REDIRECT_STATUSES.has(response.status)) {
      const location = response.headers.get("location");
      if (!location) {
        await response.body?.cancel();
        throw new FetchError("INVALID_REDIRECT", "Redirect response has no Location header");
      }
      if (redirectCount >= maxRedirects) {
        await response.body?.cancel();
        throw new FetchError("TOO_MANY_REDIRECTS", `Exceeded ${maxRedirects} redirects`);
      }

      const nextUrl = await validateRedirectUrl(location, currentUrl, {
        resolver: options.resolver,
        signal: options.deadline.signal,
      });

      // Cancel the response body to free up resources and prevent further processing.
      await response.body?.cancel();

      // Never forward caller credentials to a different origin during a redirect.
      if (nextUrl.origin !== currentUrl.origin) {
        headers = new Headers(headers);
        for (const name of SENSITIVE_HEADERS) headers.delete(name);
      }

      currentUrl = nextUrl;
      redirectCount += 1;
      continue;
    }

    const declaredLength = parseContentLength(response.headers.get("content-length"));
    if (declaredLength !== undefined && declaredLength > maxResponseBytes) {
      await response.body?.cancel();
      throw new FetchError(
        "RESPONSE_TOO_LARGE",
        `Response is ${declaredLength} bytes; limit is ${maxResponseBytes}`,
      );
    }

    const rawBody = await readBodyCapped(response, maxResponseBytes);
    const contentTypeHeader = response.headers.get("content-type") ?? undefined;
    const contentType = contentTypeHeader?.split(";", 1)[0]?.trim().toLowerCase() || undefined;
    const { body, charset } = decodeBody(rawBody, contentTypeHeader);

    return {
      sourceUrl,
      finalUrl: currentUrl.href,
      statusCode: response.status,
      headers: response.headers,
      contentType,
      charset,
      body,
      rawBody,
      elapsedMs: performance.now() - startedAt,
      redirectCount,
    };
  }
}

async function readBodyCapped(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        throw new FetchError("RESPONSE_TOO_LARGE", `Response exceeds the ${maxBytes} byte limit`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;

  // this loop is used to copy each chunk of data into the final Uint8Array `body`. Each chunk is a Uint8Array itself, and we need to place them sequentially in the `body` array. The `offset` variable keeps track of where to place the next chunk in the `body` array. This approach ensures that all chunks are concatenated correctly into a single contiguous array.
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

// decodes the raw bytes of a response body into a string, using the specified content type to determine the character encoding.
// example: if the content type is "text/html; charset=ISO-8859-1", it will use the ISO-8859-1 encoding to decode the bytes into a string. If no charset is specified, it defaults to UTF-8.
function decodeBody(bytes: Uint8Array, contentType?: string): { body: string; charset?: string } {
  const headerCharset = contentType?.match(/charset\s*=\s*["']?([^;"'\s]+)/i)?.[1];
  const utf8Preview = new TextDecoder().decode(bytes.subarray(0, 2048));
  const metaCharset = utf8Preview.match(/<meta\b[^>]*charset\s*=\s*["']?([^"'\s/>]+)/i)?.[1];
  const charset = headerCharset?.trim() || metaCharset?.trim();

  if (charset) {
    try {
      return {
        body: new TextDecoder(charset as ConstructorParameters<typeof TextDecoder>[0]).decode(
          bytes,
        ),
        charset,
      };
    } catch {
      // Invalid or unsupported charset labels fall back to UTF-8 rather than
      // turning an otherwise usable response into a fetch failure.
    }
  }
  return { body: new TextDecoder().decode(bytes) };
}

// parses the Content-Length header value into a number.
// example: "1234" => 1234, "abc" => undefined, null => undefined
function parseContentLength(value: string | null): number | undefined {
  if (value === null || !/^\d+$/.test(value)) return undefined;
  const length = Number(value);
  return Number.isSafeInteger(length) ? length : undefined;
}
