import { createArtifactKey, selectArtifactStore, type ArtifactStore } from "@buncrawl/artifacts";
import { createArtifactRecord, createDb, getArtifactRecord, migrateDb } from "@buncrawl/db";
import type { ScrapeDocument } from "@buncrawl/contracts";
import { persistDocumentArtifacts } from "@buncrawl/jobs";

import { ENV } from "#env";

export const db = createDb(ENV);

let artifactStore: ArtifactStore;

export const servicesReady = initializeServices();

async function initializeServices(): Promise<void> {
  await migrateDb(db);

  artifactStore = await selectArtifactStore({
    filesystemRoot: ENV.BUNCRAWL_ARTIFACTS_PATH,
    r2: {
      endpoint: ENV.BUNCRAWL_R2_ENDPOINT,
      bucket: ENV.BUNCRAWL_R2_BUCKET,
      accessKeyId: ENV.BUNCRAWL_R2_ACCESS_KEY_ID,
      secretAccessKey: ENV.BUNCRAWL_R2_SECRET_ACCESS_KEY,
      region: ENV.BUNCRAWL_R2_REGION,
    },
  });

  console.info(`Artifact storage backend: ${artifactStore.backend}`);
}

/** A stored artifact's bytes and content type; undefined for a key that was never stored. */
export async function readArtifact(
  key: string,
  signal?: AbortSignal,
): Promise<{ data: Uint8Array; contentType: string } | undefined> {
  await servicesReady;
  const record = await getArtifactRecord(db, key);
  if (!record) return undefined;
  return { data: await artifactStore.get(key, signal), contentType: record.contentType };
}

export async function persistScreenshot(dataUrl: string, signal?: AbortSignal): Promise<string> {
  await servicesReady;
  const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!match?.[1]) throw new TypeError("Screenshot must be a base64 PNG data URL");

  const key = createArtifactKey("png");
  const data = Uint8Array.fromBase64(match[1]);
  const stored = await artifactStore.put({ key, data, contentType: "image/png", signal });

  try {
    await createArtifactRecord(db, { ...stored, createdAt: new Date() });
  } catch (error) {
    await artifactStore.delete(key, signal).catch(() => undefined);
    throw error;
  }
  return key;
}

export async function persistJobDocument(document: ScrapeDocument): Promise<ScrapeDocument> {
  await servicesReady;
  return persistDocumentArtifacts(db, artifactStore, document);
}
