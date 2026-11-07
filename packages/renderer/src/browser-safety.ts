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
  resourceType?: string;
  frameId?: string;
}

export interface BrowserNetworkGuard {
  settled(maxWaitMs?: number): Promise<void>;
  throwIfBlocked(): void;
  blockedSubrequests(): number;
  close(): void;
}

// Lets each browser request through only after its URL and DNS answers pass SSRF validation.
export async function installBrowserNetworkGuard(
  view: CdpView,
  signal: AbortSignal,
  options: BrowserNetworkSafetyOptions = {},
): Promise<BrowserNetworkGuard> {
  let blocked: unknown;
  let blockedSubrequests = 0;
  let mainFrameId: string | undefined;
  const pending = new Set<Promise<void>>();
  let commands = Promise.resolve<unknown>(undefined);
  const validate = createConcurrencyLimiter(options.maxConcurrentValidations ?? 8);

  // Commands are serialized; a failed one must not block those queued after it.
  const command = (method: string, params?: Record<string, unknown>) => {
    const next = commands.then(() => view.cdp(method, params));
    commands = next.catch(() => undefined);
    return next;
  };

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
        // Every unsafe request is failed, but only a blocked top-level navigation fails the render;
        // a blocked image, script or iframe just leaves that resource missing from the page.
        if (signal.aborted || isTopLevelNavigation(paused, mainFrameId)) blocked ??= error;
        else blockedSubrequests += 1;
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
  // The main frame keeps its id across navigations. Without it every Document request is treated
  // as a top-level navigation, so a lookup failure only makes the guard stricter.
  mainFrameId = await command("Page.getFrameTree").then(readMainFrameId, () => undefined);

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
    blockedSubrequests() {
      return blockedSubrequests;
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

// Bounds how many DNS validations run at once.
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
  const candidate = value as {
    requestId?: unknown;
    request?: { url?: unknown };
    resourceType?: unknown;
    frameId?: unknown;
  };
  if (typeof candidate.requestId !== "string" || typeof candidate.request?.url !== "string") {
    return;
  }
  return {
    requestId: candidate.requestId,
    request: { url: candidate.request.url },
    ...(typeof candidate.resourceType === "string" ? { resourceType: candidate.resourceType } : {}),
    ...(typeof candidate.frameId === "string" ? { frameId: candidate.frameId } : {}),
  };
}

// isTopLevelNavigation fails closed: a request with no resource type, or a Document whose frame
// cannot be told apart from the main frame, counts as the page navigation.
function isTopLevelNavigation(paused: PausedRequest, mainFrameId: string | undefined): boolean {
  if (paused.resourceType === undefined) return true;
  if (paused.resourceType !== "Document") return false;
  return (
    mainFrameId === undefined || paused.frameId === undefined || paused.frameId === mainFrameId
  );
}

function readMainFrameId(value: unknown): string | undefined {
  const id = (value as { frameTree?: { frame?: { id?: unknown } } } | undefined)?.frameTree?.frame
    ?.id;
  return typeof id === "string" ? id : undefined;
}

function isLocalDocumentUrl(value: string): boolean {
  try {
    return ["about:", "blob:", "data:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}
