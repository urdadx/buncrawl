import { describe, expect, test } from "bun:test";

import { runExtractJob, type ExtractJob } from "../src/job";
import { ExtractionError, ExtractionPool, type ExtractWorkerLike } from "../src/pool";

const job = (html = "<main><h1>Title</h1><p>Body text.</p></main>"): ExtractJob => ({
  html,
  baseUrl: "https://example.com/page",
  onlyMainContent: true,
});

/** A worker whose replies the test controls. */
class FakeWorker implements ExtractWorkerLike {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  received: Array<{ id: number; job: ExtractJob }> = [];
  terminated = false;

  postMessage(message: unknown) {
    this.received.push(message as { id: number; job: ExtractJob });
  }
  terminate() {
    this.terminated = true;
  }
  /** Answers the oldest unanswered message by running the real extraction. */
  answer() {
    const message = this.received.shift()!;
    this.onmessage?.({
      data: { id: message.id, output: runExtractJob(message.job) },
    } as MessageEvent);
  }
  fail(text: string) {
    const message = this.received.shift()!;
    this.onmessage?.({ data: { id: message.id, error: text } } as MessageEvent);
  }
  crash() {
    this.onerror?.({ message: "boom", error: new Error("boom") } as ErrorEvent);
  }
}

function fakePool(size: number) {
  const workers: FakeWorker[] = [];
  const pool = new ExtractionPool({
    size,
    createWorker: () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    },
  });
  return { pool, workers };
}

const settled = () => Bun.sleep(0);

describe("ExtractionPool with real workers", () => {
  test("returns exactly what inline extraction returns", async () => {
    const pool = new ExtractionPool({ size: 2 });
    try {
      const input = {
        ...job(
          `<html><head><title>T</title></head><body><main><h1>Doc</h1><p>${"Text. ".repeat(80)}</p><a href="/next">Next</a></main></body></html>`,
        ),
        includeRawHtml: true,
      };
      expect(await pool.run(input)).toEqual(runExtractJob(input));
      expect((await pool.run(job())).rawHtml).toBeUndefined();
    } finally {
      pool.close();
    }
  });

  test("keeps the event loop responsive during a large extraction", async () => {
    const pool = new ExtractionPool({ size: 1 });
    const html = `<main>${"<section><h2>Part</h2><p>Long paragraph with <a href='/x'>a link</a>.</p><ul><li>a</li><li>b</li></ul></section>".repeat(4000)}</main>`;
    try {
      await pool.run(job("<p>warm up</p>"));
      let last = performance.now();
      let maxGap = 0;
      const timer = setInterval(() => {
        maxGap = Math.max(maxGap, performance.now() - last);
        last = performance.now();
      }, 5);
      const startedAt = performance.now();
      await pool.run(job(html));
      const elapsed = performance.now() - startedAt;
      clearInterval(timer);
      // The extraction itself takes far longer than any gap the timer observed.
      expect(elapsed).toBeGreaterThan(150);
      expect(maxGap).toBeLessThan(100);
    } finally {
      pool.close();
    }
  });
});

describe("ExtractionPool scheduling and failures", () => {
  test("never runs more jobs at once than its size and drains the queue", async () => {
    const { pool, workers } = fakePool(2);
    const results = Array.from({ length: 5 }, () => pool.run(job()));
    expect(workers).toHaveLength(2);
    expect(workers.map((worker) => worker.received.length)).toEqual([1, 1]);
    for (let i = 0; i < 5; i++) {
      const busy = workers.find((worker) => worker.received.length > 0)!;
      busy.answer();
      await settled();
    }
    expect(
      (await Promise.all(results)).every((output) => output.extracted.markdown.includes("Title")),
    ).toBe(true);
    expect(workers).toHaveLength(2);
  });

  test("aborting a running job terminates its worker and the next job gets a fresh one", async () => {
    const { pool, workers } = fakePool(1);
    const controller = new AbortController();
    const running = pool.run(job(), controller.signal);
    controller.abort(new Error("deadline"));
    await expect(running).rejects.toThrow("deadline");
    expect(workers[0]!.terminated).toBe(true);

    const next = pool.run(job());
    expect(workers).toHaveLength(2);
    workers[1]!.answer();
    expect((await next).extracted.markdown).toContain("Title");
  });

  test("aborting a queued job removes it without touching the running one", async () => {
    const { pool, workers } = fakePool(1);
    const first = pool.run(job());
    const controller = new AbortController();
    const queued = pool.run(job(), controller.signal);
    controller.abort(new Error("cancelled"));
    await expect(queued).rejects.toThrow("cancelled");
    workers[0]!.answer();
    await first;
    expect(workers[0]!.terminated).toBe(false);
    expect(workers[0]!.received).toHaveLength(0);
  });

  test("an extraction error fails only that job and keeps the worker", async () => {
    const { pool, workers } = fakePool(1);
    const failing = pool.run(job());
    workers[0]!.fail("bad html");
    await expect(failing).rejects.toBeInstanceOf(ExtractionError);
    const next = pool.run(job());
    workers[0]!.answer();
    await next;
    expect(workers).toHaveLength(1);
  });

  test("a worker that crashes mid-job fails that job and is replaced", async () => {
    const { pool, workers } = fakePool(1);
    const warm = pool.run(job());
    workers[0]!.answer();
    await warm;
    const crashing = pool.run(job());
    workers[0]!.crash();
    await expect(crashing).rejects.toBeInstanceOf(ExtractionError);
    const next = pool.run(job());
    expect(workers).toHaveLength(2);
    workers[1]!.answer();
    await next;
  });

  test("falls back to inline extraction when workers cannot start", async () => {
    const { pool, workers } = fakePool(2);
    const pending = pool.run(job());
    workers[0]!.crash(); // fails before ever answering, like a missing worker file
    expect((await pending).extracted.markdown).toContain("Title");
    const later = await pool.run(job());
    expect(later.extracted.markdown).toContain("Title");
    expect(workers).toHaveLength(1);

    const throwing = new ExtractionPool({
      createWorker: () => {
        throw new Error("Worker is not supported");
      },
    });
    expect((await throwing.run(job())).extracted.markdown).toContain("Title");
  });
});
