// Entry point of the single-file executable (`pnpm compile`). An executable runs only this module,
// whatever its arguments, so the renderer pool re-runs it with BUNCRAWL_RENDERER_CONFIG set to get
// a browser worker process. Extraction workers are embedded as their own entry point instead.
// Otherwise the arguments pick the command: the API server by default, or a one-off scrape.
// Top-level await keeps the process alive until the command settles: with a floating promise, Bun
// can exit while a plain HTTP scrape is still in flight.
if (process.env.BUNCRAWL_RENDERER_CONFIG) {
  await import("./renderer-worker");
} else {
  const { main } = await import("./cli");
  await main(process.argv.slice(2));
}

export {};
