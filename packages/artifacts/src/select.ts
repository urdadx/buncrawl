import { FilesystemArtifactStore } from "./filesystem";
import { R2ArtifactStore, type R2ArtifactStoreOptions } from "./r2";
import type { ArtifactStore } from "./store";

export interface ArtifactStoreConfig {
  filesystemRoot?: string;
  r2?: Partial<R2ArtifactStoreOptions>;
}

export async function selectArtifactStore(
  config: ArtifactStoreConfig = {},
): Promise<ArtifactStore> {
  const filesystem = new FilesystemArtifactStore(config.filesystemRoot);
  await filesystem.initialize();

  if (!isCompleteR2Config(config.r2)) return filesystem;

  const r2 = new R2ArtifactStore(config.r2);
  try {
    await r2.check();
    return r2;
  } catch (error) {
    console.warn("R2 capability check failed; using filesystem artifact storage", error);
    return filesystem;
  }
}

function isCompleteR2Config(
  config: Partial<R2ArtifactStoreOptions> | undefined,
): config is R2ArtifactStoreOptions {
  return Boolean(config?.endpoint && config.bucket && config.accessKeyId && config.secretAccessKey);
}
