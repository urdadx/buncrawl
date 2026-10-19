import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createArtifactKey,
  FilesystemArtifactStore,
  selectArtifactStore,
  validateArtifactKey,
} from "../src";

const roots: string[] = [];
afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
);

describe("artifact keys", () => {
  test("creates opaque normalized keys", () => {
    expect(validateArtifactKey(createArtifactKey("PNG"))).toMatch(/^[0-9a-f]{32}\.png$/);
  });

  test.each([
    "../secret",
    "/absolute",
    "aa/../../secret.png",
    "aa/file name.png",
    "aa/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png",
    "request.png",
  ])("rejects unsafe key %s", (key) =>
    expect(() => validateArtifactKey(key)).toThrow("Invalid artifact key"),
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

test("selects healthy R2, falls back when unavailable, and never changes backends after selection", async () => {
  const root = await mkdtemp(join(tmpdir(), "buncrawl-artifacts-"));
  roots.push(root);
  const config = {
    filesystemRoot: root,
    r2: {
      endpoint: "https://r2.example",
      bucket: "bucket",
      accessKeyId: "key",
      secretAccessKey: "secret",
    },
  };
  const r2 = {
    backend: "r2" as const,
    check: async () => {},
    put: async () => {
      throw new Error("R2 unavailable");
    },
    get: async () => new Uint8Array(),
    delete: async () => {},
  };
  const selected = await selectArtifactStore(config, () => r2);
  expect(selected.backend).toBe("r2");
  await expect(
    selected.put({
      key: createArtifactKey("md"),
      data: new Uint8Array([1]),
      contentType: "text/markdown",
    }),
  ).rejects.toThrow("R2 unavailable");
  const fallback = await selectArtifactStore(config, () => ({
    ...r2,
    check: async () => {
      throw new Error("probe failed");
    },
  }));
  expect(fallback.backend).toBe("filesystem");
});
