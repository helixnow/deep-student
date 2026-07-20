#!/usr/bin/env bash
# Verify that the tag version matches the three version declarations in the
# checked-out tree (package.json / src-tauri/Cargo.toml / src-tauri/tauri.conf.json).
#
# Usage:
#   bash scripts/ci/verify-version-consistency.sh <tag_name>   # e.g. v0.9.42
#
# Single source of truth for the "版本号三重校验" that used to be copy-pasted
# across release.yml / rebuild-release.yml / hotfix-linux-release.yml.
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 <tag_name>" >&2
  exit 2
fi

TAG_NAME="$1"
if [[ ! "${TAG_NAME}" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "::error::Invalid tag format: '${TAG_NAME}'. Expected format like v0.9.30"
  exit 1
fi
TAG_VERSION="${TAG_NAME#v}"

PKG_VERSION=$(jq -r '.version' package.json)
# 结尾分号兼容 BSD sed（本地 macOS）与 GNU sed（CI）
CARGO_VERSION=$(sed -n '/^\[package\]/,/^\[/{s/^version *= *"\(.*\)"/\1/p;}' src-tauri/Cargo.toml)
TAURI_VERSION=$(jq -r '.version' src-tauri/tauri.conf.json)

echo "══════════════════════════════════════"
echo "  Tag version:       ${TAG_VERSION}"
echo "  package.json:      ${PKG_VERSION}"
echo "  Cargo.toml:        ${CARGO_VERSION}"
echo "  tauri.conf.json:   ${TAURI_VERSION}"
echo "══════════════════════════════════════"

ERRORS=0

if [[ "${PKG_VERSION}" != "${TAG_VERSION}" ]]; then
  echo "::error::package.json version (${PKG_VERSION}) does not match tag (${TAG_VERSION})"
  ERRORS=$((ERRORS + 1))
fi

if [[ "${CARGO_VERSION}" != "${TAG_VERSION}" ]]; then
  echo "::error::Cargo.toml version (${CARGO_VERSION}) does not match tag (${TAG_VERSION})"
  ERRORS=$((ERRORS + 1))
fi

if [[ "${TAURI_VERSION}" != "${TAG_VERSION}" ]]; then
  echo "::error::tauri.conf.json version (${TAURI_VERSION}) does not match tag (${TAG_VERSION})"
  ERRORS=$((ERRORS + 1))
fi

if [[ $ERRORS -gt 0 ]]; then
  echo "::error::Version mismatch detected! ${ERRORS} file(s) have inconsistent versions."
  exit 1
fi

echo "✅ All version numbers are consistent: ${TAG_VERSION}"
