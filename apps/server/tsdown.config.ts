import { defineConfig } from "tsdown";

export default defineConfig({
  // Worker entries are emitted next to index.mjs, where the renderer and extraction pools look for them.
  entry: ["./src/index.ts", "./src/renderer-worker.ts", "./src/extract-worker.ts"],
  format: "esm",
  outDir: "./dist",
  clean: true,
  deps: {
    alwaysBundle: [/@buncrawl\/.*/],
  },
});
