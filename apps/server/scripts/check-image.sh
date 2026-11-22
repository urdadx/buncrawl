#!/usr/bin/env bash
# Image check: tests a built server image without the public internet. Runs the real-browser
# tests in its `image-check` target (the same image plus the renderer sources), then starts the
# server image and checks that /v1/capabilities reports both renderers.
# Usage: apps/server/scripts/check-image.sh <image> <image-check-target-image>
set -euo pipefail

image="${1:?usage: check-image.sh <image> <image-check-target-image>}"
test_image="${2:?usage: check-image.sh <image> <image-check-target-image>}"
name="buncrawl-image-check-$$"

echo "--- Real-browser tests inside ${test_image}"
# `bun test` exits 0 when a file registers no tests (e.g. it was skipped or copied empty), so
# require that tests actually passed.
browser_output="$(docker run --rm --init \
  -e BUNCRAWL_TEST_REAL_BROWSERS=1 \
  -w /app/packages/renderer \
  "${test_image}" bun test ./test/real-browsers.test.ts 2>&1)" || {
  echo "${browser_output}"
  exit 1
}
echo "${browser_output}"
if ! grep -Eq '^ *[1-9][0-9]* pass' <<<"${browser_output}" || grep -Eq '^ *[1-9][0-9]* (fail|skip)' <<<"${browser_output}"; then
  echo "Real-browser tests did not all run and pass" >&2
  exit 1
fi

echo "--- Server capability check"
cleanup() {
  status=$?
  if [ "$status" -ne 0 ]; then docker logs "${name}" || true; fi
  docker rm -f "${name}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# No configuration: the image's defaults must be enough to start.
docker run -d --init --name "${name}" "${image}" >/dev/null

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
echo "--- Image check passed"
