export type ArtifactBackend = "filesystem" | "r2";

export interface ArtifactWrite {
  key: string;
  data: Uint8Array;
  contentType: string;
  signal?: AbortSignal;
}

export interface StoredArtifact {
  key: string;
  backend: ArtifactBackend;
  contentType: string;
  byteSize: number;
  checksum: string;
}

export interface ArtifactStore {
  readonly backend: ArtifactBackend;
  put(input: ArtifactWrite): Promise<StoredArtifact>;
  get(key: string, signal?: AbortSignal): Promise<Uint8Array>;
  delete(key: string, signal?: AbortSignal): Promise<void>;
}

export class ArtifactStoreError extends Error {
  readonly code = "ARTIFACT_STORE_FAILED";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ArtifactStoreError";
  }
}

export async function checksum(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(data));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
