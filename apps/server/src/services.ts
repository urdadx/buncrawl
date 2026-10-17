import { createArtifactKey, selectArtifactStore, type ArtifactStore } from "@buncrawl/artifacts";
import { createArtifactRecord, createDb, migrateDb } from "@buncrawl/db";
import type { ScrapeDocument } from "@buncrawl/contracts";

import { ENV } from "./env.server";

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
  const result: ScrapeDocument = { ...document };
  for (const field of ["markdown", "html", "rawHtml", "screenshot"] as const) {
    const value = result[field];
    if (
      !value ||
      (field !== "screenshot" && new TextEncoder().encode(value).byteLength < 64 * 1024)
    )
      continue;
    const png = field === "screenshot";
    const match = png ? /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(value) : null;
    if (png && !match?.[1]) throw new TypeError("Screenshot must be a base64 PNG data URL");
    const key = createArtifactKey(png ? "png" : field === "markdown" ? "md" : "html");
    const stored = await artifactStore.put({
      key,
      data: png ? Uint8Array.fromBase64(match![1]!) : new TextEncoder().encode(value),
      contentType: png ? "image/png" : field === "markdown" ? "text/markdown" : "text/html",
    });
    try {
      await createArtifactRecord(db, { ...stored, createdAt: new Date() });
    } catch (error) {
      await artifactStore.delete(key).catch(() => undefined);
      throw error;
    }
    result[field] = `artifact://${key}`;
  }
  return result;
}
