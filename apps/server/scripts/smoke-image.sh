#!/usr/bin/env bash
# Smoke-tests a built server image without the public internet: runs the real-browser smoke tests
# inside it, then starts the server and checks that /v1/capabilities reports both renderers.
# Usage: apps/server/scripts/smoke-image.sh <image>
set -euo pipefail

image="${1:?usage: smoke-image.sh <image>}"
name="buncrawl-smoke-$$"

echo "--- Browser smoke tests inside ${image}"
docker run --rm --init \
  -e BUNCRAWL_RUN_BROWSER_SMOKE=1 \
  -w /app/packages/renderer \
  "${image}" bun test test/browser-smoke.test.ts

echo "--- Server capability check"
cleanup() {
  status=$?
  if [ "$status" -ne 0 ]; then docker logs "${name}" || true; fi
  docker rm -f "${name}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker run -d --init --name "${name}" \
  -e CORS_ORIGIN=http://localhost:3001 \
  -e DATABASE_URL=file:/tmp/buncrawl.db \
  -e BUNCRAWL_ARTIFACTS_PATH=/tmp/artifacts \
  "${image}" >/dev/null

# Runs inside the container so the check needs nothing on the host but Docker.
docker exec "${name}" bun -e '
  const deadline = Date.now() + 60_000;
  let response;
  while (Date.now() < deadline) {
    response = await fetch("http://127.0.0.1:3000/v1/capabilities").catch(() => undefined);
    if (response) break;
    await Bun.sleep(500);
  }
  if (!response?.ok) throw new Error(`/v1/capabilities failed: ${response?.status ?? "no response"}`);
  const { data } = await response.json();
  console.log(JSON.stringify(data, null, 2));
  for (const renderer of data.renderers) {
    if (!renderer.capabilities.available) throw new Error(`${renderer.name} unavailable: ${renderer.error}`);
  }
  for (const feature of ["javascript", "screenshots", "cdp", "computedStyles"]) {
    if (!data.summary[feature]) throw new Error(`summary.${feature} is false`);
  }
'
echo "--- Image smoke checks passed"
