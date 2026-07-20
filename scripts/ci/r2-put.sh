#!/usr/bin/env bash
# Upload a single object to Cloudflare R2 with retries.
#
# Usage:
#   bash scripts/ci/r2-put.sh <object_key> <file_path> <content_type> <cache_control>
#
# Env:
#   CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN  (required by wrangler)
#   R2_MAX_RETRIES  (default 3)
#   R2_RETRY_DELAY  (seconds between attempts, default 3)
#   WRANGLER_VERSION (pinned wrangler version; default below — never latest)
#
# This is the single source of truth for the retry logic that used to be
# copy-pasted as `upload_with_retry` across release/rebuild/hotfix workflows.
set -euo pipefail

# 固定 wrangler 版本, 禁止隐式 latest 漂移（升级需显式改默认值或传 env）
WRANGLER_SPEC="wrangler@${WRANGLER_VERSION:-4.112.0}"

if [[ $# -ne 4 ]]; then
  echo "usage: $0 <object_key> <file_path> <content_type> <cache_control>" >&2
  exit 2
fi

OBJECT_KEY="$1"
FILE_PATH="$2"
CONTENT_TYPE="$3"
CACHE_CONTROL="$4"

MAX_RETRIES="${R2_MAX_RETRIES:-3}"
RETRY_DELAY="${R2_RETRY_DELAY:-3}"

if [[ ! -f "$FILE_PATH" ]]; then
  echo "::error::r2-put: file not found: $FILE_PATH" >&2
  exit 1
fi

attempt=1
while [[ "$attempt" -le "$MAX_RETRIES" ]]; do
  if npx --yes "$WRANGLER_SPEC" r2 object put "$OBJECT_KEY" \
    --file "$FILE_PATH" --content-type "$CONTENT_TYPE" \
    --cache-control "$CACHE_CONTROL" --remote; then
    exit 0
  fi
  echo "::warning::r2-put attempt ${attempt}/${MAX_RETRIES} failed: $(basename "$FILE_PATH")"
  if [[ "$attempt" -lt "$MAX_RETRIES" ]]; then
    sleep "$RETRY_DELAY"
  fi
  attempt=$((attempt + 1))
done

echo "::error::r2-put failed after ${MAX_RETRIES} attempts: ${OBJECT_KEY}" >&2
exit 1
