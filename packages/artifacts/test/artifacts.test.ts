import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createArtifactKey, FilesystemArtifactStore, validateArtifactKey } from "../src";

const roots: string[] = [];
afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
);

describe("artifact keys", () => {
  test("creates opaque normalized keys", () => {
    expect(validateArtifactKey(createArtifactKey("PNG"))).toMatch(/^[0-9a-f]{32}\.png$/);
  });

  test("accepts legacy sharded keys for existing artifacts", () => {
    expect(validateArtifactKey("aa/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png")).toBe(
      "aa/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png",
    );
  });

  test.each(["../secret", "/absolute", "aa/../../secret.png", "aa/file name.png", "request.png"])(
    "rejects unsafe key %s",
    (key) => expect(() => validateArtifactKey(key)).toThrow("Invalid artifact key"),
  );
});

describe("filesystem artifact store", () => {
  test("preserves bytes and returns metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "buncrawl-artifacts-"));
    roots.push(root);
    const store = new FilesystemArtifactStore(root);
    await store.initialize();
    const key = createArtifactKey("png");
    const data = new Uint8Array([137, 80, 78, 71, 0, 255]);

    const result = await store.put({ key, data, contentType: "image/png" });

    expect(result).toMatchObject({
      key,
      backend: "filesystem",
      contentType: "image/png",
      byteSize: 6,
    });
    expect(result.checksum).toHaveLength(64);
    expect(await store.get(key)).toEqual(data);
    expect(new Uint8Array(await readFile(join(root, key)))).toEqual(data);
  });
});
