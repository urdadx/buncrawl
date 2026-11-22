#!/bin/sh
# Installs the buncrawl single-file binary from GitHub releases.
#
#   curl -fsSL https://raw.githubusercontent.com/urdadx/buncrawl/main/install.sh | sh
#
# BUNCRAWL_VERSION=v1.2.3   install that release instead of the latest
# BUNCRAWL_INSTALL_DIR=dir  where to put `buncrawl` (default: /usr/local/bin when writable, else
#                           ~/.local/bin); the script never uses sudo
# BUNCRAWL_RELEASES_URL=url download from a mirror laid out like a release (assets + SHA256SUMS)
set -eu

REPO="urdadx/buncrawl"

err() {
  printf 'buncrawl install: %s\n' "$*" >&2
  exit 1
}

download() {
  if command -v curl >/dev/null 2>&1; then
    curl --fail --location --silent --show-error --proto '=https,file' --output "$2" "$1"
  elif command -v wget >/dev/null 2>&1; then
    wget --quiet --output-document="$2" "$1"
  else
    err "curl or wget is required"
  fi
}

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d ' ' -f 1
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d ' ' -f 1
  else
    err "sha256sum or shasum is required to verify the download"
  fi
}

platform() {
  os="$(uname -s)"
  arch="$(uname -m)"
  case "$os" in
    Linux) os=linux ;;
    Darwin) os=darwin ;;
    *) err "unsupported OS: $os (Linux and macOS are supported)" ;;
  esac
  # An Intel shell under Rosetta on Apple Silicon: install the native build.
  if [ "$os" = darwin ] && [ "$arch" = x86_64 ] &&
    [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || true)" = 1 ]; then
    arch=arm64
  fi
  case "$arch" in
    x86_64 | amd64) arch=x64 ;;
    aarch64 | arm64) arch=arm64 ;;
    *) err "unsupported CPU: $arch (x86-64 and arm64 are supported)" ;;
  esac
  # The Linux builds link against glibc.
  if [ "$os" = linux ] && ldd --version 2>&1 | grep -qi musl; then
    err "musl-based Linux (e.g. Alpine) is not supported; use the Docker image instead"
  fi
  echo "$os-$arch"
}

main() {
  target="$(platform)"
  asset="buncrawl-$target.tar.gz"
  if [ -n "${BUNCRAWL_RELEASES_URL:-}" ]; then
    base="$BUNCRAWL_RELEASES_URL"
  elif [ -n "${BUNCRAWL_VERSION:-}" ]; then
    base="https://github.com/$REPO/releases/download/$BUNCRAWL_VERSION"
  else
    base="https://github.com/$REPO/releases/latest/download"
  fi

  if [ -n "${BUNCRAWL_INSTALL_DIR:-}" ]; then
    dir="$BUNCRAWL_INSTALL_DIR"
  elif [ -w /usr/local/bin ]; then
    dir=/usr/local/bin
  else
    dir="$HOME/.local/bin"
  fi

  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT

  echo "Downloading $asset (${BUNCRAWL_VERSION:-latest})..."
  download "$base/$asset" "$tmp/$asset"
  download "$base/SHA256SUMS" "$tmp/SHA256SUMS"
  expected="$(awk -v asset="$asset" '$2 == asset || $2 == "*" asset { print $1 }' "$tmp/SHA256SUMS")"
  [ -n "$expected" ] || err "SHA256SUMS has no entry for $asset"
  [ "$(sha256 "$tmp/$asset")" = "$expected" ] || err "checksum mismatch for $asset; not installing"

  tar -xzf "$tmp/$asset" -C "$tmp" buncrawl
  mkdir -p "$dir"
  # Replace atomically, so a running buncrawl keeps its file.
  mv -f "$tmp/buncrawl" "$dir/buncrawl.new"
  chmod 0755 "$dir/buncrawl.new"
  mv -f "$dir/buncrawl.new" "$dir/buncrawl"

  echo "Installed $("$dir/buncrawl" --version) to $dir/buncrawl"
  case ":$PATH:" in
    *":$dir:"*) ;;
    *) echo "Add $dir to your PATH to run it as \`buncrawl\`." ;;
  esac
  echo
  echo "  buncrawl https://example.com     scrape a page"
  echo "  buncrawl serve                   start the API server"
  echo
  echo "JavaScript rendering uses Chrome or Lightpanda when installed (or BUN_CHROME_PATH and"
  echo "BUNCRAWL_LIGHTPANDA_PATH); without them buncrawl scrapes over plain HTTP."
}

main "$@"
