#!/usr/bin/env bash

set -euo pipefail

# Change to repo root regardless of where this script is invoked from
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

echo "=============================================="
echo " Deep Student - One-click build (mac + iOS)"
echo " Repo: $REPO_ROOT"
echo "=============================================="

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This build script currently supports macOS only."
  exit 1
fi

ARCH="$(uname -m)"
echo "Host architecture: $ARCH"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1"
    exit 1
  fi
}

echo "\n[1/6] Checking prerequisites..."
require_cmd node
require_cmd npm
require_cmd rustup
require_cmd cargo
require_cmd xcrun
require_cmd xcodebuild

# Prefer local @tauri-apps/cli via npx to ensure correct version
TAURI_CLI="npx --yes @tauri-apps/cli@latest"

echo "\n[2/6] Installing Rust targets (if missing)..."
rustup target add aarch64-apple-darwin || true
rustup target add x86_64-apple-darwin || true
rustup target add aarch64-apple-ios || true
rustup target add x86_64-apple-ios || true
rustup target add aarch64-apple-ios-sim || true

echo "\n[3/6] Installing Node dependencies..."
if [[ ! -d node_modules ]]; then
  npm ci
else
  # If lockfile changed, this ensures consistency; otherwise it's a no-op
  npm ci
fi

if [[ -z "${SKIP_ICON_GENERATION:-}" ]]; then
  echo "\n[3.5/6] Generating icons..."
  if [[ ! -f "app-icon.png" ]]; then
    echo "[warn] app-icon.png not found, using existing icons"
  else
    npm run icons || echo "[warn] Icon generation failed, using existing icons"
  fi
else
  echo "[warn] Skip icon generation (SKIP_ICON_GENERATION=true)"
fi

echo "\n[3.8/6] Checking pdfium binaries..."
PDFIUM_DIR="src-tauri/resources/pdfium"
PDFIUM_OK=true
if [[ ! -f "$PDFIUM_DIR/libpdfium.dylib" ]]; then
  echo "[warn] Missing pdfium for macOS: $PDFIUM_DIR/libpdfium.dylib"
  PDFIUM_OK=false
fi
if [[ "$PDFIUM_OK" == "false" ]]; then
  echo "[info] Downloading missing pdfium binaries..."
  bash scripts/download-pdfium.sh "$(uname -m | sed 's/arm64/macos-arm64/' | sed 's/x86_64/macos-x64/')" || echo "[warn] pdfium download failed, PDF features may not work"
fi

echo "\n[4/6] Building frontend..."
npm run build

echo "\n[5/6] Building macOS installers (Apple Silicon + Intel)..."
echo " - Building for aarch64-apple-darwin (Apple Silicon)"
$TAURI_CLI build --ci --target aarch64-apple-darwin

echo " - Building for x86_64-apple-darwin (Intel)"
$TAURI_CLI build --ci --target x86_64-apple-darwin

echo "\nArtifacts (macOS) should be under:"
echo "  src-tauri/target/aarch64-apple-darwin/release/bundle/dmg/"
echo "  src-tauri/target/x86_64-apple-darwin/release/bundle/dmg/"

echo "\n[6/6] Building iOS/iPadOS (requires valid signing setup)..."

# Initialize iOS project if needed (non-interactive)
if [[ ! -d "src-tauri/gen/apple" ]]; then
  echo " - Initializing iOS project"
  $TAURI_CLI ios init --ci || true
fi

# Ensure iOS icons are prepared and build via existing npm script if present
if npm run | grep -q "build:ios"; then
  npm run build:ios
else
  # Fallback to direct CLI
  npx --yes @tauri-apps/cli@latest icon --output src-tauri/icons_ios_current app-icon.png || true
  $TAURI_CLI ios build --ci
fi

echo "\nArtifacts (iOS) are typically located under:"
echo "  src-tauri/gen/apple/ (Xcode project/workspace and build products)"
echo "  or as .ipa exported by the build command (check the tauri CLI output)."

echo "\n✅ All done."

