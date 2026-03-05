#!/usr/bin/env bash
set -Eeuo pipefail

# Verify bundled macOS app contains libpdfium.dylib with expected architecture(s).
# Usage:
#   bash scripts/verify-macos-pdfium-bundle.sh <target>
# target:
#   aarch64-apple-darwin | x86_64-apple-darwin | universal-apple-darwin

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

say() { echo "[pdfium-verify] $*"; }
err() { echo "[pdfium-verify][error] $*" >&2; }

has_arch() {
  local lib="$1"
  local arch="$2"
  local info
  info="$(lipo -info "$lib" 2>/dev/null || true)"
  [[ "$info" == *"architecture: $arch"* || "$info" == *"are:"*" $arch"* ]]
}

main() {
  local target="${1:-}"
  local app_dir
  local lib_path

  if [[ -z "$target" ]]; then
    err "Usage: bash scripts/verify-macos-pdfium-bundle.sh <target>"
    exit 1
  fi

  app_dir="$(find "$REPO_ROOT/src-tauri/target/$target/release/bundle/macos" -maxdepth 1 -type d -name '*.app' | head -n 1)"
  [[ -n "$app_dir" ]] || {
    err "No .app found for target: $target"
    exit 1
  }

  lib_path="$app_dir/Contents/Resources/libpdfium.dylib"
  [[ -f "$lib_path" ]] || {
    err "Missing bundled pdfium: $lib_path"
    exit 1
  }

  case "$target" in
    aarch64-apple-darwin)
      has_arch "$lib_path" "arm64" || {
        err "Bundled libpdfium.dylib missing arm64: $(lipo -info "$lib_path" || echo "unknown")"
        exit 1
      }
      ;;
    x86_64-apple-darwin)
      has_arch "$lib_path" "x86_64" || {
        err "Bundled libpdfium.dylib missing x86_64: $(lipo -info "$lib_path" || echo "unknown")"
        exit 1
      }
      ;;
    universal-apple-darwin)
      has_arch "$lib_path" "arm64" || {
        err "Bundled universal lib missing arm64: $(lipo -info "$lib_path" || echo "unknown")"
        exit 1
      }
      has_arch "$lib_path" "x86_64" || {
        err "Bundled universal lib missing x86_64: $(lipo -info "$lib_path" || echo "unknown")"
        exit 1
      }
      ;;
    *)
      err "Unsupported target: $target"
      exit 1
      ;;
  esac

  say "OK: $lib_path"
  say "$(lipo -info "$lib_path")"
}

main "$@"
