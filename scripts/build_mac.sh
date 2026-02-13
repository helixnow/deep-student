#!/usr/bin/env bash
set -Eeuo pipefail

# One-click build, sign, notarize (and staple) for macOS Tauri app
# Usage:
#   bash ./scripts/build_mac.sh
# Optional env vars:
#   APPLE_SIGNING_IDENTITY  # e.g. "Developer ID Application: Your Name (TEAMID)"
#   APPLE_TEAM_ID           # Your Apple Team ID (used for notarytool when not using keychain profile)
#   APPLE_ID                # Apple ID email (if not using keychain profile)
#   APPLE_PASSWORD          # App-specific password for Apple ID (if not using keychain profile)
#   APPLE_NOTARIZE_KEYCHAIN_PROFILE  # notarytool stored profile name (recommended)
#   SKIP_BUILD=true         # set to skip npm/tauri build if artifacts already exist

# 默认使用已配置的 keychain profile
: "${APPLE_NOTARIZE_KEYCHAIN_PROFILE:=DeepStudent-Notary}"

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/.." && pwd)

say() { echo -e "\033[1;32m==>\033[0m $*"; }
warn() { echo -e "\033[1;33m[warn]\033[0m $*"; }
die() { echo -e "\033[1;31m[error]\033[0m $*" >&2; exit 1; }

require_cmd() { command -v "$1" >/dev/null 2>&1 || die "Missing command: $1"; }

require_cmd npm
require_cmd xcrun
require_cmd codesign
require_cmd spctl

cd "$REPO_ROOT"

if [[ -z "${SKIP_BUILD:-}" ]]; then
  if [[ -z "${SKIP_ICON_GENERATION:-}" ]]; then
    if [[ ! -f "app-icon.png" ]]; then
      warn "未找到 app-icon.png，将使用现有图标"
    else
      say "Generating icons (tauri icon)..."
      npm run icons || warn "图标生成失败，将使用现有图标"
      say "✓ 图标生成完成"
    fi
  else
    warn "跳过图标生成（SKIP_ICON_GENERATION=true）"
  fi
  say "Generating version info..."
  node scripts/generate-version.mjs || die "Failed to generate version info"
  say "Building frontend (npm run build)"
  npm run build
  
  # 检查并安装通用二进制所需的 Rust 目标
  say "Checking Rust targets for Universal Binary..."
  if ! rustup target list --installed | grep -q "x86_64-apple-darwin"; then
    say "Installing x86_64-apple-darwin target..."
    rustup target add x86_64-apple-darwin
  fi
  if ! rustup target list --installed | grep -q "aarch64-apple-darwin"; then
    say "Installing aarch64-apple-darwin target..."
    rustup target add aarch64-apple-darwin
  fi
  
  # 修复 CI 环境变量兼容性问题（新版 Tauri CLI 不接受 CI=1）
  unset CI
  
  say "Building Tauri app (Universal Binary for Intel + Apple Silicon)"
  npm run tauri build -- --target universal-apple-darwin
else
  warn "Skipping build as SKIP_BUILD is set"
fi

# Locate artifacts (prefer latest under generic release path)
choose_latest() {
  local latest=""
  local latest_m=0
  for p in "$@"; do
    [[ -e "$p" ]] || continue
    local m
    m=$(stat -f %m "$p" 2>/dev/null || echo 0)
    if (( m > latest_m )); then
      latest="$p"
      latest_m=$m
    fi
  done
  echo "$latest"
}

shopt -s nullglob
# 优先查找通用二进制路径，然后是普通 release 路径
apps_universal=(src-tauri/target/universal-apple-darwin/release/bundle/macos/*.app)
dmgs_universal=(src-tauri/target/universal-apple-darwin/release/bundle/dmg/*.dmg)
apps_generic=(src-tauri/target/release/bundle/macos/*.app)
dmgs_generic=(src-tauri/target/release/bundle/dmg/*.dmg)
shopt -u nullglob

APP_PATH=""
DMG_PATH=""

# 优先使用通用二进制产物
if (( ${#apps_universal[@]} )); then
  APP_PATH=$(choose_latest "${apps_universal[@]}")
elif (( ${#apps_generic[@]} )); then
  APP_PATH=$(choose_latest "${apps_generic[@]}")
fi
if (( ${#dmgs_universal[@]} )); then
  DMG_PATH=$(choose_latest "${dmgs_universal[@]}")
elif (( ${#dmgs_generic[@]} )); then
  DMG_PATH=$(choose_latest "${dmgs_generic[@]}")
fi

if [[ -z "$APP_PATH" ]]; then
  mapfile -t apps_all < <(find "src-tauri/target" -type d -path "*/bundle/macos/*.app" -print 2>/dev/null || true)
  APP_PATH=$(choose_latest "${apps_all[@]}")
fi
if [[ -z "$DMG_PATH" ]]; then
  mapfile -t dmgs_all < <(find "src-tauri/target" -type f -path "*/bundle/dmg/*.dmg" -print 2>/dev/null || true)
  DMG_PATH=$(choose_latest "${dmgs_all[@]}")
fi

[[ -n "$APP_PATH" ]] || die "Could not find .app under src-tauri/target/**/bundle/macos. Build may have failed."

say "Found app: $APP_PATH"
if [[ -n "$DMG_PATH" ]]; then
  say "Found dmg: $DMG_PATH"
else
  warn "No DMG found. Will notarize the .app directly."
fi

# Determine signing identity
IDENTITY="${APPLE_SIGNING_IDENTITY:-}"
if [[ -z "$IDENTITY" ]]; then
  say "Searching for Developer ID Application identity in keychain"
  # Pick the first Developer ID Application identity; if APPLE_TEAM_ID provided, prefer matching one
  if [[ -n "${APPLE_TEAM_ID:-}" ]]; then
    IDENTITY=$(security find-identity -p codesigning -v 2>/dev/null | grep "Developer ID Application:" | grep "(${APPLE_TEAM_ID})" | head -n1 | sed -E 's/.*"(.+)"/\1/') || true
  fi
  if [[ -z "$IDENTITY" ]]; then
    IDENTITY=$(security find-identity -p codesigning -v 2>/dev/null | grep "Developer ID Application:" | head -n1 | sed -E 's/.*"(.+)"/\1/') || true
  fi
fi
[[ -n "$IDENTITY" ]] || die "No 'Developer ID Application' identity found. Install it or set APPLE_SIGNING_IDENTITY."

say "Using signing identity: $IDENTITY"

# Sign the app with Hardened Runtime
say "Codesigning .app with Hardened Runtime"
set +e
codesign --force --deep --options runtime --timestamp \
  --sign "$IDENTITY" \
  "$APP_PATH"
CS_STATUS=$?
set -e
if [[ $CS_STATUS -ne 0 ]]; then
  warn "Timestamp service unavailable or codesign failed with --timestamp. Retrying with --timestamp=none."
  codesign --force --deep --options runtime --timestamp=none \
    --sign "$IDENTITY" \
    "$APP_PATH"
fi

say "Verifying codesign"
codesign --verify --deep --strict --verbose=2 "$APP_PATH"
spctl --assess --type execute -v "$APP_PATH" || true

# Prepare notarization target
TARGET_FOR_NOTARIZE="$APP_PATH"
if [[ -n "$DMG_PATH" ]]; then
  TARGET_FOR_NOTARIZE="$DMG_PATH"
fi

say "Will notarize: $TARGET_FOR_NOTARIZE"

# Notarize (prefer keychain profile)
NOTARY_ARGS=(submit "$TARGET_FOR_NOTARIZE" --wait)
if [[ -n "${APPLE_NOTARIZE_KEYCHAIN_PROFILE:-}" ]]; then
  NOTARY_ARGS+=(--keychain-profile "${APPLE_NOTARIZE_KEYCHAIN_PROFILE}")
else
  [[ -n "${APPLE_ID:-}" ]] || die "APPLE_ID not set and no keychain profile provided"
  [[ -n "${APPLE_PASSWORD:-}" ]] || die "APPLE_PASSWORD (app-specific) not set and no keychain profile provided"
  [[ -n "${APPLE_TEAM_ID:-}" ]] || die "APPLE_TEAM_ID not set and no keychain profile provided"
  NOTARY_ARGS+=(--apple-id "${APPLE_ID}" --password "${APPLE_PASSWORD}" --team-id "${APPLE_TEAM_ID}")
fi

say "Submitting for notarization"
xcrun notarytool "${NOTARY_ARGS[@]}"

say "Stapling ticket"
xcrun stapler staple "$TARGET_FOR_NOTARIZE"
xcrun stapler validate "$TARGET_FOR_NOTARIZE" || true

# Final assessment for .app if notarized app
if [[ "$TARGET_FOR_NOTARIZE" == *.app ]]; then
  spctl --assess --type execute -v "$TARGET_FOR_NOTARIZE" || true
fi

say "All done. Distributable file: $TARGET_FOR_NOTARIZE"

# 生成更新清单 (如果设置了签名密钥)
if [[ -n "${TAURI_SIGNING_PRIVATE_KEY:-}${TAURI_SIGNING_PRIVATE_KEY_PATH:-}" ]]; then
  say "Generating update manifest (latest.json)..."
  node "$SCRIPT_DIR/generate-update-manifest.mjs" || warn "更新清单生成失败，请手动运行: node scripts/generate-update-manifest.mjs"
else
  warn "未设置 TAURI_SIGNING_PRIVATE_KEY，跳过更新清单生成"
  warn "如需生成，请设置签名环境变量后运行: node scripts/generate-update-manifest.mjs"
fi
