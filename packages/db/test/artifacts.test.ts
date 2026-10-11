import { describe, expect, test } from "bun:test";

import { createArtifactRecord, createDb, getArtifactRecord, migrateDb } from "../src";

describe("artifact repository", () => {
  test("persists artifact metadata", async () => {
    const db = createDb({ DATABASE_URL: ":memory:" });
    await migrateDb(db);
    const createdAt = new Date("2026-01-02T03:04:05.000Z");

    await createArtifactRecord(db, {
      key: "ab/abcdefabcdefabcdefabcdefabcdefab.png",
      backend: "filesystem",
      contentType: "image/png",
      byteSize: 42,
      checksum: "a".repeat(64),
      createdAt,
    });

    expect(await getArtifactRecord(db, "ab/abcdefabcdefabcdefabcdefabcdefab.png")).toMatchObject({
      backend: "filesystem",
      byteSize: 42,
      createdAt,
    });
  });
});
