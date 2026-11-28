#!/usr/bin/env bash
# Upload all release deliverables in a local directory to Cloudflare R2 under
# `<bucket>/<prefix>/<filename>` in parallel using short-lived R2 S3 credentials.
# Skips `latest.json` (which is generated and uploaded separately after publish).
#
# Usage:
#   bash scripts/ci/r2-upload-release.sh <local_dir> <bucket>/<prefix>
#
# Env:
#   CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN  (required)
#   R2_MAX_PARALLEL  (default: 4)
#   R2_MAX_RETRIES   (default: 3)
#   R2_RETRY_DELAY   (default: 3)
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: $0 <local_dir> <bucket>/<prefix>" >&2
  exit 2
fi

LOCAL_DIR="${1%/}"
TARGET="${2%/}"
BUCKET="${TARGET%%/*}"
PREFIX="${TARGET#*/}"
MAX_PARALLEL="${R2_MAX_PARALLEL:-4}"
MAX_RETRIES="${R2_MAX_RETRIES:-3}"
RETRY_DELAY="${R2_RETRY_DELAY:-3}"
CACHE_CONTROL="public, max-age=31536000, immutable"

for command in curl jq aws; do
  command -v "$command" >/dev/null 2>&1 || {
    echo "::error::r2-upload-release: ${command} is required" >&2
    exit 1
  }
done
[[ -d "$LOCAL_DIR" ]] || { echo "::error::r2-upload-release: no such directory: $LOCAL_DIR" >&2; exit 1; }

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
# AWS CLI v2.23+ defaults to trailing CRC32 checksums which Cloudflare R2 rejects on PutObject/UploadPart.
export AWS_REQUEST_CHECKSUM_CALCULATION=when_required
export AWS_RESPONSE_CHECKSUM_VALIDATION=when_required
ENDPOINT="https://${CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com"

upload_one() {
  local file="$1"
  local name
  name=$(basename "$file")
  local ct
  case "$name" in
    *.sig)  ct="application/pgp-signature" ;;
    *.dmg)  ct="application/x-apple-diskimage" ;;
    *.deb)  ct="application/vnd.debian.binary-package" ;;
    *.apk)  ct="application/vnd.android.package-archive" ;;
    *)      ct="application/octet-stream" ;;
  esac

  local attempt=1
  while [[ "$attempt" -le "$MAX_RETRIES" ]]; do
    if aws s3 cp "$file" "s3://${BUCKET}/${PREFIX}/${name}" \
      --endpoint-url "$ENDPOINT" \
      --content-type "$ct" \
      --cache-control "$CACHE_CONTROL" \
      --only-show-errors; then
      echo "Uploaded ${name}"
      return 0
    fi
    echo "::warning::r2-upload-release attempt ${attempt}/${MAX_RETRIES} failed: ${name}" >&2
    if [[ "$attempt" -lt "$MAX_RETRIES" ]]; then
      sleep "$RETRY_DELAY"
    fi
    attempt=$((attempt + 1))
  done
  echo "::error::r2-upload-release failed after ${MAX_RETRIES} attempts: ${name}" >&2
  return 1
}

FILES=()
for f in "${LOCAL_DIR}"/*; do
  [[ -f "$f" ]] || continue
  [[ "$(basename "$f")" == "latest.json" ]] && continue
  FILES+=("$f")
done

if [[ "${#FILES[@]}" -eq 0 ]]; then
  echo "::error::r2-upload-release: no uploadable files found in ${LOCAL_DIR}" >&2
  exit 1
fi

echo "Uploading ${#FILES[@]} release asset(s) to ${BUCKET}/${PREFIX}/ (parallelism=${MAX_PARALLEL})..."
PIDS=()
FAILED=0
for f in "${FILES[@]}"; do
  upload_one "$f" &
  PIDS+=("$!")
  if [[ "${#PIDS[@]}" -ge "$MAX_PARALLEL" ]]; then
    if ! wait "${PIDS[0]}"; then
      FAILED=1
    fi
    PIDS=("${PIDS[@]:1}")
  fi
done

for pid in "${PIDS[@]}"; do
  if ! wait "$pid"; then
    FAILED=1
  fi
done

if [[ "$FAILED" -ne 0 ]]; then
  echo "::error::One or more R2 release uploads failed" >&2
  exit 1
fi

echo "Uploaded ${#FILES[@]} release asset(s) to ${BUCKET}/${PREFIX}/"
