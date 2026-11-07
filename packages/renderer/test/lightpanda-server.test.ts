import { describe, expect, test } from "bun:test";
import { Deadline } from "@buncrawl/core";

import { LightpandaRenderer, LightpandaRendererError } from "../src/lightpanda";
import {
  launchLightpandaServer,
  LightpandaPageError,
  LightpandaServer,
  LightpandaServerUnavailableError,
  type CdpConnection,
  type CdpNotification,
} from "../src/lightpanda-server";

interface PageScript {
  errorText?: string;
  /** Main-frame document responses in order (redirect hops then the final page). */
  statuses?: number[];
  iframeStatus?: number;
  fireLoad?: boolean;
  html?: string;
  finalUrl?: string;
}

/** Scripted CDP peer: answers commands and emits the events a page load would produce. */
class FakeCdp implements CdpConnection {
  calls: string[] = [];
  closed = false;
  private listeners = new Set<(event: CdpNotification) => void>();

  constructor(private readonly page: PageScript = {}) {}

  async send(method: string, _params: Record<string, unknown> = {}, sessionId?: string) {
    if (this.closed) throw new Error("Lightpanda connection closed");
    this.calls.push(method);
    switch (method) {
      case "Target.createBrowserContext":
        return { browserContextId: "ctx" };
      case "Target.createTarget":
        return { targetId: "target" };
      case "Target.attachToTarget":
        return { sessionId: "session" };
      case "Page.navigate": {
        if (this.page.errorText) return { frameId: "main", errorText: this.page.errorText };
        queueMicrotask(() => {
          for (const status of this.page.statuses ?? [200])
            this.emit(
              "Network.responseReceived",
              { type: "Document", frameId: "main", response: { status } },
              sessionId,
            );
          if (this.page.iframeStatus)
            this.emit(
              "Network.responseReceived",
              { type: "Document", frameId: "child", response: { status: this.page.iframeStatus } },
              sessionId,
            );
          if (this.page.fireLoad !== false) this.emit("Page.loadEventFired", {}, sessionId);
        });
        return { frameId: "main", loaderId: "loader" };
      }
      case "Runtime.evaluate": {
        const expression = String(_params.expression);
        const value = expression.includes("outerHTML")
          ? (this.page.html ?? "<html><head><title>T</title></head><body>ok</body></html>")
          : (this.page.finalUrl ?? "https://example.com/");
        return { result: { value } };
      }
      default:
        return {};
    }
  }

  onEvent(listener: (event: CdpNotification) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close() {
    this.closed = true;
  }

  private emit(method: string, params: Record<string, unknown>, sessionId?: string) {
    for (const listener of this.listeners) listener({ method, params, sessionId });
  }
}

function serverWith(pages: PageScript[] | PageScript, maxRenders?: number) {
  const connections: FakeCdp[] = [];
  const script = Array.isArray(pages) ? pages : [pages];
  const server = new LightpandaServer(async () => {
    const connection = new FakeCdp(script[Math.min(connections.length, script.length - 1)]);
    connections.push(connection);
    return connection;
  }, maxRenders);
  return { server, connections };
}

const signal = () => new AbortController().signal;

describe("LightpandaServer", () => {
  test("renders through one reused connection and cleans up every page", async () => {
    const { server, connections } = serverWith({
      statuses: [200],
      finalUrl: "https://example.com/final",
    });
    const first = await server.render("https://example.com", 2000, signal());
    await server.render("https://example.com/2", 2000, signal());
    expect(first).toEqual({
      url: "https://example.com/final",
      status: 200,
      html: "<html><head><title>T</title></head><body>ok</body></html>",
    });
    expect(connections).toHaveLength(1);
    expect(
      connections[0]!.calls.filter((call) => call === "Target.disposeBrowserContext"),
    ).toHaveLength(2);
    expect(connections[0]!.calls.filter((call) => call === "Target.closeTarget")).toHaveLength(2);
  });

  test("returns the page after the wait cap when load never fires", async () => {
    const { server } = serverWith({ fireLoad: false });
    const startedAt = performance.now();
    const page = await server.render("https://example.com", 60, signal());
    expect(performance.now() - startedAt).toBeGreaterThanOrEqual(55);
    expect(page.status).toBe(200);
  });

  test("reports the final status after redirects and ignores iframe documents", async () => {
    const { server } = serverWith({ statuses: [301, 404], iframeStatus: 200 });
    expect((await server.render("https://example.com", 2000, signal())).status).toBe(404);
  });

  test("fails a page whose navigation errors or has no document status, and still cleans up", async () => {
    const blocked = serverWith({ errorText: "CouldntConnect" });
    await expect(blocked.server.render("http://10.0.0.1/", 2000, signal())).rejects.toBeInstanceOf(
      LightpandaPageError,
    );
    expect(blocked.connections[0]!.calls).toContain("Target.disposeBrowserContext");

    const empty = serverWith({ statuses: [0] });
    await expect(empty.server.render("https://example.com", 2000, signal())).rejects.toThrow(
      "invalid result",
    );
  });

  test("an aborted render restarts the server so a stuck page cannot block later renders", async () => {
    const { server, connections } = serverWith([{ fireLoad: false }, {}]);
    const controller = new AbortController();
    const render = server.render("https://example.com", 5000, controller.signal);
    setTimeout(() => controller.abort(new Error("deadline")), 20);
    await expect(render).rejects.toThrow("deadline");
    expect(connections[0]!.closed).toBe(true);

    await server.render("https://example.com", 2000, signal());
    expect(connections).toHaveLength(2);
  });

  test("recycles the server after its render budget", async () => {
    const { server, connections } = serverWith({}, 2);
    for (let i = 0; i < 3; i++) await server.render("https://example.com", 2000, signal());
    expect(connections).toHaveLength(2);
    expect(connections[0]!.closed).toBe(true);
  });

  test("reports launch failures as unavailable and retries the launch next time", async () => {
    let attempts = 0;
    const server = new LightpandaServer(async () => {
      attempts++;
      throw new Error("no serve command");
    });
    await expect(server.render("https://example.com", 2000, signal())).rejects.toBeInstanceOf(
      LightpandaServerUnavailableError,
    );
    await expect(server.render("https://example.com", 2000, signal())).rejects.toBeInstanceOf(
      LightpandaServerUnavailableError,
    );
    expect(attempts).toBe(2);
  });
});

describe("LightpandaRenderer server mode", () => {
  const fetchRunner = (calls: string[]) => async (args: string[]) => {
    calls.push(args[args.indexOf("--dump") + 1]!);
    return {
      exitCode: 0,
      stdout: JSON.stringify({
        url: "https://example.com/",
        http_status: 200,
        content: "<html><title>F</title>fetched</html>",
      }),
      stderr: "",
    };
  };

  test("uses the server for HTML renders and per-page fetch for screenshots", async () => {
    const calls: string[] = [];
    const { server, connections } = serverWith({});
    const renderer = new LightpandaRenderer({ runner: fetchRunner(calls), server });
    const page = await renderer.render({
      url: "https://example.com",
      deadline: new Deadline(5000),
    });
    expect(page.title).toBe("T");
    expect(calls).toEqual([]);

    await renderer.render({
      url: "https://example.com",
      deadline: new Deadline(5000),
      screenshot: true,
    });
    expect(calls).toEqual(["html", "png"]);
    expect(connections).toHaveLength(1);
  });

  test("falls back to per-page fetch when the server cannot start", async () => {
    const calls: string[] = [];
    const server = new LightpandaServer(async () => {
      throw new Error("unsupported");
    });
    const renderer = new LightpandaRenderer({ runner: fetchRunner(calls), server });
    for (let i = 0; i < 2; i++) {
      const page = await renderer.render({
        url: "https://example.com",
        deadline: new Deadline(5000),
      });
      expect(page.html).toContain("fetched");
    }
    expect(calls).toEqual(["html", "html"]);
  });

  test("maps page errors and crashes to the codes the renderer chain falls back on", async () => {
    const blocked = new LightpandaRenderer({
      runner: fetchRunner([]),
      server: serverWith({ errorText: "CouldntConnect" }).server,
    });
    const pageError = await blocked
      .render({ url: "http://10.0.0.1/", deadline: new Deadline(5000) })
      .catch((error) => error);
    expect(pageError).toBeInstanceOf(LightpandaRendererError);
    expect(pageError.code).toBe("LIGHTPANDA_INVALID_RESULT");

    const crashing = new LightpandaServer(async () => {
      const connection = new FakeCdp();
      connection.close();
      return connection;
    });
    const crashed = await new LightpandaRenderer({ runner: fetchRunner([]), server: crashing })
      .render({ url: "https://example.com", deadline: new Deadline(5000) })
      .catch((error) => error);
    expect(crashed.code).toBe("LIGHTPANDA_RENDER_FAILED");
  });
});

const lightpanda =
  Bun.which("lightpanda") ?? Bun.which(`${process.env.HOME}/.local/bin/lightpanda`);

describe.skipIf(!lightpanda)("LightpandaServer with the real binary", () => {
  test("renders a page and still blocks private networks", async () => {
    const site = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () =>
        new Response("<title>Real</title><p>hello</p>", {
          headers: { "content-type": "text/html" },
        }),
    });
    // Exempt only the loopback test site; every other private range stays blocked.
    const server = new LightpandaServer(
      launchLightpandaServer(lightpanda!, [
        "--block-private-networks",
        "--block-cidrs",
        "-127.0.0.1/32",
      ]),
    );
    try {
      const page = await server.render(`http://127.0.0.1:${site.port}/page`, 2000, signal());
      expect(page).toMatchObject({ status: 200, url: `http://127.0.0.1:${site.port}/page` });
      expect(page.html).toContain("<p>hello</p>");
      await expect(server.render("http://10.0.0.1/", 2000, signal())).rejects.toBeInstanceOf(
        LightpandaPageError,
      );
    } finally {
      server.close();
      site.stop(true);
    }
  });
});
