import { describe, expect, test } from "bun:test";
import { createDb, migrateDb } from "@buncrawl/db";

import { artifactUrl, createArtifactHandler, type ReadArtifact } from "../src/routes/artifacts";
import { createBatchScrapeHandler } from "../src/routes/v1/batch-scrape";
import { createDiscoveryHandler } from "../src/routes/v1/discovery";

const key = `${"a".repeat(32)}.png`;
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

const read: ReadArtifact = async (requested) =>
  requested === key ? { data: png, contentType: "image/png" } : undefined;

function get(path: string, method = "GET") {
  return new Request(`http://localhost${path}`, { method });
}

describe("GET /v1/artifacts/:key", () => {
  const handler = createArtifactHandler(read);

  test("serves a stored artifact with its type, sandboxed", async () => {
    const response = await handler(get(`/v1/artifacts/${key}`), key);
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(png);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("content-length")).toBe("4");
    expect(response.headers.get("content-security-policy")).toContain("sandbox");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");

    const head = await handler(get(`/v1/artifacts/${key}`, "HEAD"), key);
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  });

  test("rejects malformed keys before reading anything", async () => {
    let reads = 0;
    const counting = createArtifactHandler(async () => {
      reads++;
      return undefined;
    });
    for (const bad of ["../../etc/passwd", "abc.png", `${"a".repeat(32)}.PNG/..`, ""]) {
      const response = await counting(get("/v1/artifacts/x"), bad);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: "INVALID_ARTIFACT_KEY" });
    }
    expect(reads).toBe(0);
  });

  test("reports unknown keys, store failures and other methods", async () => {
    const missing = await handler(get("/v1/artifacts/x"), `${"b".repeat(32)}.md`);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ code: "ARTIFACT_NOT_FOUND" });

    const broken = createArtifactHandler(async () => {
      throw new Error("disk gone");
    });
    const failed = await broken(get("/v1/artifacts/x"), key);
    expect(failed.status).toBe(502);
    expect(await failed.json()).toMatchObject({ code: "ARTIFACT_STORE_FAILED" });

    const post = await handler(get("/v1/artifacts/x", "POST"), key);
    expect(post.status).toBe(405);
  });

  test("artifactUrl turns a reference into its download URL", () => {
    expect(artifactUrl(`artifact://${key}`, "https://api.example/v2/crawl/x")).toBe(
      `https://api.example/v1/artifacts/${key}`,
    );
    expect(artifactUrl("data:image/png;base64,AAAA", "https://api.example")).toBeUndefined();
    expect(artifactUrl(undefined, "https://api.example")).toBeUndefined();
  });
});

test("map and crawl submissions get 429 QUEUE_FULL when the job queue is full", async () => {
  const db = createDb({ DATABASE_URL: ":memory:" });
  await migrateDb(db);
  const notify = async () => undefined;
  const batch = createBatchScrapeHandler(db, notify);
  // Ten batches of 1,000 fill the server-wide limit of 10,000 queued items.
  for (let i = 0; i < 10; i++) {
    const requests = Array.from({ length: 1000 }, (_, n) => ({
      url: `https://site.example/${i}/${n}`,
    }));
    const response = await batch(
      new Request("http://localhost/v1/batch/scrape", {
        method: "POST",
        body: JSON.stringify({ requests }),
      }),
    );
    expect(response.status).toBe(202);
  }

  for (const type of ["map", "crawl"] as const) {
    const response = await createDiscoveryHandler(
      db,
      type,
      notify,
    )(
      new Request(`http://localhost/v1/${type}`, {
        method: "POST",
        body: JSON.stringify({ url: "https://example.com" }),
      }),
    );
    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ code: "QUEUE_FULL", error: "Job queue is full" });
  }
  db.$client.close();
}, 30_000);
