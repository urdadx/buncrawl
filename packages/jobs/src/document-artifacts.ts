import { createArtifactKey, type ArtifactStore } from "@buncrawl/artifacts";
import type { ScrapeDocument } from "@buncrawl/contracts";
import { createArtifactRecord, type Database } from "@buncrawl/db";

export async function persistDocumentArtifacts(
  db: Database,
  store: ArtifactStore,
  document: ScrapeDocument,
): Promise<ScrapeDocument> {
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
    const stored = await store.put({
      key,
      data: png ? Uint8Array.fromBase64(match![1]!) : new TextEncoder().encode(value),
      contentType: png ? "image/png" : field === "markdown" ? "text/markdown" : "text/html",
    });
    try {
      await createArtifactRecord(db, { ...stored, createdAt: new Date() });
    } catch (error) {
      await store.delete(key).catch(() => undefined);
      throw error;
    }
    result[field] = `artifact://${key}`;
  }
  return result;
}
