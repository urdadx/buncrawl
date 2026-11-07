import { runExtractJob, type ExtractJob, type ExtractJobOutput, type ExtractJobReply } from "./job";

export type { ExtractJob, ExtractJobOutput } from "./job";

/** The subset of the Worker API the pool relies on, so tests can substitute a fake. */
export interface ExtractWorkerLike {
  postMessage(message: unknown): void;
  terminate(): void;
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  unref?(): void;
}

export interface ExtractionPoolOptions {
  /** Maximum concurrent workers; defaults to one less than the CPU count, capped at 4. */
  size?: number;
  createWorker?: () => ExtractWorkerLike;
}

export class ExtractionError extends Error {
  readonly code = "EXTRACTION_FAILED";
}

interface PendingJob {
  id: number;
  job: ExtractJob;
  resolve(output: ExtractJobOutput): void;
  reject(reason: unknown): void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

interface Slot {
  worker: ExtractWorkerLike;
  /** Set once the worker has answered a job, i.e. it demonstrably started. */
  ready: boolean;
  current?: PendingJob;
}

/**
 * Runs extraction on worker threads so parsing a large page never stalls the event loop. A job
 * whose signal aborts terminates its worker, which also stops runaway parses. If workers cannot
 * start at all (e.g. the worker file is missing from a bundle), the pool degrades to running
 * extraction inline rather than failing scrapes.
 */
export class ExtractionPool {
  private readonly size: number;
  private readonly slots: Slot[] = [];
  private readonly queue: PendingJob[] = [];
  private nextId = 1;
  private closed = false;
  private inline = false;

  constructor(private readonly options: ExtractionPoolOptions = {}) {
    this.size = Math.max(1, Math.floor(options.size ?? defaultPoolSize()));
  }

  run(job: ExtractJob, signal?: AbortSignal): Promise<ExtractJobOutput> {
    if (this.closed) return Promise.reject(new Error("Extraction pool is closed"));
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (this.inline) return runInline(job);
    return new Promise((resolve, reject) => {
      const pending: PendingJob = { id: this.nextId++, job, resolve, reject, signal };
      if (signal) {
        pending.onAbort = () => this.abort(pending);
        signal.addEventListener("abort", pending.onAbort, { once: true });
      }
      this.queue.push(pending);
      this.drain();
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const reason = new Error("Extraction pool is closed");
    for (const pending of this.queue.splice(0)) this.fail(pending, reason);
    for (const slot of this.slots.splice(0)) {
      slot.worker.terminate();
      if (slot.current) this.fail(slot.current, reason);
    }
  }

  private drain(): void {
    while (this.queue.length > 0 && !this.closed) {
      if (this.inline) {
        for (const pending of this.queue.splice(0)) this.settle(pending, runInline(pending.job));
        return;
      }
      let slot = this.slots.find((candidate) => !candidate.current);
      if (!slot) {
        if (this.slots.length >= this.size) return;
        slot = this.spawn();
        if (!slot) continue;
      }
      const pending = this.queue.shift()!;
      slot.current = pending;
      slot.worker.postMessage({ id: pending.id, job: pending.job });
    }
  }

  private spawn(): Slot | undefined {
    let worker: ExtractWorkerLike;
    try {
      worker = (this.options.createWorker ?? createBunWorker)();
    } catch (error) {
      this.degrade(error);
      return;
    }
    worker.unref?.();
    const slot: Slot = { worker, ready: false };
    worker.onmessage = (event) => {
      const reply = event.data as ExtractJobReply;
      const pending = slot.current;
      if (!pending || pending.id !== reply.id) return;
      slot.ready = true;
      slot.current = undefined;
      this.settle(
        pending,
        "error" in reply
          ? Promise.reject(new ExtractionError(reply.error))
          : Promise.resolve(reply.output),
      );
      this.drain();
    };
    worker.onerror = (event) => {
      if (!slot.ready) {
        // Never answered anything: treat as an environment that cannot run workers.
        this.remove(slot);
        if (slot.current) this.queue.unshift(slot.current);
        slot.current = undefined;
        this.degrade(event.error ?? event.message);
        this.drain();
        return;
      }
      this.replace(slot, new ExtractionError(`Extraction worker crashed: ${event.message}`));
    };
    this.slots.push(slot);
    return slot;
  }

  /** Terminates a slot's worker and fails its job; the next drain spawns a fresh worker. */
  private replace(slot: Slot, reason: unknown): void {
    this.remove(slot);
    const pending = slot.current;
    slot.current = undefined;
    if (pending) this.fail(pending, reason);
    this.drain();
  }

  private remove(slot: Slot): void {
    const index = this.slots.indexOf(slot);
    if (index !== -1) this.slots.splice(index, 1);
    slot.worker.terminate();
  }

  private abort(pending: PendingJob): void {
    const reason = pending.signal?.reason ?? new Error("Extraction aborted");
    const queued = this.queue.indexOf(pending);
    if (queued !== -1) {
      this.queue.splice(queued, 1);
      this.fail(pending, reason);
      return;
    }
    const slot = this.slots.find((candidate) => candidate.current === pending);
    if (slot) this.replace(slot, reason);
  }

  private degrade(cause: unknown): void {
    if (this.inline) return;
    this.inline = true;
    console.warn("Extraction workers are unavailable; extracting on the main thread", cause);
  }

  private settle(pending: PendingJob, result: Promise<ExtractJobOutput>): void {
    if (pending.onAbort) pending.signal?.removeEventListener("abort", pending.onAbort);
    result.then(pending.resolve, pending.reject);
  }

  private fail(pending: PendingJob, reason: unknown): void {
    this.settle(pending, Promise.reject(reason));
  }
}

function runInline(job: ExtractJob): Promise<ExtractJobOutput> {
  try {
    return Promise.resolve(runExtractJob(job));
  } catch (error) {
    return Promise.reject(
      new ExtractionError(error instanceof Error ? error.message : "Extraction failed"),
    );
  }
}

function createBunWorker(): ExtractWorkerLike {
  const file = import.meta.url.endsWith(".ts") ? "extract-worker.ts" : "extract-worker.mjs";
  return new Worker(new URL(file, import.meta.url).href) as unknown as ExtractWorkerLike;
}

function defaultPoolSize(): number {
  return Math.min(4, Math.max(1, (navigator.hardwareConcurrency ?? 2) - 1));
}

let defaultPool: ExtractionPool | undefined;

/** Extracts a document on the shared worker pool. */
export function extractInBackground(
  job: ExtractJob,
  signal?: AbortSignal,
): Promise<ExtractJobOutput> {
  defaultPool ??= new ExtractionPool();
  return defaultPool.run(job, signal);
}
