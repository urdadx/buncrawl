import { createClient } from "@libsql/client/web";
import { drizzle as drizzleBun } from "drizzle-orm/bun-sqlite";
import { drizzle as drizzleLibsql } from "drizzle-orm/libsql/web";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import type { DatabaseConfig } from "./config";
import { relations } from "./relations";

export function createDb(env: DatabaseConfig = {}) {
  const url = env.DATABASE_URL ?? "file:/data/buncrawl.db";
  if (url === ":memory:" || url.startsWith("file:")) {
    const path = sqlitePath(url);
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    return drizzleBun(path, { relations });
  }

  const client = createClient({
    url,
    ...(env.DATABASE_AUTH_TOKEN ? { authToken: env.DATABASE_AUTH_TOKEN } : {}),
  });

  return drizzleLibsql({ client, relations });
}

function sqlitePath(url: string): string {
  if (url === ":memory:" || url === "file::memory:") return ":memory:";
  return decodeURIComponent(url.slice("file:".length).split("?", 1)[0] ?? "");
}

export type Database = ReturnType<typeof createDb>;

export * from "./artifacts";
export * from "./config";
export * from "./crawl";
export * from "./jobs";
export * from "./migrate";
export * from "./schema";
