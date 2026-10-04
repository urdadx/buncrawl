import { LightpandaRenderer, type LightpandaRendererOptions } from "./lightpanda";
import type { RenderRequest, Renderer, RendererCapabilities, RenderResult } from "./renderer";
import { WebViewRenderer, type WebViewRendererOptions } from "./webview";

const DEFAULT_MAX_WORKERS = 2;
const DEFAULT_MAX_QUEUE = 32;
const DEFAULT_MAX_PAGES_PER_WORKER = 100;
const DEFAULT_MAX_RSS_BYTES = 512 * 1024 * 1024;

export type IsolatedRendererConfig =
  | {
      type: "lightpanda";
      options?: Pick<LightpandaRendererOptions, "executable" | "waitMs" | "proxyUrl">;
    }
  | {
      type: "webview";
      options?: Omit<WebViewRendererOptions, "factory" | "networkSafety">;
    };

export interface WorkerRenderRequest {
  url: string;
  timeoutMs: number;
  waitForMs?: number;
  screenshot?: boolean;
  viewport?: RenderRequest["viewport"];
}

export interface WorkerRenderResult {
  result: RenderResult;
  rssBytes: number;
}

export interface RendererWorker {
  render(request: WorkerRenderRequest, signal: AbortSignal): Promise<WorkerRenderResult>;
  close(): void;
}

export type RendererWorkerFactory = (config: IsolatedRendererConfig) => RendererWorker;

export interface IsolatedRendererOptions {
  maxWorkers?: number;
  maxQueue?: number;
  maxPagesPerWorker?: number;
  maxRssBytes?: number;
  retryCrashes?: number;
  workerFactory?: RendererWorkerFactory;
}

export type IsolatedRendererErrorCode = "RENDERER_QUEUE_FULL" | "RENDERER_WORKER_CRASHED";

export class IsolatedRendererError extends Error {
  constructor(
    readonly code: IsolatedRendererErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "IsolatedRendererError";
  }
}

interface PoolWorker {
  client: RendererWorker;
  busy: boolean;
  pages: number;
}

interface RenderJob {
  request: RenderRequest;
  attempts: number;
  resolve(result: RenderResult): void;
  reject(error: unknown): void;
  abort(): void;
}

export class IsolatedRenderer implements Renderer {
  readonly name: string;

  private readonly maxWorkers: number;
  private readonly maxQueue: number;
  private readonly maxPagesPerWorker: number;
  private readonly maxRssBytes: number;
  private readonly retryCrashes: number;
  private readonly workerFactory: RendererWorkerFactory;
  private readonly workers: PoolWorker[] = [];
  private readonly queue: RenderJob[] = [];
  private closed = false;

  constructor(
    private readonly config: IsolatedRendererConfig,
    private readonly rendererCapabilities: RendererCapabilities,
    options: IsolatedRendererOptions = {},
  ) {
    this.name = `isolated-${config.type}`;
    this.maxWorkers = positiveInteger(options.maxWorkers ?? DEFAULT_MAX_WORKERS, "maxWorkers");
    this.maxQueue = nonNegativeInteger(options.maxQueue ?? DEFAULT_MAX_QUEUE, "maxQueue");
    this.maxPagesPerWorker = positiveInteger(
      options.maxPagesPerWorker ?? DEFAULT_MAX_PAGES_PER_WORKER,
      "maxPagesPerWorker",
    );
    this.maxRssBytes = positiveInteger(options.maxRssBytes ?? DEFAULT_MAX_RSS_BYTES, "maxRssBytes");
    this.retryCrashes = nonNegativeInteger(options.retryCrashes ?? 1, "retryCrashes");
    this.workerFactory = options.workerFactory ?? createBunRendererWorker;
  }

  capabilities(): RendererCapabilities {
    return this.rendererCapabilities;
  }

  // render sends a render request to the renderer pool and returns a promise that resolves with the render result. It checks if the renderer is closed, if the request's deadline has expired or been aborted, and if there is capacity in the queue. If any of these conditions are not met, it rejects the promise with an appropriate error. Otherwise, it creates a new job for the request, adds it to the queue, and calls the drain method to process the queue.
  render(request: RenderRequest): Promise<RenderResult> {
    if (this.closed) return Promise.reject(new Error("Renderer pool is closed"));
    if (request.deadline.signal.aborted || request.deadline.expired) {
      return Promise.reject(request.deadline.signal.reason ?? new Error("Render deadline expired"));
    }

    const hasCapacity =
      this.workers.some((worker) => !worker.busy) || this.workers.length < this.maxWorkers;
    if (!hasCapacity && this.queue.length >= this.maxQueue) {
      return Promise.reject(
        new IsolatedRendererError("RENDERER_QUEUE_FULL", "Browser render queue is full"),
      );
    }

    return new Promise((resolve, reject) => {
      const job: RenderJob = {
        request,
        attempts: 0,
        resolve,
        reject,
        abort: () => {
          const index = this.queue.indexOf(job);
          if (index !== -1) this.queue.splice(index, 1);
          reject(request.deadline.signal.reason ?? new Error("Render aborted"));
        },
      };
      request.deadline.signal.addEventListener("abort", job.abort, { once: true });
      this.queue.push(job);
      this.drain();
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const job of this.queue.splice(0)) {
      job.request.deadline.signal.removeEventListener("abort", job.abort);
      job.reject(new Error("Renderer pool is closed"));
    }
    for (const worker of this.workers.splice(0)) worker.client.close();
  }

  // drain manages the queue of render jobs and assigns them to available workers. It checks if there are any available workers or if new workers can be created based on the maximum worker limit. If a worker is available, it takes the next job from the queue and runs it using the `run` method. If a job's deadline has expired or been aborted, it rejects the job immediately. The method continues to process jobs until there are no more jobs in the queue or no available workers.
  private drain(): void {
    if (this.closed) return;
    while (this.queue.length > 0) {
      let worker = this.workers.find((candidate) => !candidate.busy);
      if (!worker) {
        if (this.workers.length >= this.maxWorkers) return;
        worker = { client: this.workerFactory(this.config), busy: false, pages: 0 };
        this.workers.push(worker);
      }

      const job = this.queue.shift();
      if (!job) return;
      job.request.deadline.signal.removeEventListener("abort", job.abort);
      if (job.request.deadline.signal.aborted || job.request.deadline.expired) {
        job.reject(job.request.deadline.signal.reason ?? new Error("Render deadline expired"));
        continue;
      }
      worker.busy = true;
      void this.run(worker, job);
    }
  }

  // run sends a render request to the browser worker and handles the response. It calls the `render` method of the worker with the request and waits for the result. If the render is successful, it resolves the job's promise with the result. If the worker has reached its maximum page limit or RSS memory usage, it removes the worker from the pool. If an error occurs during rendering, it checks if the error is retryable and if the job can be retried based on the maximum retry limit. If so, it re-queues the job; otherwise, it rejects the job's promise with the error. Finally, it marks the worker as not busy and calls `drain` to process any remaining jobs in the queue.
  private async run(worker: PoolWorker, job: RenderJob): Promise<void> {
    try {
      const output = await worker.client.render(
        {
          url: job.request.url,
          timeoutMs: Math.max(1, Math.floor(job.request.deadline.remainingMs)),
          ...(job.request.waitForMs === undefined ? {} : { waitForMs: job.request.waitForMs }),
          ...(job.request.screenshot === undefined ? {} : { screenshot: job.request.screenshot }),
          ...(job.request.viewport === undefined ? {} : { viewport: job.request.viewport }),
        },
        job.request.deadline.signal,
      );
      worker.pages += 1;
      job.resolve(output.result);
      if (worker.pages >= this.maxPagesPerWorker || output.rssBytes >= this.maxRssBytes) {
        this.removeWorker(worker);
      }
    } catch (error) {
      this.removeWorker(worker);
      if (
        isRetryableBrowserCrash(error) &&
        job.attempts < this.retryCrashes &&
        !this.closed &&
        !job.request.deadline.signal.aborted &&
        !job.request.deadline.expired
      ) {
        job.attempts += 1;
        this.queue.unshift(job);
      } else {
        job.reject(error);
      }
    } finally {
      worker.busy = false;
      this.drain();
    }
  }

  private removeWorker(worker: PoolWorker): void {
    const index = this.workers.indexOf(worker);
    if (index !== -1) this.workers.splice(index, 1);
    worker.client.close();
  }
}

export function createIsolatedDefaultRenderer(
  options: IsolatedRendererOptions = {},
): IsolatedRenderer {
  const proxyUrl = process.env.BUNCRAWL_PROXY_URL;
  const lightpanda = new LightpandaRenderer(proxyUrl ? { proxyUrl } : {});
  if (lightpanda.capabilities().available) {
    return new IsolatedRenderer(
      { type: "lightpanda", ...(proxyUrl ? { options: { proxyUrl } } : {}) },
      lightpanda.capabilities(),
      options,
    );
  }

  const chrome = proxyUrl ? { proxyUrl } : undefined;
  const safeWebview = new WebViewRenderer({ backend: "chrome" });
  return new IsolatedRenderer(
    {
      type: "webview",
      options: { backend: "chrome", ...(chrome ? { chrome } : {}) },
    },
    safeWebview.capabilities(),
    options,
  );
}

interface WorkerResponse {
  id: number;
  result?: RenderResult;
  rssBytes?: number;
  error?: { message: string; code?: string };
}

class BunRendererWorker implements RendererWorker {
  private readonly process: ReturnType<typeof Bun.spawn>;
  private nextId = 1;
  private pending?: {
    id: number;
    resolve(value: WorkerRenderResult): void;
    reject(error: unknown): void;
    abort(): void;
    signal: AbortSignal;
  };
  private closed = false;

  constructor(config: IsolatedRendererConfig) {
    const workerFile = import.meta.url.endsWith(".ts") ? "renderer-worker.ts" : "renderer-worker.mjs";
    this.process = Bun.spawn(
      [process.execPath, new URL(workerFile, import.meta.url).pathname],
      {
        ipc: (message) => this.onMessage(message),
        env: { ...process.env, BUNCRAWL_RENDERER_CONFIG: JSON.stringify(config) },
        stdout: "ignore",
        stderr: "inherit",
      },
    );
    void this.process.exited.then((exitCode) => {
      if (this.closed || !this.pending) return;
      const pending = this.pending;
      this.pending = undefined;
      pending.signal.removeEventListener("abort", pending.abort);
      pending.reject(
        new IsolatedRendererError(
          "RENDERER_WORKER_CRASHED",
          `Browser worker exited with code ${exitCode}`,
        ),
      );
    });
  }

  // render sends a render request to the browser worker process and returns a promise that resolves with the render result. It checks if the worker is closed or busy, and if so, it rejects the promise. Otherwise, it creates a new promise and sets up an abort handler for the request's signal. It sends the request to the worker process via IPC and handles any errors that may occur during this process. If the worker responds with a result or an error, it resolves or rejects the promise accordingly.
  render(request: WorkerRenderRequest, signal: AbortSignal): Promise<WorkerRenderResult> {
    if (this.closed) return Promise.reject(new Error("Browser worker is closed"));
    if (this.pending) return Promise.reject(new Error("Browser worker is already busy"));

    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const abort = () => {
        this.pending = undefined;
        this.closed = true;
        signal.removeEventListener("abort", abort);
        this.process.kill();
        reject(signal.reason ?? new Error("Render aborted"));
      };
      this.pending = { id, resolve, reject, abort, signal };
      signal.addEventListener("abort", abort, { once: true });
      try {
        this.process.send({ id, request });
      } catch (cause) {
        this.pending = undefined;
        signal.removeEventListener("abort", abort);
        reject(
          new IsolatedRendererError(
            "RENDERER_WORKER_CRASHED",
            "Failed to send work to the browser worker",
            { cause },
          ),
        );
      }
    });
  }

  // close terminates the browser worker process and cleans up any pending render requests. If the worker is already closed, it does nothing. If there is a pending render request, it removes the abort event listener and rejects the promise with an error indicating that the worker was terminated. Finally, it kills the worker process.
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.pending) {
      this.pending.signal.removeEventListener("abort", this.pending.abort);
      this.pending.reject(
        new IsolatedRendererError("RENDERER_WORKER_CRASHED", "Browser worker was terminated"),
      );
      this.pending = undefined;
    }
    this.process.kill();
  }

  // onMessage handles messages received from the browser worker process. It checks if the message is a valid worker response and if it matches the pending render request. If the message contains an error, it creates a new error object and rejects the pending promise. If the message contains a valid result, it resolves the pending promise with the render result and RSS bytes. If the message is invalid or does not match the pending request, it ignores it.
  private onMessage(message: unknown): void {
    if (!isWorkerResponse(message) || !this.pending || message.id !== this.pending.id) return;
    const pending = this.pending;
    this.pending = undefined;
    pending.signal.removeEventListener("abort", pending.abort);
    if (message.error) {
      const error = new Error(message.error.message) as Error & { code?: string };
      error.code = message.error.code;
      pending.reject(error);
      return;
    }
    if (!message.result || typeof message.rssBytes !== "number") {
      pending.reject(new Error("Browser worker returned an invalid response"));
      return;
    }
    pending.resolve({ result: message.result, rssBytes: message.rssBytes });
  }
}

function createBunRendererWorker(config: IsolatedRendererConfig): RendererWorker {
  return new BunRendererWorker(config);
}

function isWorkerResponse(value: unknown): value is WorkerResponse {
  return (
    typeof value === "object" && value !== null && typeof (value as WorkerResponse).id === "number"
  );
}

function isRetryableBrowserCrash(error: unknown): boolean {
  if (error instanceof IsolatedRendererError) return error.code === "RENDERER_WORKER_CRASHED";
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  return ["WEBVIEW_UNAVAILABLE", "WEBVIEW_NAVIGATION_FAILED", "LIGHTPANDA_RENDER_FAILED"].includes(
    String(error.code),
  );
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0)
    throw new TypeError(`${name} must be a positive integer`);
  return value;
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative integer`);
  }
  return value;
}
