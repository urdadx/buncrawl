import { defineConfig } from "drizzle-kit";
import "varlock/auto-load";

export default defineConfig({
  schema: "./src/schema/index.ts",
  out: "./src/migrations",
  // drizzle-kit opens the file with Bun's or Node's built-in SQLite driver.
  dialect: "sqlite",
  dbCredentials: {
    url: (process.env.DATABASE_URL || "file:/data/buncrawl.db").replace(/^file:/, ""),
  },
});
