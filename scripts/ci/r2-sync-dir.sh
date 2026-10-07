#!/usr/bin/env bash
# Upload a whole directory to Cloudflare R2 under a key prefix (used for the web demo build).
#
# Usage:
#   bash scripts/ci/r2-sync-dir.sh <local_dir> <bucket>/<prefix>
#
# Env:
#   CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN  (required)
#
# Uses short-lived R2 credentials scoped to <prefix> (same Cloudflare API flow as the
# multipart path in r2-put.sh) and `aws s3 cp --recursive`, which uploads in parallel —
# wrangler puts one object per process and would take tens of minutes for ~1300 files.
#
# Content types are set explicitly for the extensions browsers are strict about
# (module scripts, wasm); hashed files under assets/ get a one-year immutable cache.
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: $0 <local_dir> <bucket>/<prefix>" >&2
  exit 2
fi

LOCAL_DIR="${1%/}"
TARGET="${2%/}"
BUCKET="${TARGET%%/*}"
PREFIX="${TARGET#*/}"

for command in curl jq aws; do
  command -v "$command" >/dev/null 2>&1 || { echo "::error::r2-sync-dir: ${command} is required" >&2; exit 1; }
done
[[ -d "$LOCAL_DIR" ]] || { echo "::error::r2-sync-dir: no such directory: $LOCAL_DIR" >&2; exit 1; }

verify_response=$(curl --fail --silent --show-error \
  "https://api.cloudflare.com/client/v4/user/tokens/verify" \
  --header "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}")
parent_access_key_id=$(jq -er 'select(.success == true) | .result | select(.status == "active") | .id' <<<"$verify_response")

credential_request=$(jq -nc \
  --arg bucket "$BUCKET" \
  --arg parent "$parent_access_key_id" \
  --arg prefix "${PREFIX}/" \
  '{bucket: $bucket, parentAccessKeyId: $parent, permission: "object-read-write", ttlSeconds: 3600, prefixes: [$prefix]}')
credential_response=$(curl --fail --silent --show-error --request POST \
  "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/r2/temp-access-credentials" \
  --header "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
  --header "Content-Type: application/json" \
  --data "$credential_request")

export AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN
AWS_ACCESS_KEY_ID=$(jq -er 'select(.success == true) | .result.accessKeyId' <<<"$credential_response")
AWS_SECRET_ACCESS_KEY=$(jq -er 'select(.success == true) | .result.secretAccessKey' <<<"$credential_response")
AWS_SESSION_TOKEN=$(jq -er 'select(.success == true) | .result.sessionToken' <<<"$credential_response")
export AWS_DEFAULT_REGION=auto
ENDPOINT="https://${CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com"
DEST="s3://${BUCKET}/${PREFIX}"

cp_group() {
  # $1 cache-control, $2 content-type ("" = guess from extension), rest: aws filters
  local cache="$1" type="$2"
  shift 2
  local args=(s3 cp "$LOCAL_DIR" "$DEST" --recursive --endpoint-url "$ENDPOINT" --only-show-errors
    --cache-control "$cache" --exclude '*' "$@")
  [[ -n "$type" ]] && args+=(--content-type "$type")
  aws "${args[@]}"
}

IMMUTABLE='public, max-age=31536000, immutable'
SHORT='public, max-age=600'

cp_group "$IMMUTABLE" 'text/javascript; charset=utf-8' --include 'assets/*.js' --include 'assets/*.mjs'
cp_group "$IMMUTABLE" 'text/css; charset=utf-8' --include 'assets/*.css'
cp_group "$IMMUTABLE" '' --include 'assets/*' --exclude 'assets/*.js' --exclude 'assets/*.mjs' --exclude 'assets/*.css'
cp_group "$SHORT" 'text/javascript; charset=utf-8' --include '*.mjs' --include '*.js' --exclude 'assets/*'
cp_group "$SHORT" 'application/wasm' --include '*.wasm' --exclude 'assets/*'
cp_group "$SHORT" 'text/html; charset=utf-8' --include '*.html' --exclude 'assets/*'
# manifest.json last: a reader that sees it can fetch every file it lists
cp_group "$SHORT" '' --include '*' --exclude 'assets/*' --exclude '*.js' --exclude '*.mjs' --exclude '*.wasm' \
  --exclude '*.html' --exclude 'manifest.json'
cp_group "$SHORT" 'application/json; charset=utf-8' --include 'manifest.json'

echo "✅ uploaded $(find "$LOCAL_DIR" -type f | wc -l | tr -d ' ') files to ${TARGET}/"
