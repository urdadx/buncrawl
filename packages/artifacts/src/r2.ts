import { validateArtifactKey } from "./keys";
import { ArtifactStoreError, checksum, type ArtifactStore, type ArtifactWrite } from "./store";

export interface R2ArtifactStoreOptions {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  region?: string;
  retries?: number;
}

export class R2ArtifactStore implements ArtifactStore {
  readonly backend = "r2" as const;
  readonly #client: Bun.S3Client;
  readonly #retries: number;

  constructor(options: R2ArtifactStoreOptions) {
    this.#client = new Bun.S3Client({
      endpoint: options.endpoint,
      bucket: options.bucket,
      accessKeyId: options.accessKeyId,
      secretAccessKey: options.secretAccessKey,
      region: options.region ?? "auto",
    });
    this.#retries = options.retries ?? 2;
  }

  async check(signal?: AbortSignal): Promise<void> {
    const key = createProbeKey();
    await this.put({
      key,
      data: new Uint8Array([0]),
      contentType: "application/octet-stream",
      signal,
    });
    const data = await this.get(key, signal);
    if (data.byteLength !== 1 || data[0] !== 0)
      throw new ArtifactStoreError("R2 probe was corrupted");
    await this.delete(key, signal);
  }

  async put(input: ArtifactWrite) {
    validateArtifactKey(input.key);
    await this.#retry("upload", input.signal, () =>
      this.#client.file(input.key).write(input.data, { type: input.contentType }),
    );
    return {
      key: input.key,
      backend: this.backend,
      contentType: input.contentType,
      byteSize: input.data.byteLength,
      checksum: await checksum(input.data),
    };
  }

  async get(key: string, signal?: AbortSignal): Promise<Uint8Array> {
    validateArtifactKey(key);
    const buffer = await this.#retry("download", signal, () =>
      this.#client.file(key).arrayBuffer(),
    );
    return new Uint8Array(buffer);
  }

  async delete(key: string, signal?: AbortSignal): Promise<void> {
    validateArtifactKey(key);
    await this.#retry("delete", signal, () => this.#client.file(key).delete());
  }

  async #retry<T>(
    operation: string,
    signal: AbortSignal | undefined,
    action: () => Promise<T>,
  ): Promise<T> {
    let cause: unknown;
    for (let attempt = 0; attempt <= this.#retries; attempt++) {
      signal?.throwIfAborted();
      try {
        return await action();
      } catch (error) {
        cause = error;
        if (attempt < this.#retries) await Bun.sleep(100 * 2 ** attempt);
      }
    }
    throw new ArtifactStoreError(`R2 artifact ${operation} failed`, { cause });
  }
}

function createProbeKey(): string {
  const id = crypto.randomUUID().replaceAll("-", "");
  return `${id.slice(0, 2)}/${id}.probe`;
}
