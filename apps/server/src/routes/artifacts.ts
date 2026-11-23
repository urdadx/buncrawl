import { validateArtifactKey } from "@buncrawl/artifacts";

import { endpoint } from "../http";

/** Reads a stored artifact; undefined when no artifact has that key. */
export type ReadArtifact = (
  key: string,
  signal?: AbortSignal,
) => Promise<{ data: Uint8Array; contentType: string } | undefined>;

/**
 * Serves the screenshots and large page content that job results reference as `artifact://<key>`.
 * Stored HTML is scraped from other sites, so responses are sandboxed: a browser that opens one
 * never runs its scripts with this server's origin.
 */
export function createArtifactHandler(read: ReadArtifact = readStoredArtifact) {
  return async (request: Request, key: string): Promise<Response> => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return failure(405, "METHOD_NOT_ALLOWED", "Method not allowed", {
        Allow: "GET, HEAD, OPTIONS",
      });
    }
    try {
      validateArtifactKey(key);
    } catch {
      return failure(400, "INVALID_ARTIFACT_KEY", "Invalid artifact key");
    }

    let artifact;
    try {
      artifact = await read(key, request.signal);
    } catch {
      return failure(502, "ARTIFACT_STORE_FAILED", "The artifact could not be read");
    }
    if (!artifact) return failure(404, "ARTIFACT_NOT_FOUND", "Artifact not found");

    return new Response(request.method === "HEAD" ? null : artifact.data, {
      headers: {
        "content-type": artifact.contentType,
        "content-length": String(artifact.data.byteLength),
        // Keys are random and never reused, so an artifact never changes.
        "cache-control": "private, max-age=31536000, immutable",
        "content-security-policy": "default-src 'none'; sandbox",
        "x-content-type-options": "nosniff",
      },
    });
  };
}

export function artifactRoutes(read?: ReadArtifact) {
  const handler = createArtifactHandler(read);
  return {
    "/v1/artifacts/:key": endpoint<"/v1/artifacts/:key">((request) =>
      handler(request, request.params.key),
    ),
  };
}

/** The `/v1/artifacts/<key>` URL for an `artifact://<key>` reference, or undefined for anything else. */
export function artifactUrl(reference: unknown, base: string | URL): string | undefined {
  if (typeof reference !== "string" || !reference.startsWith("artifact://")) return undefined;
  return new URL(`/v1/artifacts/${reference.slice("artifact://".length)}`, base).href;
}

/** Reads from the server's artifact store, loaded on first use. */
export async function readStoredArtifact(key: string, signal?: AbortSignal) {
  // Imported lazily, so tests can build routes without the server's environment.
  const { readArtifact } = await import("../services");
  return readArtifact(key, signal);
}

function failure(
  status: number,
  code: string,
  error: string,
  headers?: Record<string, string>,
): Response {
  return Response.json({ success: false, code, error }, { status, headers });
}
