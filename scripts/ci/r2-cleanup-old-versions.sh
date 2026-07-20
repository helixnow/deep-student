#!/usr/bin/env bash
# Delete R2 objects belonging to releases older than the newest KEEP_VERSIONS
# GitHub releases. Shared by release/rebuild publish and the manual R2 sync.
#
# Env:
#   GH_TOKEN                 (required, for gh api)
#   GITHUB_REPOSITORY        (required, owner/repo)
#   CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN  (required by wrangler)
#   R2_BUCKET                (default: deepstudent)
#   KEEP_VERSIONS            (default: 10)
#   WRANGLER_VERSION         (pinned wrangler version; default below)
set -euo pipefail

R2_BUCKET="${R2_BUCKET:-deepstudent}"
KEEP_VERSIONS="${KEEP_VERSIONS:-10}"
# 固定 wrangler 版本, 禁止隐式 latest 漂移（与 r2-put.sh 保持一致）
WRANGLER_SPEC="wrangler@${WRANGLER_VERSION:-4.112.0}"

echo "🧹 Checking for old versions to clean up..."
RELEASES=$(gh api "repos/${GITHUB_REPOSITORY}/releases" --paginate -q '.[].tag_name')
TOTAL=$(echo "$RELEASES" | grep -c . || true)
echo "Found ${TOTAL} releases"

if [[ "$TOTAL" -le "$KEEP_VERSIONS" ]]; then
  echo "✅ No cleanup needed (${TOTAL} ≤ ${KEEP_VERSIONS})"
  exit 0
fi

TO_DELETE=$(echo "$RELEASES" | tail -n +$((KEEP_VERSIONS + 1)))
echo "🗑️ Deleting $(echo "$TO_DELETE" | grep -c . || true) old versions from R2"
echo "$TO_DELETE" | while read -r OLD_TAG; do
  [[ -z "$OLD_TAG" ]] && continue
  echo "  Removing releases/${OLD_TAG}/..."
  ASSETS=$(gh api "repos/${GITHUB_REPOSITORY}/releases/tags/${OLD_TAG}" \
    -q '.assets[].name' 2>/dev/null || true)
  echo "$ASSETS" | while read -r NAME; do
    [[ -z "$NAME" ]] && continue
    npx --yes "$WRANGLER_SPEC" r2 object delete "${R2_BUCKET}/releases/${OLD_TAG}/${NAME}" --remote 2>/dev/null || true
  done
done
echo "✅ R2 cleanup complete"
