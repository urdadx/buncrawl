/**
 * Renders pages through one long-lived `lightpanda serve` process over CDP. Starting a fresh
 * `lightpanda fetch` costs about 500ms of browser setup per page; a warm server opens a new browser
 * context in about 10ms. Each page still gets its own isolated context.
 */

export interface CdpNotification {
  method: string;
  params: Record<string, unknown>;
  sessionId?: string;
}

/** A CDP client; `send` rejects on protocol errors and once the connection closes. */
export interface CdpConnection {
  send(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
  ): Promise<Record<string, unknown>>;
  onEvent(listener: (event: CdpNotification) => void): () => void;
  close(): void;
}

export type LaunchLightpanda = () => Promise<CdpConnection>;

export interface LightpandaPage {
  url: string;
  status: number;
  html: string;
}

/** The server could not be started or reached; callers fall back to per-page `lightpanda fetch`. */
export class LightpandaServerUnavailableError extends Error {}

/** Navigation or page inspection failed for this URL. */
export class LightpandaPageError extends Error {}

const DEFAULT_MAX_RENDERS_PER_SERVER = 200;

export class LightpandaServer {
  private connection?: Promise<CdpConnection>;
  private renders = 0;

  constructor(
    private readonly launch: LaunchLightpanda,
    private readonly maxRendersPerServer = DEFAULT_MAX_RENDERS_PER_SERVER,
  ) {}

  /** Navigates to `url` and waits for its load event, at most `waitMs`, like `fetch --wait-ms`. */
  async render(url: string, waitMs: number, signal: AbortSignal): Promise<LightpandaPage> {
    const connection = await this.connect();
    // A render that outlives its deadline may be stuck; replacing the server is the only reliable stop.
    const abort = () => this.restart();
    signal.addEventListener("abort", abort, { once: true });
    let browserContextId: unknown;
    let targetId: unknown;
    let stopListening = () => {};
    try {
      ({ browserContextId } = await connection.send("Target.createBrowserContext"));
      ({ targetId } = await connection.send("Target.createTarget", {
        url: "about:blank",
        browserContextId,
      }));
      const { sessionId } = (await connection.send("Target.attachToTarget", {
        targetId,
        flatten: true,
      })) as { sessionId: string };
      await connection.send("Page.enable", {}, sessionId);
      await connection.send("Network.enable", {}, sessionId);

      let markLoaded = () => {};
      const loaded = new Promise<void>((resolve) => (markLoaded = resolve));
      const documents: Array<{ frameId: unknown; status: unknown }> = [];
      stopListening = connection.onEvent((event) => {
        if (event.sessionId !== sessionId) return;
        if (event.method === "Page.loadEventFired") markLoaded();
        if (event.method === "Network.responseReceived" && event.params.type === "Document") {
          const response = event.params.response as { status?: unknown } | undefined;
          documents.push({ frameId: event.params.frameId, status: response?.status });
        }
      });

      const startedAt = performance.now();
      const navigation = await connection.send("Page.navigate", { url }, sessionId);
      if (typeof navigation.errorText === "string" && navigation.errorText) {
        throw new LightpandaPageError(navigation.errorText);
      }
      await waitUpTo(loaded, waitMs - (performance.now() - startedAt), signal);
      if (signal.aborted) throw signal.reason ?? new Error("Render aborted");

      const html = await evaluate(connection, sessionId, "document.documentElement.outerHTML");
      const finalUrl = await evaluate(connection, sessionId, "location.href");
      // Redirects reuse the main frame; the last main-frame document is the page that rendered.
      const status = documents.filter((doc) => doc.frameId === navigation.frameId).at(-1)?.status;
      if (
        typeof html !== "string" ||
        typeof finalUrl !== "string" ||
        typeof status !== "number" ||
        status === 0
      ) {
        throw new LightpandaPageError("Lightpanda returned an invalid result");
      }
      return { url: finalUrl, status, html };
    } catch (error) {
      if (signal.aborted) throw signal.reason ?? error;
      throw error;
    } finally {
      stopListening();
      signal.removeEventListener("abort", abort);
      if (!signal.aborted) {
        if (targetId)
          await connection.send("Target.closeTarget", { targetId }).catch(() => undefined);
        if (browserContextId)
          await connection
            .send("Target.disposeBrowserContext", { browserContextId })
            .catch(() => undefined);
      }
      // Recycle periodically so memory a long-lived browser accumulates is returned.
      if (++this.renders >= this.maxRendersPerServer) this.restart();
    }
  }

  close(): void {
    this.restart();
  }

  private connect(): Promise<CdpConnection> {
    this.connection ??= this.launch().catch((cause: unknown) => {
      this.connection = undefined;
      throw new LightpandaServerUnavailableError("Lightpanda server failed to start", { cause });
    });
    return this.connection;
  }

  private restart(): void {
    const connection = this.connection;
    this.connection = undefined;
    this.renders = 0;
    void connection?.then((open) => open.close()).catch(() => undefined);
  }
}

async function evaluate(connection: CdpConnection, sessionId: string, expression: string) {
  const { result } = (await connection.send(
    "Runtime.evaluate",
    { expression, returnByValue: true },
    sessionId,
  )) as { result?: { value?: unknown } };
  return result?.value;
}

async function waitUpTo(
  work: Promise<void>,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<void> {
  if (timeoutMs <= 0 || signal.aborted) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort = () => {};
  try {
    await Promise.race([
      work,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
        onAbort = resolve;
        signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  }
}

/** Starts `lightpanda serve` on a free loopback port and connects to it. */
export function launchLightpandaServer(executable: string, flags: string[]): LaunchLightpanda {
  return async () => {
    const port = freeLoopbackPort();
    const child = Bun.spawn(
      [executable, "serve", "--host", "127.0.0.1", "--port", String(port), ...flags],
      { stdout: "ignore", stderr: "ignore" },
    );
    // Child processes outlive their parent unless killed; never leave a browser behind.
    const killChild = () => child.kill();
    process.once("exit", killChild);
    try {
      await waitForServer(port, child.exited);
      return await connectCdp(`ws://127.0.0.1:${port}/`, () => {
        process.off("exit", killChild);
        child.kill();
      });
    } catch (error) {
      process.off("exit", killChild);
      child.kill();
      throw error;
    }
  };
}

function freeLoopbackPort(): number {
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const { port } = listener;
  listener.stop(true);
  return port;
}

async function waitForServer(port: number, exited: Promise<number>): Promise<void> {
  let stopped = false;
  void exited.then(() => (stopped = true));
  for (let attempt = 0; attempt < 100; attempt++) {
    if (stopped) throw new Error("Lightpanda server exited during startup");
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      await response.body?.cancel();
      if (response.ok) return;
    } catch {
      /* not listening yet */
    }
    await Bun.sleep(50);
  }
  throw new Error("Lightpanda server did not start within 5s");
}

function connectCdp(url: string, onClose: () => void): Promise<CdpConnection> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const pending = new Map<
      number,
      { resolve(value: Record<string, unknown>): void; reject(error: Error): void }
    >();
    const listeners = new Set<(event: CdpNotification) => void>();
    let nextId = 1;
    let closed = false;

    const shutdown = () => {
      if (closed) return;
      closed = true;
      for (const request of pending.values())
        request.reject(new Error("Lightpanda connection closed"));
      pending.clear();
      onClose();
    };

    socket.onmessage = (message) => {
      const data = JSON.parse(String(message.data)) as {
        id?: number;
        result?: Record<string, unknown>;
        error?: { message?: string };
      } & Partial<CdpNotification>;
      if (data.id !== undefined) {
        const request = pending.get(data.id);
        pending.delete(data.id);
        if (data.error) request?.reject(new Error(data.error.message ?? "CDP command failed"));
        else request?.resolve(data.result ?? {});
      } else if (data.method) {
        const event = { method: data.method, params: data.params ?? {}, sessionId: data.sessionId };
        for (const listener of listeners) listener(event);
      }
    };
    socket.onclose = shutdown;
    socket.onerror = () => {
      if (socket.readyState !== WebSocket.OPEN)
        reject(new Error("Could not connect to Lightpanda"));
      shutdown();
    };
    socket.onopen = () =>
      resolve({
        send(method, params = {}, sessionId) {
          if (closed) return Promise.reject(new Error("Lightpanda connection closed"));
          const id = nextId++;
          return new Promise((resolveSend, rejectSend) => {
            pending.set(id, { resolve: resolveSend, reject: rejectSend });
            socket.send(
              JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }),
            );
          });
        },
        onEvent(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        close() {
          socket.close();
          shutdown();
        },
      });
  });
}
