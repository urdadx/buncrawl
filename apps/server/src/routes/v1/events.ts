import { isTerminalJobState, jobIdSchema } from "@buncrawl/contracts";
import { getJob, getJobEvents, latestJobEventSequence, type Database } from "@buncrawl/db";
import * as v from "valibot";

const encoder = new TextEncoder();
const intervalMs = 1000;

export function createEventsHandler(db: Database) {
  return async (
    request: Request,
    id: string,
    type: "batch_scrape" | "map" | "crawl",
  ): Promise<Response> => {
    if (request.method !== "GET")
      return Response.json(
        { code: "METHOD_NOT_ALLOWED", error: "Method not allowed" },
        { status: 405, headers: { Allow: "GET, OPTIONS" } },
      );
    if (!v.safeParse(jobIdSchema, id).success)
      return Response.json({ code: "INVALID_JOB_ID", error: "Invalid job ID" }, { status: 400 });
    const job = await getJob(db, id);
    if (!job || job.type !== type)
      return Response.json({ code: "JOB_NOT_FOUND", error: "Job not found" }, { status: 404 });
    const raw =
      request.headers.get("Last-Event-ID") ?? new URL(request.url).searchParams.get("after");
    if (raw !== null && (!/^(0|[1-9]\d*)$/.test(raw) || !Number.isSafeInteger(Number(raw))))
      return Response.json(
        { code: "INVALID_EVENT_ID", error: "Invalid event ID" },
        { status: 400 },
      );
    let cursor = raw === null ? 0 : Number(raw);
    let wake: (() => void) | undefined;
    let closed = false;
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const close = () => {
          closed = true;
          wake?.();
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        };
        request.signal.addEventListener("abort", close, { once: true });
        const emit = (event: string, data: unknown, sequence?: number) =>
          controller.enqueue(
            encoder.encode(
              `${sequence === undefined ? "" : `id: ${sequence}\n`}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
            ),
          );
        try {
          if (raw === null) {
            cursor = await latestJobEventSequence(db, id);
            const snapshot = await getJob(db, id);
            if (!snapshot) return;
            emit(
              "snapshot",
              {
                jobId: id,
                type,
                state: snapshot.state,
                progress: snapshot.progress,
                ...(snapshot.error ? { error: snapshot.error } : {}),
              },
              cursor || undefined,
            );
          }
          while (!closed) {
            const events = await getJobEvents(db, id, cursor);
            for (const entry of events) {
              if (closed) break;
              cursor = entry.sequence;
              emit(
                entry.type,
                {
                  jobId: id,
                  sequence: cursor,
                  timestamp: entry.createdAt.toISOString(),
                  ...(entry.payload as object),
                },
                cursor,
              );
            }
            if (events.length === 100) continue;
            const current = await getJob(db, id);
            if (!current) break;
            if (isTerminalJobState(current.state) && events.length === 0) {
              // A terminal state is committed just before its event; recheck once so
              // a stream never closes between the two writes.
              await new Promise((resolve) => setTimeout(resolve, intervalMs));
              if ((await getJobEvents(db, id, cursor, 1)).length === 0) break;
              continue;
            }
            if (!closed) controller.enqueue(encoder.encode(": heartbeat\n\n"));
            await new Promise<void>((resolve) => {
              const timer = setTimeout(resolve, intervalMs);
              wake = () => {
                clearTimeout(timer);
                resolve();
              };
            });
            wake = undefined;
          }
        } catch (error) {
          if (!closed) controller.error(error);
        } finally {
          close();
        }
      },
      cancel() {
        closed = true;
        wake?.();
      },
    });
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        "x-accel-buffering": "no",
      },
    });
  };
}
