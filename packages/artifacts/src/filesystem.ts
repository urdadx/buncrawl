import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";

import { validateArtifactKey } from "./keys";
import { ArtifactStoreError, checksum, type ArtifactStore, type ArtifactWrite } from "./store";

export class FilesystemArtifactStore implements ArtifactStore {
  readonly backend = "filesystem" as const;
  readonly #root: string;

  constructor(root = "/data/artifacts") {
    this.#root = resolve(root);
  }

  async initialize(): Promise<void> {
    await mkdir(this.#root, { recursive: true });
  }

  async put(input: ArtifactWrite) {
    input.signal?.throwIfAborted();
    const path = this.#path(input.key);
    try {
      await writeFile(path, input.data, { signal: input.signal });
      return {
        key: input.key,
        backend: this.backend,
        contentType: input.contentType,
        byteSize: input.data.byteLength,
        checksum: await checksum(input.data),
      };
    } catch (cause) {
      throw new ArtifactStoreError("Failed to write artifact", { cause });
    }
  }

  async get(key: string, signal?: AbortSignal): Promise<Uint8Array> {
    signal?.throwIfAborted();
    try {
      return await readFile(this.#path(key));
    } catch (cause) {
      throw new ArtifactStoreError("Failed to read artifact", { cause });
    }
  }

  async delete(key: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    try {
      await rm(this.#path(key), { force: true });
    } catch (cause) {
      throw new ArtifactStoreError("Failed to delete artifact", { cause });
    }
  }

  #path(key: string): string {
    const path = resolve(this.#root, validateArtifactKey(key));
    if (!path.startsWith(`${this.#root}${sep}`)) throw new TypeError("Artifact path escapes root");
    return path;
  }
}
