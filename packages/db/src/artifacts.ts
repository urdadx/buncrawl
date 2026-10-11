import { eq } from "drizzle-orm";

import type { Database } from "./index";
import { artifacts, type NewArtifactRecord } from "./schema";

export async function createArtifactRecord(db: Database, artifact: NewArtifactRecord) {
  const [record] = await db.insert(artifacts).values(artifact).returning();
  if (!record) throw new Error("Artifact metadata was not created");
  return record;
}

export async function getArtifactRecord(db: Database, key: string) {
  const [record] = await db.select().from(artifacts).where(eq(artifacts.key, key)).limit(1);
  return record;
}

export async function deleteArtifactRecord(db: Database, key: string): Promise<void> {
  await db.delete(artifacts).where(eq(artifacts.key, key));
}
