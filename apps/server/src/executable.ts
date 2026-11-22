// Entry point of the single-file executable (`pnpm compile`). An executable runs only this module,
// whatever its arguments, so the renderer pool re-runs it with BUNCRAWL_RENDERER_CONFIG set to get
// a browser worker process. Extraction workers are embedded as their own entry point instead.
if (process.env.BUNCRAWL_RENDERER_CONFIG) {
  void import("./renderer-worker");
} else {
  void import("./index");
}
