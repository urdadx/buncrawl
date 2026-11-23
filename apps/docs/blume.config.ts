import { defineConfig } from "blume";
import { openapi } from "blume/reference";

export default defineConfig({
  title: "Buncrawl",
  description: "Self-hosted, Firecrawl-compatible web scraping and crawling on Bun.",
  // Generated from the server's contracts: `pnpm --filter server openapi` rewrites openapi.json.
  theme: {
    fonts: { display: "inter", body: "inter" },
  },
  reference: [openapi({ spec: "./openapi.json", route: "/reference" })],
  navigation: {
    tabs: [
      { label: "Docs", path: "/" },
      { label: "API reference", path: "/reference" },
    ],
  },
});
