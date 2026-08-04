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
WRANGLER_MAX_UPLOAD_SIZE=$((300 * 1024 * 1024))

if [[ ! -f "$FILE_PATH" ]]; then
  echo "::error::r2-put: file not found: $FILE_PATH" >&2
  exit 1
fi

upload_large_object() {
  local bucket="${OBJECT_KEY%%/*}"
  local key="${OBJECT_KEY#*/}"
  local verify_response
  local parent_access_key_id
  local credential_request
  local credential_response
  local access_key_id
  local secret_access_key
  local session_token

  for command in curl jq aws; do
    if ! command -v "$command" >/dev/null 2>&1; then
      echo "::error::r2-put: ${command} is required for multipart uploads" >&2
      return 1
    fi
  done

  verify_response=$(curl --fail --silent --show-error \
    "https://api.cloudflare.com/client/v4/user/tokens/verify" \
    --header "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}") || return 1
  parent_access_key_id=$(jq -er '
    select(.success == true)
    | .result
    | select(.status == "active")
    | .id
  ' <<<"$verify_response") || {
    echo "::error::r2-put: unable to resolve active Cloudflare token ID" >&2
    return 1
  }

  credential_request=$(jq -nc \
    --arg bucket "$bucket" \
    --arg parent_access_key_id "$parent_access_key_id" \
    --arg key "$key" \
    '{
      bucket: $bucket,
      parentAccessKeyId: $parent_access_key_id,
      permission: "object-read-write",
      ttlSeconds: 3600,
      objects: [$key]
    }')
  credential_response=$(curl --fail --silent --show-error \
    --request POST \
    "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/r2/temp-access-credentials" \
    --header "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
    --header "Content-Type: application/json" \
    --data "$credential_request") || return 1

  access_key_id=$(jq -er 'select(.success == true) | .result.accessKeyId' \
    <<<"$credential_response") || return 1
  secret_access_key=$(jq -er 'select(.success == true) | .result.secretAccessKey' \
    <<<"$credential_response") || return 1
  session_token=$(jq -er 'select(.success == true) | .result.sessionToken' \
    <<<"$credential_response") || return 1

  echo "Multipart upload via R2 S3 API: $(basename "$FILE_PATH")"
  AWS_ACCESS_KEY_ID="$access_key_id" \
  AWS_SECRET_ACCESS_KEY="$secret_access_key" \
  AWS_SESSION_TOKEN="$session_token" \
  AWS_DEFAULT_REGION="auto" \
    aws s3 cp "$FILE_PATH" "s3://${bucket}/${key}" \
      --endpoint-url "https://${CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com" \
      --content-type "$CONTENT_TYPE" \
      --cache-control "$CACHE_CONTROL" \
      --only-show-errors
}

FILE_SIZE=$(wc -c <"$FILE_PATH" | tr -d ' ')
attempt=1
while [[ "$attempt" -le "$MAX_RETRIES" ]]; do
  if [[ "$FILE_SIZE" -gt "$WRANGLER_MAX_UPLOAD_SIZE" ]]; then
    if upload_large_object; then
      exit 0
    fi
  else
    if npx --yes "$WRANGLER_SPEC" r2 object put "$OBJECT_KEY" \
      --file "$FILE_PATH" --content-type "$CONTENT_TYPE" \
      --cache-control "$CACHE_CONTROL" --remote; then
      exit 0
    fi
  fi
  echo "::warning::r2-put attempt ${attempt}/${MAX_RETRIES} failed: $(basename "$FILE_PATH")"
  if [[ "$attempt" -lt "$MAX_RETRIES" ]]; then
    sleep "$RETRY_DELAY"
  fi
  attempt=$((attempt + 1))
done

echo "::error::r2-put failed after ${MAX_RETRIES} attempts: ${OBJECT_KEY}" >&2
exit 1
