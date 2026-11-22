#!/usr/bin/env bash
# Builds the single-file binary for every released platform with the `compile` script, packs each
# as buncrawl-<platform>.tar.gz, and writes SHA256SUMS. install.sh downloads these assets.
# Usage: apps/server/scripts/build-release.sh <version> [out-dir]
set -euo pipefail

version="${1:?usage: build-release.sh <version> [out-dir]}"
server_dir="$(cd "$(dirname "$0")/.." && pwd)"
out="$(mkdir -p "${2:-${server_dir}/release}" && cd "${2:-${server_dir}/release}" && pwd)"

# Windows is left out until the renderer worker and its process handling are tested there.
targets=(linux-x64 linux-arm64 darwin-x64 darwin-arm64)

work="$(mktemp -d)"
trap 'rm -rf "${work}"' EXIT

cd "${server_dir}"
for target in "${targets[@]}"; do
  echo "--- ${target}"
  mkdir -p "${work}/${target}"
  # Arguments after the script's own: the later --outfile wins, --target cross-compiles.
  bun run compile \
    --target="bun-${target}" \
    --define "BUNCRAWL_VERSION=\"${version}\"" \
    --outfile "${work}/${target}/buncrawl"
  tar -czf "${out}/buncrawl-${target}.tar.gz" -C "${work}/${target}" buncrawl
done

cd "${out}"
sha256sum buncrawl-*.tar.gz >SHA256SUMS
cat SHA256SUMS
