import { afterEach, describe, expect, test } from "bun:test";
import { createConnection, createServer, type Server, type Socket } from "node:net";

import { BrowserSafetyProxy } from "./safety-proxy";

const cleanup: Array<() => void> = [];

afterEach(() => {
  for (const close of cleanup.splice(0)) close();
});

describe("BrowserSafetyProxy", () => {
  test.each([
    "127.0.0.1:80",
    "192.168.1.10:443",
    "169.254.169.254:80",
  ])("rejects CONNECT to protected destination %s", async (authority) => {
    const proxy = await BrowserSafetyProxy.start();
    cleanup.push(() => proxy.close());

    const response = await proxyRequest(proxy.url, `CONNECT ${authority} HTTP/1.1\r\n\r\n`);

    expect(response).toStartWith("HTTP/1.1 403 Forbidden");
  });

  test("connects to the exact address returned by validated DNS", async () => {
    const target = await echoServer();
    const connected: Array<{ address: string; port: number }> = [];
    const proxy = await BrowserSafetyProxy.start({
      resolver: async () => ["93.184.216.34"],
      connect(address, port) {
        connected.push({ address, port });
        return createConnection({ host: "127.0.0.1", port: target.port });
      },
    });
    cleanup.push(() => proxy.close());

    const response = await proxyRequest(
      proxy.url,
      "CONNECT public.example:443 HTTP/1.1\r\nHost: public.example:443\r\n\r\n",
    );

    expect(response).toStartWith("HTTP/1.1 200 Connection Established");
    expect(connected).toEqual([{ address: "93.184.216.34", port: 443 }]);
  });

  test("re-resolves each tunnel and blocks a rebinding destination", async () => {
    const target = await echoServer();
    let resolutions = 0;
    let connections = 0;
    const proxy = await BrowserSafetyProxy.start({
      resolver: async () => (++resolutions === 1 ? ["93.184.216.34"] : ["127.0.0.1"]),
      connect() {
        connections += 1;
        return createConnection({ host: "127.0.0.1", port: target.port });
      },
    });
    cleanup.push(() => proxy.close());

    const first = await proxyRequest(proxy.url, "CONNECT rebind.example:443 HTTP/1.1\r\n\r\n");
    const second = await proxyRequest(proxy.url, "CONNECT rebind.example:443 HTTP/1.1\r\n\r\n");

    expect(first).toStartWith("HTTP/1.1 200 Connection Established");
    expect(second).toStartWith("HTTP/1.1 403 Forbidden");
    expect(resolutions).toBe(2);
    expect(connections).toBe(1);
  });

  test("chains a pinned IP through an authenticated upstream proxy", async () => {
    let received = "";
    const upstream = await testServer((socket) => {
      socket.once("data", (data) => {
        received = data.toString("latin1");
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      });
    });
    const proxy = await BrowserSafetyProxy.start({
      resolver: async () => ["93.184.216.34"],
      upstreamProxy: `http://user:secret@127.0.0.1:${upstream.port}`,
    });
    cleanup.push(() => proxy.close());

    const response = await proxyRequest(
      proxy.url,
      "CONNECT target.example:443 HTTP/1.1\r\nHost: target.example:443\r\n\r\n",
    );

    expect(response).toStartWith("HTTP/1.1 200 Connection Established");
    expect(received).toContain("CONNECT 93.184.216.34:443 HTTP/1.1");
    expect(received).toContain("Proxy-Authorization: Basic dXNlcjpzZWNyZXQ=");
  });

  test("never falls back to direct traffic when the upstream proxy fails", async () => {
    const upstream = await testServer((socket) => {
      socket.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n");
    });
    let directConnections = 0;
    const proxy = await BrowserSafetyProxy.start({
      resolver: async () => ["93.184.216.34"],
      upstreamProxy: `http://127.0.0.1:${upstream.port}`,
      connect() {
        directConnections += 1;
        return createConnection({ host: "127.0.0.1", port: upstream.port });
      },
    });
    cleanup.push(() => proxy.close());

    const response = await proxyRequest(
      proxy.url,
      "CONNECT target.example:443 HTTP/1.1\r\n\r\n",
    );

    expect(response).toStartWith("HTTP/1.1 403 Forbidden");
    expect(directConnections).toBe(0);
  });

  test("bounds an unresponsive upstream proxy handshake", async () => {
    const upstream = await testServer(() => undefined);
    const proxy = await BrowserSafetyProxy.start({
      resolver: async () => ["93.184.216.34"],
      upstreamProxy: `http://127.0.0.1:${upstream.port}`,
      handshakeTimeoutMs: 25,
    });
    cleanup.push(() => proxy.close());
    const startedAt = performance.now();

    const response = await proxyRequest(
      proxy.url,
      "CONNECT target.example:443 HTTP/1.1\r\n\r\n",
    );

    expect(response).toStartWith("HTTP/1.1 403 Forbidden");
    expect(performance.now() - startedAt).toBeLessThan(500);
  });

  test("pins plain HTTP upstream requests while preserving the original Host", async () => {
    let received = "";
    const upstream = await testServer((socket) => {
      socket.once("data", (data) => {
        received = data.toString("latin1");
        socket.end("HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n");
      });
    });
    const proxy = await BrowserSafetyProxy.start({
      resolver: async () => ["93.184.216.34"],
      upstreamProxy: `http://127.0.0.1:${upstream.port}`,
    });
    cleanup.push(() => proxy.close());

    const response = await proxyRequest(
      proxy.url,
      "GET http://target.example/path?q=1 HTTP/1.1\r\nHost: target.example\r\n\r\n",
    );

    expect(response).toStartWith("HTTP/1.1 200 OK");
    expect(received).toStartWith("GET http://93.184.216.34:80/path?q=1 HTTP/1.1");
    expect(received).toContain("Host: target.example");
  });

  test("sends the validated IP through a SOCKS5 upstream", async () => {
    let connectRequest = Buffer.alloc(0);
    const upstream = await testServer((socket) => {
      socket.once("data", () => {
        socket.write(Buffer.from([5, 0]));
        socket.once("data", (data) => {
          connectRequest = Buffer.from(data);
          socket.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
        });
      });
    });
    const proxy = await BrowserSafetyProxy.start({
      resolver: async () => ["93.184.216.34"],
      upstreamProxy: `socks5://127.0.0.1:${upstream.port}`,
    });
    cleanup.push(() => proxy.close());

    const response = await proxyRequest(
      proxy.url,
      "CONNECT target.example:443 HTTP/1.1\r\n\r\n",
    );

    expect(response).toStartWith("HTTP/1.1 200 Connection Established");
    expect([...connectRequest.subarray(4, 8)]).toEqual([93, 184, 216, 34]);
    expect(connectRequest.readUInt16BE(8)).toBe(443);
  });

  test("sends the validated IPv4 address through a SOCKS4 upstream", async () => {
    let connectRequest = Buffer.alloc(0);
    const upstream = await testServer((socket) => {
      socket.once("data", (data) => {
        connectRequest = Buffer.from(data);
        socket.write(Buffer.from([0, 90, 0, 0, 0, 0, 0, 0]));
      });
    });
    const proxy = await BrowserSafetyProxy.start({
      resolver: async () => ["93.184.216.34"],
      upstreamProxy: `socks4://worker@127.0.0.1:${upstream.port}`,
    });
    cleanup.push(() => proxy.close());

    const response = await proxyRequest(
      proxy.url,
      "CONNECT target.example:443 HTTP/1.1\r\n\r\n",
    );

    expect(response).toStartWith("HTTP/1.1 200 Connection Established");
    expect([...connectRequest.subarray(4, 8)]).toEqual([93, 184, 216, 34]);
    expect(connectRequest.readUInt16BE(2)).toBe(443);
    expect(connectRequest.subarray(8).toString()).toBe("worker\0");
  });
});

async function echoServer(): Promise<{ server: Server; port: number }> {
  return testServer((socket) => socket.on("data", (data) => socket.write(data)));
}

async function testServer(
  connection: (socket: Socket) => void,
): Promise<{ server: Server; port: number }> {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    connection(socket);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind");
  cleanup.push(() => {
    for (const socket of sockets) socket.destroy();
    server.close();
  });
  return { server, port: address.port };
}

function proxyRequest(proxyUrl: string, request: string): Promise<string> {
  const url = new URL(proxyUrl);
  return new Promise((resolve, reject) => {
    const socket: Socket = createConnection({ host: url.hostname, port: Number(url.port) });
    let response = "";
    socket.once("connect", () => socket.write(request));
    socket.on("data", (chunk) => {
      response += chunk.toString("latin1");
      if (!response.includes("\r\n\r\n")) return;
      socket.destroy();
      resolve(response);
    });
    socket.once("error", reject);
  });
}
