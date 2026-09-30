import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const MAX_URL_LENGTH = 2048;
const DEFAULT_DNS_TIMEOUT_MS = 8000;

const BLOCKED_HOSTS = new Set(["localhost", "metadata.google.internal"]);
const BLOCKED_HOST_SUFFIXES = [
  ".localhost",
  ".localtest.me",
  ".lvh.me",
  ".nip.io",
  ".xip.io",
  ".sslip.io",
];

export type UrlSafetyErrorCode = "INVALID_URL" | "BLOCKED_DESTINATION" | "DNS_RESOLUTION_FAILED";

export class UrlSafetyError extends Error {
  constructor(
    readonly code: UrlSafetyErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "UrlSafetyError";
  }
}

export type DnsResolver = (hostname: string) => Promise<readonly string[]>;

export interface ResolveUrlOptions {
  resolver?: DnsResolver; // makes sure that the hostname resolves to a public IP address, preventing SSRF attacks.
  dnsTimeoutMs?: number; // sets a timeout for DNS resolution to avoid long delays when resolving hostnames.
  signal?: AbortSignal; // allows the caller to abort the DNS resolution if it takes too long or if the request is canceled.
}

export function validateUrl(input: string | URL): URL {
  const raw = typeof input === "string" ? input : input.href;

  if (raw.length > MAX_URL_LENGTH) {
    throw new UrlSafetyError("INVALID_URL", `URL exceeds ${MAX_URL_LENGTH} characters`);
  }
  if (raw.includes("\0") || /%00/i.test(raw)) {
    throw new UrlSafetyError("INVALID_URL", "URL contains a null byte");
  }

  let url: URL;
  try {
    url = input instanceof URL ? new URL(input.href) : new URL(input);
  } catch (cause) {
    throw new UrlSafetyError("INVALID_URL", "Invalid URL", { cause });
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UrlSafetyError("INVALID_URL", "Only HTTP and HTTPS URLs are allowed");
  }
  if (!url.hostname) {
    throw new UrlSafetyError("INVALID_URL", "URL must include a hostname");
  }
  if (url.username || url.password) {
    throw new UrlSafetyError("INVALID_URL", "URLs containing credentials are not allowed");
  }

  validateHostname(url.hostname);
  return url;
}

export function validateHostname(hostname: string): void {
  const host = normalizeHostname(hostname);
  if (!host) {
    throw new UrlSafetyError("INVALID_URL", "URL must include a hostname");
  }

  if (BLOCKED_HOSTS.has(host) || BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    throw new UrlSafetyError("BLOCKED_DESTINATION", "Host is not allowed");
  }

  if (isIP(host) !== 0 && isBlockedIp(host)) {
    throw new UrlSafetyError("BLOCKED_DESTINATION", `Access to ${host} is not allowed`);
  }
}

// validates a URL and resolves its hostname to ensure that it does not point to a blocked IP address.
export async function validateResolvedUrl(
  input: string | URL,
  options: ResolveUrlOptions = {},
): Promise<URL> {
  const url = validateUrl(input);
  const hostname = normalizeHostname(url.hostname);

  if (isIP(hostname) !== 0) {
    return url;
  }

  const resolver = options.resolver ?? systemResolver;
  const timeoutMs = options.dnsTimeoutMs ?? DEFAULT_DNS_TIMEOUT_MS;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;

  let addresses: readonly string[];
  try {
    addresses = await Promise.race([
      resolver(hostname),
      new Promise<never>((_, reject) => {
        signal.addEventListener(
          "abort",
          () => reject(signal.reason ?? new Error("DNS resolution aborted")),
          { once: true },
        );
      }),
    ]);
  } catch (cause) {
    if (options.signal?.aborted) {
      throw options.signal.reason ?? cause;
    }
    throw new UrlSafetyError("DNS_RESOLUTION_FAILED", "DNS resolution failed", { cause });
  }

  if (addresses.length === 0) {
    throw new UrlSafetyError("DNS_RESOLUTION_FAILED", "DNS returned no addresses");
  }

  for (const address of addresses) {
    if (isIP(address) === 0) {
      throw new UrlSafetyError("DNS_RESOLUTION_FAILED", "DNS returned an invalid address");
    }
    if (isBlockedIp(address)) {
      throw new UrlSafetyError(
        "BLOCKED_DESTINATION",
        `Host resolves to disallowed address ${address}`,
      );
    }
  }

  return url;
}

//  validates a redirect URL, ensuring that it is a valid URL and that it does not point to a blocked destination.
export async function validateRedirectUrl(
  location: string,
  currentUrl: string | URL,
  options: ResolveUrlOptions = {},
): Promise<URL> {
  let target: URL;
  try {
    target = new URL(location, currentUrl);
  } catch (cause) {
    throw new UrlSafetyError("INVALID_URL", "Redirect contains an invalid URL", { cause });
  }
  return validateResolvedUrl(target, options);
}

export function isBlockedIp(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return isBlockedIpv4(address);
  if (version === 6) return isBlockedIpv6(address);
  return true;
}

async function systemResolver(hostname: string): Promise<readonly string[]> {
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  return addresses.map(({ address }) => address);
}

function normalizeHostname(hostname: string): string {
  return hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
}

function isBlockedIpv4(address: string): boolean {
  const octets = address.split(".").map(Number);
  if (
    octets.length !== 4 ||
    octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return true;
  }
  const [a, b, c] = octets as [number, number, number, number];

  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function isBlockedIpv6(address: string): boolean {
  const value = parseIpv6(address);
  if (value === null) return true;

  if (value === 0n || value === 1n) return true;
  if (inIpv6Range(value, "fc00::", 7)) return true;
  if (inIpv6Range(value, "fe80::", 10)) return true;
  if (inIpv6Range(value, "fec0::", 10)) return true;
  if (inIpv6Range(value, "ff00::", 8)) return true;
  if (inIpv6Range(value, "200::", 8)) return true;
  if (inIpv6Range(value, "64:ff9b:1::", 48)) return true;

  const mapped = extractEmbeddedIpv4(value, address);
  return mapped !== null && isBlockedIpv4(mapped);
}

function extractEmbeddedIpv4(value: bigint, address: string): string | null {
  const ipv4 = Number(value & 0xffffffffn);
  const asAddress = `${ipv4 >>> 24}.${(ipv4 >>> 16) & 255}.${(ipv4 >>> 8) & 255}.${ipv4 & 255}`;

  if (inIpv6Range(value, "::", 96) || inIpv6Range(value, "::ffff:0:0", 96)) {
    return asAddress;
  }
  if (inIpv6Range(value, "64:ff9b::", 96)) {
    return asAddress;
  }
  if (inIpv6Range(value, "2002::", 16)) {
    const embedded = Number((value >> 80n) & 0xffffffffn);
    return `${embedded >>> 24}.${(embedded >>> 16) & 255}.${(embedded >>> 8) & 255}.${embedded & 255}`;
  }

  // IPv4 dotted notation can appear in mapped/compatible forms.
  if (address.includes(".")) return asAddress;
  return null;
}

function inIpv6Range(value: bigint, network: string, prefix: number): boolean {
  const networkValue = parseIpv6(network);
  if (networkValue === null) return false;
  const shift = BigInt(128 - prefix);
  return value >> shift === networkValue >> shift;
}

function parseIpv6(address: string): bigint | null {
  let input = normalizeHostname(address).split("%", 1)[0] ?? "";
  const dottedIndex = input.lastIndexOf(":");
  if (input.includes(".") && dottedIndex >= 0) {
    const dotted = input.slice(dottedIndex + 1);
    if (isIP(dotted) !== 4) return null;
    const parts = dotted.split(".").map(Number) as [number, number, number, number];
    input = `${input.slice(0, dottedIndex)}:${((parts[0] << 8) | parts[1]).toString(16)}:${((parts[2] << 8) | parts[3]).toString(16)}`;
  }

  const halves = input.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null;

  const groups = [...left, ...Array(missing).fill("0"), ...right];
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/i.test(group))) {
    return null;
  }

  return groups.reduce((value, group) => (value << 16n) | BigInt(`0x${group}`), 0n);
}
