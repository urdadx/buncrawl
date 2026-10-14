import { type DnsResolver, UrlSafetyError, validateResolvedUrl } from "@buncrawl/security";

export interface CdpEvent {
  data?: unknown;
}

export interface CdpView {
  cdp(method: string, params?: Record<string, unknown>): Promise<unknown>;
  addEventListener(type: string, listener: (event: CdpEvent) => void): void;
  removeEventListener(type: string, listener: (event: CdpEvent) => void): void;
}

export interface BrowserNetworkSafetyOptions {
  resolver?: DnsResolver;
  dnsTimeoutMs?: number;
  maxConcurrentValidations?: number;
}

interface PausedRequest {
  requestId: string;
  request: { url: string };
}

export interface BrowserNetworkGuard {
  settled(maxWaitMs?: number): Promise<void>;
  throwIfBlocked(): void;
  close(): void;
}

// installBrowserNetworkGuard sets up a network guard for a browser view using the Chrome DevTools Protocol (CDP). It intercepts network requests and checks if they are safe to proceed based on the provided resolver and DNS timeout. If a request is blocked, it fails the request with a BlockedByClient error. The function returns an object with methods to wait for all requests to settle, throw an error if any request was blocked, and close the guard by removing the event listener.
export async function installBrowserNetworkGuard(
  view: CdpView,
  signal: AbortSignal,
  options: BrowserNetworkSafetyOptions = {},
): Promise<BrowserNetworkGuard> {
  let blocked: unknown;
  const pending = new Set<Promise<void>>();
  let commands = Promise.resolve<unknown>(undefined);
  const validate = createConcurrencyLimiter(options.maxConcurrentValidations ?? 8);

  // command queues up a CDP command to be sent to the browser view. It ensures that commands are sent in order and that any errors are caught and ignored, so that subsequent commands can still be sent. It returns a promise that resolves with the result of the command.
  const command = (method: string, params?: Record<string, unknown>) => {
    const next = commands.then(() => view.cdp(method, params));
    commands = next.catch(() => undefined);
    return next;
  };

  // listener handles the Fetch.requestPaused event from the browser view. It checks if the request is a local document URL or if it is safe to resolve the URL using the provided resolver (dns, ip etc). If the request is blocked, it fails the request with a BlockedByClient error. Otherwise, it continues the request. It ensures that requests are processed in order and that any errors are caught and stored in the blocked variable.
  const listener = (event: CdpEvent) => {
    const paused = parsePausedRequest(event.data);
    if (!paused) return;
    const work = validate(async () => {
      try {
        if (signal.aborted) throw signal.reason ?? new Error("Render aborted");
        if (isLocalDocumentUrl(paused.request.url)) {
          await command("Fetch.continueRequest", { requestId: paused.requestId });
          return;
        }
        await validateResolvedUrl(paused.request.url, {
          resolver: options.resolver,
          dnsTimeoutMs: options.dnsTimeoutMs,
          signal,
        });
        await command("Fetch.continueRequest", { requestId: paused.requestId });
      } catch (error) {
        blocked ??= error;
        await command("Fetch.failRequest", {
          requestId: paused.requestId,
          errorReason: "BlockedByClient",
        }).catch(() => undefined);
      }
    });
    pending.add(work);
    void work.finally(() => pending.delete(work));
  };

  view.addEventListener("Fetch.requestPaused", listener);
  try {
    await command("Fetch.enable", {
      patterns: [{ urlPattern: "*", requestStage: "Request" }],
    });
  } catch (cause) {
    view.removeEventListener("Fetch.requestPaused", listener);
    throw new UrlSafetyError(
      "BLOCKED_DESTINATION",
      "Chromium request interception is unavailable; browser navigation was blocked",
      { cause },
    );
  }

  return {
    async settled(maxWaitMs = 1000) {
      const expiresAt = performance.now() + Math.max(0, maxWaitMs);
      while (pending.size > 0 && performance.now() < expiresAt) {
        await waitUpTo(Promise.all(pending), expiresAt - performance.now());
      }
      await waitUpTo(commands, expiresAt - performance.now());
    },
    throwIfBlocked() {
      if (blocked) throw blocked;
    },
    close() {
      view.removeEventListener("Fetch.requestPaused", listener);
    },
  };
}

async function waitUpTo(work: Promise<unknown>, timeoutMs: number): Promise<void> {
  if (timeoutMs <= 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      work,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// this is a simple concurrency limiter that allows a limited number of tasks to run concurrently. It maintains a count of active tasks and a queue of waiting tasks. When the number of active tasks reaches the limit, new tasks are added to the waiting queue and will only be executed when an active task completes. This ensures that no more than the specified limit of tasks are running at any given time.
function createConcurrencyLimiter(limit: number) {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new TypeError("maxConcurrentValidations must be a positive integer");
  }

  let active = 0;
  const waiting: Array<() => void> = [];
  return async function run(task: () => Promise<void>): Promise<void> {
    if (active >= limit) await new Promise<void>((resolve) => waiting.push(resolve));
    active += 1;
    try {
      await task();
    } finally {
      active -= 1;
      waiting.shift()?.();
    }
  };
}

function parsePausedRequest(value: unknown): PausedRequest | undefined {
  if (typeof value !== "object" || value === null) return;
  const candidate = value as { requestId?: unknown; request?: { url?: unknown } };
  if (typeof candidate.requestId !== "string" || typeof candidate.request?.url !== "string") {
    return;
  }
  return {
    requestId: candidate.requestId,
    request: { url: candidate.request.url },
  };
}

function isLocalDocumentUrl(value: string): boolean {
  try {
    return ["about:", "blob:", "data:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}
