import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const artifacts = sqliteTable(
  "artifacts",
  {
    key: text().primaryKey(),
    backend: text({ enum: ["filesystem", "r2"] }).notNull(),
    contentType: text("content_type").notNull(),
    byteSize: integer("byte_size").notNull(),
    checksum: text().notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }),
  },
  (table) => [index("artifacts_expires_at_idx").on(table.expiresAt)],
);

export type ArtifactRecord = typeof artifacts.$inferSelect;
export type NewArtifactRecord = typeof artifacts.$inferInsert;
