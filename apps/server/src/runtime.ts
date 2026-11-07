import type { Database } from "@buncrawl/db";

/** Background work started by one evaluation of the server entrypoint. */
export interface ServerRuntime {
  db: Database;
  stop(): Promise<void>;
}

const runtimeKey = "__buncrawlServerRuntime";
type RuntimeHolder = { [runtimeKey]?: Promise<ServerRuntime | undefined> };

/**
 * `bun --hot` re-evaluates every module inside the same process, so workers, timers and signal
 * handlers from the previous evaluation keep running beside the new ones (and claim jobs with
 * stale code). Stop the previous runtime before starting its replacement. Starts are chained so
 * rapid successive reloads cannot leave an orphaned runtime behind.
 */
export function replaceRuntime(
  start: (previous: ServerRuntime | undefined) => Promise<ServerRuntime>,
  holder: RuntimeHolder = globalThis as RuntimeHolder,
): Promise<ServerRuntime> {
  const pending = holder[runtimeKey];
  const next = (async () => {
    const previous = await pending?.catch(() => undefined);
    try {
      await previous?.stop();
    } catch (error) {
      console.error("Stopping the previous server runtime failed", error);
    }
    return start(previous);
  })();
  holder[runtimeKey] = next;
  return next;
}

/** Closes the previous evaluation's database client once nothing uses it any more. */
export function closeReplacedDb(previous: ServerRuntime | undefined, current: Database): void {
  if (!previous || previous.db === current) return;
  try {
    previous.db.$client.close();
  } catch (error) {
    console.error("Closing the previous database client failed", error);
  }
}
