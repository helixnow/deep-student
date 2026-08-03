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

# 使用 package-lock.json 锁定的本地 @tauri-apps/cli（npm ci 后可用），
# 禁止 @latest 隐式漂移；--no-install 确保绝不临时拉取未锁定版本。
TAURI_CLI="npx --no-install tauri"

# ── 签名模式（显式，默认拒绝隐式未签名产物）─────────────────────────
# 生产签名: 设置 APPLE_SIGNING_IDENTITY（可选 APPLE_ID/APPLE_PASSWORD/
#           APPLE_TEAM_ID 以启用公证），tauri 会自动 codesign/公证。
# 显式未签名: DS_ALLOW_UNSIGNED=1 —— 仅限本地开发验证，产物带 ad-hoc
#           签名，不得分发。
if [[ -n "${APPLE_SIGNING_IDENTITY:-}" ]]; then
  echo "[sign] Production signing enabled (identity: ${APPLE_SIGNING_IDENTITY})"
  if [[ -n "${APPLE_ID:-}" && -n "${APPLE_PASSWORD:-}" && -n "${APPLE_TEAM_ID:-}" ]]; then
    echo "[sign] Notarization enabled (APPLE_ID/APPLE_PASSWORD/APPLE_TEAM_ID set)"
  else
    echo "[sign][warn] Notarization DISABLED (APPLE_ID/APPLE_PASSWORD/APPLE_TEAM_ID not fully set)"
  fi
elif [[ "${DS_ALLOW_UNSIGNED:-}" == "1" ]]; then
  echo "[sign][warn] UNSIGNED build explicitly requested (DS_ALLOW_UNSIGNED=1)."
  echo "[sign][warn] Artifacts will be ad-hoc signed and MUST NOT be distributed."
else
  echo "[error] No signing configuration."
  echo "  - For production builds: export APPLE_SIGNING_IDENTITY (plus APPLE_ID/APPLE_PASSWORD/APPLE_TEAM_ID for notarization)."
  echo "  - For local unsigned builds: rerun with DS_ALLOW_UNSIGNED=1."
  echo "  Official releases are built and signed by .github/workflows/release.yml."
  exit 1
fi

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
  if [[ ! -f "public/app-icon.png" ]]; then
    echo "[warn] public/app-icon.png not found, using existing icons"
  else
    npm run icons || echo "[warn] Icon generation failed, using existing icons"
  fi
else
  echo "[warn] Skip icon generation (SKIP_ICON_GENERATION=true)"
fi

echo "\n[3.8/6] Checking pdfium binaries..."
if [[ ! -x "scripts/prepare-pdfium-macos.sh" || ! -x "scripts/verify-macos-pdfium-bundle.sh" ]]; then
  echo "[error] Missing helper scripts: scripts/prepare-pdfium-macos.sh or scripts/verify-macos-pdfium-bundle.sh"
  exit 1
fi
echo "[info] pdfium arch will be prepared per target before each macOS build."

echo "\n[4/6] Building frontend..."
npm run build

echo "\n[5/6] Building macOS installers (Apple Silicon + Intel)..."
for TARGET in aarch64-apple-darwin x86_64-apple-darwin; do
  echo " - Preparing pdfium for ${TARGET}"
  bash scripts/prepare-pdfium-macos.sh "$TARGET"

  echo " - Building for ${TARGET}"
  $TAURI_CLI build --ci --target "$TARGET"

  echo " - Verifying bundled pdfium for ${TARGET}"
  bash scripts/verify-macos-pdfium-bundle.sh "$TARGET"
done

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
  # Fallback to direct CLI (locked local version, no implicit @latest)
  $TAURI_CLI icon --output src-tauri/icons_ios_current public/app-icon.png || true
  $TAURI_CLI ios build --ci
fi

echo "\nArtifacts (iOS) are typically located under:"
echo "  src-tauri/gen/apple/ (Xcode project/workspace and build products)"
echo "  or as .ipa exported by the build command (check the tauri CLI output)."

echo "\n✅ All done."
