import { defineConfig } from "drizzle-kit";
import "varlock/auto-load";

export default defineConfig({
  schema: "./src/schema/index.ts",
  out: "./src/migrations",
  dialect: "turso",
  dbCredentials: {
    url: process.env.DATABASE_URL || "",
  },
});
