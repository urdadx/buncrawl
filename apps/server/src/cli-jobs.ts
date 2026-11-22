import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { createDb, migrateDb, type Database } from "@buncrawl/db";
import {
  DiscoveryWorker,
  JobWorker,
  type DiscoveryWorkerOptions,
  type WorkerOptions,
} from "@buncrawl/jobs";

import { createBatchScrapeHandler } from "./routes/v1/batch-scrape";
import { createDiscoveryHandler } from "./routes/v1/discovery";

/** The CLI's name for each job type, and the API path it runs through. */
export type JobCommand = "map" | "crawl" | "batch";

const API_PATHS: Record<JobCommand, string> = {
  map: "/v1/map",
  crawl: "/v1/crawl",
  batch: "/v1/batch/scrape",
};

const BASE_URL = "http://buncrawl.cli";
const POLL_MS = 500;

export interface JobProgress {
  total: number;
  queued: number;
  running: number;
  succeeded: number;
  failed: number;
  cancelled: number;
}

interface JobPage {
  state: string;
  error?: { code: string; message: string };
  progress: JobProgress;
  items: Record<string, unknown>[];
  urls?: string[];
  next?: string;
}

export interface JobRunOptions {
  /** A SQLite file to hold the job instead of memory, for large crawls. */
  dbPath?: string;
  /** Called with each progress snapshot while the job runs. */
  onProgress?: (progress: JobProgress) => void;
  /** Resolves when the user asks to stop; the job is then cancelled and its results returned. */
  cancelled?: Promise<void>;
  /** Overrides for the worker, e.g. a fake fetch in tests. */
  worker?: Partial<Omit<DiscoveryWorkerOptions, "db">> & Partial<Omit<WorkerOptions, "db">>;
  /** How often to check the job's state. */
  pollMs?: number;
}

export type JobRunResult =
  | { ok: false; status: number; code: string; error: string; details?: string[] }
  | {
      ok: true;
      state: string;
      error?: { code: string; message: string };
      progress: JobProgress;
      /** Every item, in the order GET /v1/<type>/:id pages them. */
      items: Record<string, unknown>[];
      /** Map only: the discovered URLs. */
      urls: string[];
    };

/**
 * Runs one map, crawl or batch scrape job in this process: the same route handlers and workers
 * as the API server, over a private SQLite database, so results match the API exactly.
 */
export async function runJob(
  command: JobCommand,
  body: Record<string, unknown>,
  options: JobRunOptions = {},
): Promise<JobRunResult> {
  const db = createDb({ DATABASE_URL: options.dbPath ? `file:${options.dbPath}` : ":memory:" });
  await migrateDb(db);
  // Workers poll the database; there is no other process to notify.
  const notify = async () => undefined;
  const handler =
    command === "batch"
      ? createBatchScrapeHandler(db, notify)
      : createDiscoveryHandler(db, command, notify);
  const worker =
    command === "batch"
      ? new JobWorker({ ...(options.worker as Partial<WorkerOptions>), db })
      : new DiscoveryWorker({ ...(options.worker as Partial<DiscoveryWorkerOptions>), db });
  const pollMs = options.pollMs ?? POLL_MS;
  const path = API_PATHS[command];

  try {
    await worker.start();
    const submitted = await call(handler, "POST", `${path}`, undefined, body);
    if (submitted.status !== 202) {
      const failure = submitted.json as { code?: string; error?: string; details?: string[] };
      return {
        ok: false,
        status: submitted.status,
        code: failure.code ?? "REQUEST_FAILED",
        error: failure.error ?? `The ${command} request failed`,
        ...(failure.details ? { details: failure.details } : {}),
      };
    }
    const id = (submitted.json as { jobId: string }).jobId;

    let cancelRequested = false;
    void options.cancelled?.then(async () => {
      cancelRequested = true;
      await call(handler, "DELETE", `${path}/${id}`, id);
    });

    let page = await getPage(handler, path, id, 1);
    while (!isTerminal(page.state)) {
      options.onProgress?.(page.progress);
      await Bun.sleep(pollMs);
      page = await getPage(handler, path, id, 1);
    }
    options.onProgress?.(page.progress);

    const items: Record<string, unknown>[] = [];
    const urls = new Set<string>();
    let cursor = 0;
    for (;;) {
      const result = await getPage(handler, path, id, 100, cursor);
      items.push(...result.items);
      for (const url of result.urls ?? []) urls.add(url);
      cursor += result.items.length;
      if (!result.next || result.items.length === 0) break;
    }
    return {
      ok: true,
      state: cancelRequested && page.state !== "completed" ? "cancelled" : page.state,
      ...(page.error ? { error: page.error } : {}),
      progress: page.progress,
      items,
      urls: [...urls],
    };
  } finally {
    await worker.stop();
    closeDb(db);
  }
}

/**
 * A file name for a page, derived from its URL: only `[A-Za-z0-9._-]`, so it can never name a
 * directory or leave the output folder, and unique within `taken`.
 */
export function pageFileName(url: string, taken: Set<string>): string {
  let base: string;
  try {
    const parsed = new URL(url);
    base = `${parsed.host}${parsed.pathname === "/" ? "" : parsed.pathname}${parsed.search}`;
  } catch {
    base = url;
  }
  base = base
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^[._]+|[._]+$/g, "")
    .slice(0, 150);
  if (!base) base = "page";
  let name = base;
  for (let n = 2; taken.has(name); n++) name = `${base}-${n}`;
  taken.add(name);
  return name;
}

/**
 * Writes each completed page's Markdown (and screenshot, if captured) into `dir`.
 * Returns the paths written, in item order.
 */
export async function writePages(dir: string, items: Record<string, unknown>[]): Promise<string[]> {
  await mkdir(dir, { recursive: true });
  const taken = new Set<string>();
  const written: string[] = [];
  for (const item of items) {
    const document = item.document as
      | { markdown?: string; screenshot?: string; metadata?: { sourceURL?: string } }
      | undefined;
    if (item.state !== "completed" || !document) continue;
    const url = String(item.finalUrl ?? item.url ?? document.metadata?.sourceURL ?? "");
    const name = pageFileName(url, taken);
    const markdownPath = join(dir, `${name}.md`);
    await Bun.write(markdownPath, `<!-- ${url} -->\n\n${document.markdown ?? ""}`);
    written.push(markdownPath);
    const png = /^data:image\/png;base64,(.+)$/.exec(document.screenshot ?? "");
    if (png?.[1]) {
      const screenshotPath = join(dir, `${name}.png`);
      await Bun.write(screenshotPath, Uint8Array.fromBase64(png[1]));
      written.push(screenshotPath);
    }
  }
  return written;
}

type Handler = (request: Request, id?: string) => Promise<Response>;

async function call(
  handler: Handler,
  method: string,
  path: string,
  id?: string,
  body?: unknown,
): Promise<{ status: number; json: unknown }> {
  const request = new Request(`${BASE_URL}${path}`, {
    method,
    ...(body === undefined
      ? {}
      : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
  });
  const response = await handler(request, id);
  return { status: response.status, json: await response.json() };
}

async function getPage(
  handler: Handler,
  path: string,
  id: string,
  limit: number,
  cursor = 0,
): Promise<JobPage> {
  const { status, json } = await call(
    handler,
    "GET",
    `${path}/${id}?cursor=${cursor}&limit=${limit}`,
    id,
  );
  if (status !== 200) throw new Error(`Reading the job failed with status ${status}`);
  return json as JobPage;
}

function isTerminal(state: string): boolean {
  return state === "completed" || state === "failed" || state === "cancelled";
}

function closeDb(db: Database): void {
  const client = (db as { $client?: { close?: () => void } }).$client;
  client?.close?.();
}
