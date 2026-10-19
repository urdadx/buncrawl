import { expect, test } from "bun:test";
import { FilesystemArtifactStore } from "@buncrawl/artifacts";
import { createDb, getArtifactRecord, migrateDb } from "@buncrawl/db";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { persistDocumentArtifacts } from "../src/document-artifacts";

test("stores large text and original screenshot bytes with metadata and opaque keys", async () => {
  const root = await mkdtemp(join(tmpdir(), "buncrawl-batch-artifacts-"));
  try {
    const db = createDb({ DATABASE_URL: ":memory:" });
    await migrateDb(db);
    const store = new FilesystemArtifactStore(root);
    await store.initialize();
    const png = new Uint8Array([137, 80, 78, 71, 0, 255]);
    const result = await persistDocumentArtifacts(db, store, {
      markdown: "m".repeat(70_000),
      html: "short",
      screenshot: `data:image/png;base64,${png.toBase64()}`,
      metadata: {
        sourceURL: "https://site.example",
        finalURL: "https://site.example",
        statusCode: 200,
        renderer: "fetch",
      },
    });
    expect(result.html).toBe("short");
    for (const field of ["markdown", "screenshot"] as const) {
      const key = result[field]!.slice("artifact://".length);
      expect(key).toMatch(/^[0-9a-f]{32}\.(md|png)$/);
      const bytes = await store.get(key);
      expect(bytes).toEqual(
        field === "screenshot" ? png : new TextEncoder().encode("m".repeat(70_000)),
      );
      expect(await getArtifactRecord(db, key)).toMatchObject({
        backend: "filesystem",
        byteSize: bytes.byteLength,
      });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
