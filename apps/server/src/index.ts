import { DiscoveryWorker, JobWorker, WebhookWorker } from "@buncrawl/jobs";
import { pruneJobEvents, pruneScrapeCache } from "@buncrawl/db";

import { corsHeaders, endpoint } from "./http";
import { createRoutes } from "./routes";
import { closeReplacedDb, replaceRuntime, type ServerRuntime } from "./runtime";
import { SERVER_IDLE_TIMEOUT_SECONDS } from "./server-config";
import { db, persistJobDocument, servicesReady } from "./services";

async function startRuntime(previous: ServerRuntime | undefined): Promise<ServerRuntime> {
  await servicesReady;
  closeReplacedDb(previous, db);

  const worker = new JobWorker({ db, persistDocument: persistJobDocument });
  await worker.start();
  const discoveryWorker = new DiscoveryWorker({ db, persistDocument: persistJobDocument });
  await discoveryWorker.start();
  const webhooks = new WebhookWorker(db);
  webhooks.start();
  const prune = () => Promise.all([pruneJobEvents(db), pruneScrapeCache(db)]);
  await prune();
  const retention = setInterval(() => void prune().catch(console.error), 60 * 60 * 1000);

  const signals = ["SIGINT", "SIGTERM"] as const;
  let stopping: Promise<void> | undefined;
  const stop = () =>
    (stopping ??= (async () => {
      clearInterval(retention);
      for (const signal of signals) process.off(signal, onSignal);
      await Promise.all([worker.stop(), discoveryWorker.stop(), webhooks.stop()]);
    })());
  const onSignal = () => void stop().finally(() => process.exit(0));
  for (const signal of signals) process.on(signal, onSignal);

  return { db, stop };
}

async function main(): Promise<void> {
  await replaceRuntime(startRuntime);

  // Under `bun --hot`, a repeated Bun.serve() call reloads the running server's handlers in place.
  const server = Bun.serve({
    idleTimeout: SERVER_IDLE_TIMEOUT_SECONDS,
    routes: createRoutes(db),
    fetch: endpoint(() => new Response("Not Found", { status: 404 })),
    error(error) {
      console.error(error);
      return new Response("Internal Server Error", {
        headers: corsHeaders,
        status: 500,
      });
    },
  });

  console.info(`Server listening at ${server.url}`);
}

main().catch((error) => {
  console.error("Server startup failed", error);
  process.exitCode = 1;
});
