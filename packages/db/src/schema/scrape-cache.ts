import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/** Successful scrape results, keyed by a hash of the URL and every option that shapes the output. */
export const scrapeCache = sqliteTable(
  "scrape_cache",
  {
    key: text().primaryKey(),
    url: text().notNull(),
    document: text("document_json", { mode: "json" }).$type<unknown>().notNull(),
    byteSize: integer("byte_size").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [index("scrape_cache_created_at_idx").on(table.createdAt)],
);

export type ScrapeCacheRecord = typeof scrapeCache.$inferSelect;
