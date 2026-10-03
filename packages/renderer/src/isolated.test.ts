import { Deadline } from "@buncrawl/core";
import { describe, expect, test } from "bun:test";

import {
  IsolatedRenderer,
  IsolatedRendererError,
  type RendererWorker,
  type WorkerRenderRequest,
  type WorkerRenderResult,
} from "./isolated";

const capabilities = {
  available: true,
  browser: true,
  javascript: true,
  screenshots: true,
  cdp: false,
};

function output(url: string, rssBytes = 1024): WorkerRenderResult {
  return {
    result: {
      sourceUrl: url,
      finalUrl: url,
      title: "Rendered",
      html: "<html><body>Rendered</body></html>",
      renderer: "fake",
      elapsedMs: 1,
    },
    rssBytes,
  };
}

class FakeWorker implements RendererWorker {
  closed = false;

  constructor(
    private readonly perform: (
      request: WorkerRenderRequest,
      signal: AbortSignal,
    ) => Promise<WorkerRenderResult>,
  ) {}

  render(request: WorkerRenderRequest, signal: AbortSignal) {
    return this.perform(request, signal);
  }

  close() {
    this.closed = true;
  }
}

describe("IsolatedRenderer", () => {
  test("bounds concurrent workers and queued requests", async () => {
    let finishFirst: ((value: WorkerRenderResult) => void) | undefined;
    let calls = 0;
    const renderer = new IsolatedRenderer(
      { type: "lightpanda" },
      capabilities,
      {
        maxWorkers: 1,
        maxQueue: 1,
        workerFactory: () =>
          new FakeWorker((request) => {
            calls += 1;
            if (calls > 1) return Promise.resolve(output(request.url));
            return new Promise((resolve) => {
              finishFirst = resolve;
            });
          }),
      },
    );

    const first = renderer.render({ url: "https://example.com/1", deadline: new Deadline(2000) });
    const second = renderer.render({ url: "https://example.com/2", deadline: new Deadline(2000) });
    const third = renderer.render({ url: "https://example.com/3", deadline: new Deadline(2000) });

    await expect(third).rejects.toMatchObject({ code: "RENDERER_QUEUE_FULL" });
    expect(calls).toBe(1);
    finishFirst?.(output("https://example.com/1"));
    await expect(first).resolves.toMatchObject({ sourceUrl: "https://example.com/1" });
    await expect(second).resolves.toMatchObject({ sourceUrl: "https://example.com/2" });
    renderer.close();
  });

  test("recycles a worker after its page limit", async () => {
    const workers: FakeWorker[] = [];
    const renderer = new IsolatedRenderer(
      { type: "lightpanda" },
      capabilities,
      {
        maxPagesPerWorker: 1,
        workerFactory: () => {
          const worker = new FakeWorker(async (request) => output(request.url));
          workers.push(worker);
          return worker;
        },
      },
    );

    await renderer.render({ url: "https://example.com/1", deadline: new Deadline(1000) });
    await renderer.render({ url: "https://example.com/2", deadline: new Deadline(1000) });

    expect(workers).toHaveLength(2);
    expect(workers[0]?.closed).toBe(true);
    renderer.close();
  });

  test("recycles a worker after crossing the memory limit", async () => {
    const workers: FakeWorker[] = [];
    const renderer = new IsolatedRenderer(
      { type: "webview" },
      capabilities,
      {
        maxRssBytes: 100,
        workerFactory: () => {
          const worker = new FakeWorker(async (request) => output(request.url, 101));
          workers.push(worker);
          return worker;
        },
      },
    );

    await renderer.render({ url: "https://example.com/1", deadline: new Deadline(1000) });
    await renderer.render({ url: "https://example.com/2", deadline: new Deadline(1000) });

    expect(workers).toHaveLength(2);
    expect(workers[0]?.closed).toBe(true);
    renderer.close();
  });

  test("retries a crashed render in a fresh worker", async () => {
    let workersCreated = 0;
    const renderer = new IsolatedRenderer(
      { type: "webview" },
      capabilities,
      {
        retryCrashes: 1,
        workerFactory: () => {
          workersCreated += 1;
          const workerNumber = workersCreated;
          return new FakeWorker(async (request) => {
            if (workerNumber === 1) {
              throw new IsolatedRendererError(
                "RENDERER_WORKER_CRASHED",
                "worker crashed",
              );
            }
            return output(request.url);
          });
        },
      },
    );

    await expect(
      renderer.render({ url: "https://example.com", deadline: new Deadline(1000) }),
    ).resolves.toMatchObject({ renderer: "fake" });
    expect(workersCreated).toBe(2);
    renderer.close();
  });

  test("removes an aborted request from the queue", async () => {
    let finishFirst: ((value: WorkerRenderResult) => void) | undefined;
    const renderer = new IsolatedRenderer(
      { type: "lightpanda" },
      capabilities,
      {
        maxWorkers: 1,
        workerFactory: () =>
          new FakeWorker(
            (request) =>
              new Promise((resolve) => {
                if (!finishFirst) finishFirst = resolve;
                else resolve(output(request.url));
              }),
          ),
      },
    );
    const controller = new AbortController();
    const first = renderer.render({ url: "https://example.com/1", deadline: new Deadline(2000) });
    const queued = renderer.render({
      url: "https://example.com/2",
      deadline: new Deadline(2000, controller.signal),
    });

    controller.abort(new Error("client disconnected"));
    await expect(queued).rejects.toThrow("client disconnected");
    finishFirst?.(output("https://example.com/1"));
    await first;
    renderer.close();
  });

  test("terminates and recycles a worker when an active request is cancelled", async () => {
    const workers: FakeWorker[] = [];
    const renderer = new IsolatedRenderer(
      { type: "webview" },
      capabilities,
      {
        workerFactory: () => {
          const worker = new FakeWorker(
            (_request, signal) =>
              new Promise((_resolve, reject) => {
                if (signal.aborted) {
                  reject(signal.reason);
                  return;
                }
                signal.addEventListener("abort", () => reject(signal.reason), { once: true });
              }),
          );
          workers.push(worker);
          return worker;
        },
      },
    );
    const controller = new AbortController();
    const pending = renderer.render({
      url: "https://example.com",
      deadline: new Deadline(2000, controller.signal),
    });

    controller.abort(new Error("request cancelled"));

    await expect(pending).rejects.toThrow("request cancelled");
    expect(workers[0]?.closed).toBe(true);
    renderer.close();
  });
});
