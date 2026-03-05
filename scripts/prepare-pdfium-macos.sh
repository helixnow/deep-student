#!/usr/bin/env bash
set -Eeuo pipefail

# Prepare correct macOS pdfium dylib for a specific Tauri target.
# Usage:
#   bash scripts/prepare-pdfium-macos.sh [target]
# target:
#   aarch64-apple-darwin | x86_64-apple-darwin | universal-apple-darwin

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PDFIUM_LIB="$REPO_ROOT/src-tauri/resources/pdfium/libpdfium.dylib"
DOWNLOAD_SCRIPT="$SCRIPT_DIR/download-pdfium.sh"

say() { echo "[pdfium-prepare] $*"; }
err() { echo "[pdfium-prepare][error] $*" >&2; }

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    err "Missing required command: $1"
    exit 1
  }
}

has_arch() {
  local lib="$1"
  local arch="$2"
  local info
  info="$(lipo -info "$lib" 2>/dev/null || true)"
  [[ "$info" == *"architecture: $arch"* || "$info" == *"are:"*" $arch"* ]]
}

download_single_arch() {
  local platform="$1"
  rm -f "$PDFIUM_LIB"
  bash "$DOWNLOAD_SCRIPT" "$platform"
  [[ -f "$PDFIUM_LIB" ]] || {
    err "Download succeeded but file missing: $PDFIUM_LIB"
    exit 1
  }
}

prepare_single_target() {
  local platform="$1"
  local expected_arch="$2"

  mkdir -p "$(dirname "$PDFIUM_LIB")"

  if [[ -f "$PDFIUM_LIB" ]] && has_arch "$PDFIUM_LIB" "$expected_arch"; then
    say "Using existing pdfium ($expected_arch): $(lipo -info "$PDFIUM_LIB")"
    return 0
  fi

  say "Preparing pdfium for $expected_arch via $platform"
  download_single_arch "$platform"

  if ! has_arch "$PDFIUM_LIB" "$expected_arch"; then
    err "Prepared pdfium does not contain arch '$expected_arch': $(lipo -info "$PDFIUM_LIB" || echo "unknown")"
    exit 1
  fi

  say "Ready: $(lipo -info "$PDFIUM_LIB")"
}

prepare_universal() {
  local tmp_dir
  local arm_lib
  local x64_lib

  mkdir -p "$(dirname "$PDFIUM_LIB")"

  if [[ -f "$PDFIUM_LIB" ]] && has_arch "$PDFIUM_LIB" "arm64" && has_arch "$PDFIUM_LIB" "x86_64"; then
    say "Using existing universal pdfium: $(lipo -info "$PDFIUM_LIB")"
    return 0
  fi

  tmp_dir="$(mktemp -d)"
  arm_lib="$tmp_dir/libpdfium_arm64.dylib"
  x64_lib="$tmp_dir/libpdfium_x64.dylib"
  trap 'rm -rf "$tmp_dir"' RETURN

  say "Preparing universal pdfium (arm64 + x86_64)"

  download_single_arch "macos-arm64"
  cp "$PDFIUM_LIB" "$arm_lib"

  download_single_arch "macos-x64"
  cp "$PDFIUM_LIB" "$x64_lib"

  lipo -create -output "$PDFIUM_LIB" "$arm_lib" "$x64_lib"

  if ! has_arch "$PDFIUM_LIB" "arm64" || ! has_arch "$PDFIUM_LIB" "x86_64"; then
    err "Universal pdfium verification failed: $(lipo -info "$PDFIUM_LIB" || echo "unknown")"
    exit 1
  fi

  say "Ready: $(lipo -info "$PDFIUM_LIB")"
}

main() {
  local target="${1:-}"

  require_cmd bash
  require_cmd lipo

  if [[ -z "$target" ]]; then
    case "$(uname -m)" in
      arm64) target="aarch64-apple-darwin" ;;
      x86_64) target="x86_64-apple-darwin" ;;
      *)
        err "Unable to infer target from host arch: $(uname -m)"
        exit 1
        ;;
    esac
  fi

  case "$target" in
    aarch64-apple-darwin)
      prepare_single_target "macos-arm64" "arm64"
      ;;
    x86_64-apple-darwin)
      prepare_single_target "macos-x64" "x86_64"
      ;;
    universal-apple-darwin)
      prepare_universal
      ;;
    *)
      err "Unsupported target: $target"
      err "Expected one of: aarch64-apple-darwin, x86_64-apple-darwin, universal-apple-darwin"
      exit 1
      ;;
  esac
}

main "$@"
