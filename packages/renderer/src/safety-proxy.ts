/*
This file maitains a safety proxy that can be used to forward HTTP and HTTPS requests from a browser view to their intended destinations, while enforcing security policies such as DNS resolution, upstream proxying, and request filtering. The proxy listens on a local TCP port and accepts connections from the browser view, forwarding requests to the target servers or upstream proxies as needed. It also handles CONNECT tunnels for HTTPS requests and supports SOCKS4 and SOCKS5 proxies.

*/

import { type DnsResolver, resolveSafeUrl, type ResolveUrlOptions } from "@buncrawl/security";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { connect as createTlsConnection } from "node:tls";

const MAX_HEADER_BYTES = 64 * 1024;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;

export interface BrowserSafetyProxyOptions {
  resolver?: DnsResolver;
  dnsTimeoutMs?: number;
  connect?: (address: string, port: number) => Socket;
  upstreamProxy?: string;
  handshakeTimeoutMs?: number;
}

export class BrowserSafetyProxy {
  readonly url: string;
  private readonly sockets = new Set<Socket>();
  private readonly upstreamProxy?: URL;
  private readonly handshakeTimeoutMs: number;

  private constructor(
    private readonly server: Server,
    private readonly options: BrowserSafetyProxyOptions,
    port: number,
  ) {
    this.url = `http://127.0.0.1:${port}`;
    this.upstreamProxy = options.upstreamProxy
      ? validateUpstreamProxy(options.upstreamProxy)
      : undefined;
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
    if (!Number.isFinite(this.handshakeTimeoutMs) || this.handshakeTimeoutMs <= 0) {
      throw new TypeError("handshakeTimeoutMs must be positive");
    }
  }

  static async start(options: BrowserSafetyProxyOptions = {}): Promise<BrowserSafetyProxy> {
    let proxy: BrowserSafetyProxy | undefined;
    const server = createServer((socket) => proxy?.accept(socket));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      throw new Error("Browser safety proxy failed to bind a TCP port");
    }
    proxy = new BrowserSafetyProxy(server, options, address.port);
    return proxy;
  }

  close(): void {
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    this.server.close();
  }

  private accept(client: Socket): void {
    this.sockets.add(client);
    client.once("close", () => this.sockets.delete(client));
    let buffered = Buffer.alloc(0);
    const read = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.length > MAX_HEADER_BYTES) {
        rejectClient(client, 431, "Request Header Fields Too Large");
        return;
      }
      const headerEnd = buffered.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      client.removeListener("data", read);
      client.pause();
      const head = buffered.subarray(0, headerEnd).toString("latin1");
      const remainder = buffered.subarray(headerEnd + 4);
      void this.forward(client, head, remainder);
    };
    client.on("data", read);
    client.on("error", () => undefined);
  }

  private async forward(client: Socket, head: string, remainder: Buffer): Promise<void> {
    const lines = head.split("\r\n");
    const requestLine = lines.shift();
    const match = requestLine?.match(/^(\S+)\s+(\S+)\s+(HTTP\/1\.[01])$/);
    if (!match) {
      rejectClient(client, 400, "Bad Request");
      return;
    }
    const [, method, target, version] = match;

    try {
      if (method === "CONNECT") {
        await this.connectTunnel(client, target!, remainder);
        return;
      }
      await this.forwardHttp(client, method!, target!, version!, lines, remainder);
    } catch {
      rejectClient(client, 403, "Forbidden");
    }
  }

  private async connectTunnel(client: Socket, authority: string, remainder: Buffer): Promise<void> {
    const target = await this.resolve(`https://${authority}/`);
    const upstream = await this.connectTarget(target.addresses[0]!, Number(target.url.port || 443));
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (remainder.length > 0) upstream.write(remainder);
    pipeSockets(client, upstream);
  }

  private async forwardHttp(
    client: Socket,
    method: string,
    target: string,
    version: string,
    headers: string[],
    remainder: Buffer,
  ): Promise<void> {
    const resolved = await this.resolve(target);
    if (resolved.url.protocol !== "http:") throw new Error("Plain proxy request must use HTTP");
    const address = resolved.addresses[0]!;
    const port = Number(resolved.url.port || 80);
    const usesHttpUpstream =
      this.upstreamProxy?.protocol === "http:" || this.upstreamProxy?.protocol === "https:";
    const upstream = this.upstreamProxy
      ? usesHttpUpstream
        ? await this.connectUpstream()
        : await this.connectTarget(address, port)
      : await this.connect(address, port);
    const filteredHeaders = headers.filter(
      (header) => !/^(?:proxy-authorization|proxy-connection|connection):/i.test(header),
    );
    const path = usesHttpUpstream
      ? `http://${formatAuthority(address, port)}${resolved.url.pathname}${resolved.url.search}`
      : `${resolved.url.pathname}${resolved.url.search}` || "/";
    const proxyAuthorization = usesHttpUpstream
      ? proxyAuthorizationHeader(this.upstreamProxy!)
      : undefined;
    upstream.write(
      `${method} ${path} ${version}\r\n${filteredHeaders.join("\r\n")}\r\n${proxyAuthorization ? `${proxyAuthorization}\r\n` : ""}Connection: close\r\n\r\n`,
    );
    if (remainder.length > 0) upstream.write(remainder);
    pipeSockets(client, upstream);
  }

  private resolve(input: string) {
    const options: ResolveUrlOptions = {
      resolver: this.options.resolver,
      dnsTimeoutMs: this.options.dnsTimeoutMs,
    };
    return resolveSafeUrl(input, options);
  }

  private connect(address: string, port: number): Promise<Socket> {
    const socket =
      this.options.connect?.(address, port) ?? createConnection({ host: address, port });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => failed(new Error("Destination connection timed out")),
        this.handshakeTimeoutMs,
      );
      const connected = () => {
        clearTimeout(timer);
        socket.removeListener("error", failed);
        resolve(socket);
      };
      const failed = (error: Error) => {
        clearTimeout(timer);
        socket.removeListener("connect", connected);
        socket.destroy();
        reject(error);
      };
      socket.once("connect", connected);
      socket.once("error", failed);
    });
  }

  private async connectTarget(address: string, port: number): Promise<Socket> {
    if (!this.upstreamProxy) return this.connect(address, port);
    if (this.upstreamProxy.protocol === "socks5:") {
      return this.connectSocks5(address, port);
    }
    if (this.upstreamProxy.protocol === "socks4:") {
      return this.connectSocks4(address, port);
    }
    const upstream = await this.connectUpstream();
    const authorization = proxyAuthorizationHeader(this.upstreamProxy);
    upstream.write(
      `CONNECT ${formatAuthority(address, port)} HTTP/1.1\r\nHost: ${formatAuthority(address, port)}\r\n${authorization ? `${authorization}\r\n` : ""}Proxy-Connection: keep-alive\r\n\r\n`,
    );
    const response = await readHeader(upstream, this.handshakeTimeoutMs);
    const status = response.head.match(/^HTTP\/1\.[01]\s+(\d{3})\b/)?.[1];
    if (status !== "200") {
      upstream.destroy();
      throw new Error(`Upstream proxy rejected CONNECT with status ${status ?? "unknown"}`);
    }
    if (response.remainder.length > 0) upstream.unshift(response.remainder);
    return upstream;
  }

  private connectUpstream(): Promise<Socket> {
    const proxy = this.upstreamProxy;
    if (!proxy) throw new Error("Upstream proxy is not configured");
    const port = Number(
      proxy.port ||
        (proxy.protocol === "https:"
          ? 443
          : proxy.protocol === "socks4:" || proxy.protocol === "socks5:"
            ? 1080
            : 80),
    );
    if (proxy.protocol === "https:") {
      const socket = createTlsConnection({
        host: proxy.hostname,
        port,
        servername: proxy.hostname,
      });
      return waitForConnection(socket, "secureConnect", this.handshakeTimeoutMs);
    }
    return waitForConnection(
      createConnection({ host: proxy.hostname, port }),
      "connect",
      this.handshakeTimeoutMs,
    );
  }

  private async connectSocks5(address: string, port: number): Promise<Socket> {
    const proxy = this.upstreamProxy!;
    const socket = await this.connectUpstream();
    const authenticated = Boolean(proxy.username || proxy.password);
    socket.write(Buffer.from([5, 1, authenticated ? 2 : 0]));
    const greeting = await readExact(socket, 2, this.handshakeTimeoutMs);
    if (greeting[0] !== 5 || greeting[1] === 0xff) throw new Error("SOCKS5 authentication failed");
    if (greeting[1] === 2) {
      const username = Buffer.from(decodeURIComponent(proxy.username));
      const password = Buffer.from(decodeURIComponent(proxy.password));
      if (username.length > 255 || password.length > 255) {
        throw new Error("SOCKS5 credentials are too long");
      }
      socket.write(
        Buffer.concat([
          Buffer.from([1, username.length]),
          username,
          Buffer.from([password.length]),
          password,
        ]),
      );
      const auth = await readExact(socket, 2, this.handshakeTimeoutMs);
      if (auth[1] !== 0) throw new Error("SOCKS5 credentials were rejected");
    } else if (authenticated || greeting[1] !== 0) {
      throw new Error("SOCKS5 proxy did not accept the configured authentication method");
    }

    const encodedAddress = encodeSocksAddress(address);
    socket.write(
      Buffer.concat([
        Buffer.from([5, 1, 0, encodedAddress.type]),
        encodedAddress.bytes,
        Buffer.from([port >> 8, port & 255]),
      ]),
    );
    const response = await readSocks5Reply(socket, this.handshakeTimeoutMs);
    if (response[0] !== 5 || response[1] !== 0) throw new Error("SOCKS5 CONNECT failed");
    return socket;
  }

  private async connectSocks4(address: string, port: number): Promise<Socket> {
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(address)) {
      throw new Error("SOCKS4 cannot connect to an IPv6 destination");
    }
    const proxy = this.upstreamProxy!;
    if (proxy.password) throw new Error("SOCKS4 does not support password authentication");
    const socket = await this.connectUpstream();
    const octets = address.split(".").map(Number);
    const user = Buffer.from(decodeURIComponent(proxy.username));
    socket.write(
      Buffer.concat([
        Buffer.from([4, 1, port >> 8, port & 255, ...octets]),
        user,
        Buffer.from([0]),
      ]),
    );
    const response = await readExact(socket, 8, this.handshakeTimeoutMs);
    if (response[1] !== 90) throw new Error("SOCKS4 CONNECT failed");
    return socket;
  }
}

function pipeSockets(client: Socket, upstream: Socket): void {
  client.pipe(upstream);
  upstream.pipe(client);
  client.resume();
  client.once("close", () => upstream.destroy());
  upstream.once("close", () => client.destroy());
  upstream.on("error", () => client.destroy());
}

function rejectClient(client: Socket, status: number, reason: string): void {
  if (client.destroyed) return;
  client.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

function validateUpstreamProxy(value: string): URL {
  let proxy: URL;
  try {
    proxy = new URL(value);
  } catch (cause) {
    throw new TypeError("Invalid upstream proxy URL", { cause });
  }
  if (!["http:", "https:", "socks4:", "socks5:"].includes(proxy.protocol)) {
    throw new TypeError("Upstream proxy must use HTTP, HTTPS, SOCKS4, or SOCKS5");
  }
  if ((proxy.pathname && proxy.pathname !== "/") || proxy.search || proxy.hash) {
    throw new TypeError("Upstream proxy URL cannot contain a path, query, or fragment");
  }
  proxyAuthorizationHeader(proxy);
  return proxy;
}

function proxyAuthorizationHeader(proxy: URL): string | undefined {
  if (!proxy.username && !proxy.password) return;
  const username = decodeURIComponent(proxy.username);
  const password = decodeURIComponent(proxy.password);
  return `Proxy-Authorization: Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

function formatAuthority(address: string, port: number): string {
  return `${address.includes(":") ? `[${address}]` : address}:${port}`;
}

function waitForConnection(
  socket: Socket,
  event: "connect" | "secureConnect",
  timeoutMs: number,
): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => failed(new Error("Proxy connection timed out")), timeoutMs);
    const connected = () => {
      clearTimeout(timer);
      socket.removeListener("error", failed);
      resolve(socket);
    };
    const failed = (error: Error) => {
      clearTimeout(timer);
      socket.removeListener(event, connected);
      socket.destroy();
      reject(error);
    };
    socket.once(event, connected);
    socket.once("error", failed);
  });
}

function readHeader(
  socket: Socket,
  timeoutMs: number,
): Promise<{ head: string; remainder: Buffer }> {
  return new Promise((resolve, reject) => {
    let buffered = Buffer.alloc(0);
    const timer = setTimeout(() => {
      error(new Error("Proxy response timed out"));
      socket.destroy();
    }, timeoutMs);
    const data = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.length > MAX_HEADER_BYTES) {
        cleanup();
        reject(new Error("Upstream proxy response headers are too large"));
        return;
      }
      const headerEnd = buffered.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      cleanup();
      resolve({
        head: buffered.subarray(0, headerEnd).toString("latin1"),
        remainder: buffered.subarray(headerEnd + 4),
      });
    };
    const error = (cause: Error) => {
      cleanup();
      reject(cause);
    };
    const closed = () => {
      cleanup();
      reject(new Error("Upstream proxy closed before responding"));
    };
    const cleanup = () => {
      clearTimeout(timer);
      socket.removeListener("data", data);
      socket.removeListener("error", error);
      socket.removeListener("close", closed);
    };
    socket.on("data", data);
    socket.once("error", error);
    socket.once("close", closed);
  });
}

function readExact(socket: Socket, length: number, timeoutMs: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let buffered = Buffer.alloc(0);
    const timer = setTimeout(() => {
      error(new Error("Proxy handshake timed out"));
      socket.destroy();
    }, timeoutMs);
    const data = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.length < length) return;
      cleanup();
      if (buffered.length > length) socket.unshift(buffered.subarray(length));
      resolve(buffered.subarray(0, length));
    };
    const error = (cause: Error) => {
      cleanup();
      reject(cause);
    };
    const closed = () => {
      cleanup();
      reject(new Error("Proxy closed before completing its handshake"));
    };
    const cleanup = () => {
      clearTimeout(timer);
      socket.removeListener("data", data);
      socket.removeListener("error", error);
      socket.removeListener("close", closed);
    };
    socket.on("data", data);
    socket.once("error", error);
    socket.once("close", closed);
  });
}

function encodeSocksAddress(address: string): { type: number; bytes: Buffer } {
  if (/^\d+\.\d+\.\d+\.\d+$/.test(address)) {
    return { type: 1, bytes: Buffer.from(address.split(".").map(Number)) };
  }
  const groups = expandIpv6(address);
  const bytes = Buffer.alloc(16);
  groups.forEach((group, index) => bytes.writeUInt16BE(group, index * 2));
  return { type: 4, bytes };
}

function readSocks5Reply(socket: Socket, timeoutMs: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let buffered = Buffer.alloc(0);
    const timer = setTimeout(() => {
      error(new Error("SOCKS5 CONNECT timed out"));
      socket.destroy();
    }, timeoutMs);
    const data = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.length < 5) return;
      const addressLength =
        buffered[3] === 1 ? 4 : buffered[3] === 4 ? 16 : buffered[3] === 3 ? buffered[4]! + 1 : -1;
      if (addressLength < 0) {
        cleanup();
        reject(new Error("SOCKS5 proxy returned an invalid address type"));
        return;
      }
      const expected = 4 + addressLength + 2;
      if (buffered.length < expected) return;
      cleanup();
      if (buffered.length > expected) socket.unshift(buffered.subarray(expected));
      resolve(buffered.subarray(0, expected));
    };
    const error = (cause: Error) => {
      cleanup();
      reject(cause);
    };
    const closed = () => {
      cleanup();
      reject(new Error("SOCKS5 proxy closed before completing CONNECT"));
    };
    const cleanup = () => {
      clearTimeout(timer);
      socket.removeListener("data", data);
      socket.removeListener("error", error);
      socket.removeListener("close", closed);
    };
    socket.on("data", data);
    socket.once("error", error);
    socket.once("close", closed);
  });
}

function expandIpv6(address: string): number[] {
  const halves = address.split("::");
  if (halves.length > 2) throw new Error("Invalid IPv6 address");
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  const groups = [...left, ...Array(missing).fill("0"), ...right].map((group) =>
    Number.parseInt(group, 16),
  );
  if (groups.length !== 8 || groups.some((group) => !Number.isInteger(group))) {
    throw new Error("Invalid IPv6 address");
  }
  return groups;
}
