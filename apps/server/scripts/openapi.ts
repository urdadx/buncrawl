// Writes the OpenAPI document for the v1 API to apps/docs/openapi.json, which the docs site's API
// reference reads. Run after changing a route or a contract: `pnpm --filter server openapi`.
import { buildOpenApiDocument } from "../src/openapi";

const target = new URL("../../docs/openapi.json", import.meta.url);
await Bun.write(target, `${JSON.stringify(buildOpenApiDocument(), null, 2)}\n`);
console.log(`Wrote ${Bun.fileURLToPath(target)}`);
