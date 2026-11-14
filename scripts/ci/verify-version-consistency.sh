#!/usr/bin/env bash
# Verify that the tag version matches the tracked version declarations in the
# checked-out Node/Electron tree (package.json, package-lock.json, resources/app/tauri.conf.json).
#
# Usage:
#   bash scripts/ci/verify-version-consistency.sh <tag_name>   # e.g. v0.20.0
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 <tag_name>" >&2
  exit 2
fi

TAG_NAME="$1"
if [[ ! "${TAG_NAME}" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "::error::Invalid tag format: '${TAG_NAME}'. Expected format like v0.20.0"
  exit 1
fi
TAG_VERSION="${TAG_NAME#v}"

PKG_VERSION=$(jq -r '.version' package.json)
LOCK_VERSION=$(jq -r '.version' package-lock.json)
LOCK_ROOT_VERSION=$(jq -r '.packages[""].version // empty' package-lock.json)
TAURI_VERSION=$(jq -r '.version' resources/app/tauri.conf.json)

echo "═════════════════════════════════════════════"
echo "  Tag version:             ${TAG_VERSION}"
echo "  package.json:            ${PKG_VERSION}"
echo "  package-lock.json:       ${LOCK_VERSION} (root: ${LOCK_ROOT_VERSION})"
echo "  resources/app/tauri.conf:${TAURI_VERSION}"
echo "═════════════════════════════════════════════"

ERRORS=0

if [[ "${PKG_VERSION}" != "${TAG_VERSION}" ]]; then
  echo "::error::package.json version (${PKG_VERSION}) does not match tag (${TAG_VERSION})"
  ERRORS=$((ERRORS + 1))
fi

if [[ "${LOCK_VERSION}" != "${TAG_VERSION}" || "${LOCK_ROOT_VERSION}" != "${TAG_VERSION}" ]]; then
  echo "::error::package-lock.json version (${LOCK_VERSION}/${LOCK_ROOT_VERSION}) does not match tag (${TAG_VERSION})"
  ERRORS=$((ERRORS + 1))
fi

if [[ "${TAURI_VERSION}" != "${TAG_VERSION}" ]]; then
  echo "::error::resources/app/tauri.conf.json version (${TAURI_VERSION}) does not match tag (${TAG_VERSION})"
  ERRORS=$((ERRORS + 1))
fi

if [[ $ERRORS -gt 0 ]]; then
  echo "::error::Version mismatch detected! ${ERRORS} file(s) have inconsistent versions."
  exit 1
fi

echo "✅ All version numbers are consistent: ${TAG_VERSION}"
