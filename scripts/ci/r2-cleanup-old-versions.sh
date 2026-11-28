#!/usr/bin/env bash
# Delete R2 objects belonging to releases older than the newest KEEP_VERSIONS
# GitHub releases. Shared by release/rebuild publish and the manual R2 sync.
#
# Uses short-lived R2 credentials scoped to `releases/` and S3 batch APIs
# (`list-objects-v2` + `delete-objects`), deleting ONLY objects that actually
# exist in R2 in chunks of 1000 instead of invoking wrangler per historical file.
#
# Env:
#   GH_TOKEN                 (required, for gh api)
#   GITHUB_REPOSITORY        (required, owner/repo)
#   CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN  (required)
#   R2_BUCKET                (default: deepstudent)
#   KEEP_VERSIONS            (default: 10)
set -euo pipefail

R2_BUCKET="${R2_BUCKET:-deepstudent}"
KEEP_VERSIONS="${KEEP_VERSIONS:-10}"

for command in curl jq aws gh; do
  command -v "$command" >/dev/null 2>&1 || {
    echo "::error::r2-cleanup: ${command} is required" >&2
    exit 1
  }
done

echo "Checking for old R2 release versions to clean up (keep newest ${KEEP_VERSIONS})..."
if [[ "$KEEP_VERSIONS" -le 100 ]]; then
  RELEASES=$(gh api "repos/${GITHUB_REPOSITORY}/releases?per_page=100" -q '.[].tag_name')
else
  RELEASES=$(gh api "repos/${GITHUB_REPOSITORY}/releases" --paginate -q '.[].tag_name')
fi

TOTAL=$(printf '%s\n' "$RELEASES" | grep -c . || true)
echo "Found ${TOTAL} recent GitHub releases"

if [[ "$TOTAL" -le "$KEEP_VERSIONS" ]]; then
  echo "No cleanup needed (${TOTAL} <= ${KEEP_VERSIONS})"
  exit 0
fi

KEEP_TAGS_JSON=$(printf '%s\n' "$RELEASES" | head -n "$KEEP_VERSIONS" | jq -Rsc 'split("\n") | map(select(length > 0))')

verify_response=$(curl --fail --silent --show-error \
  "https://api.cloudflare.com/client/v4/user/tokens/verify" \
  --header "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}")
parent_access_key_id=$(jq -er 'select(.success == true) | .result | select(.status == "active") | .id' <<<"$verify_response")

credential_request=$(jq -nc \
  --arg bucket "$R2_BUCKET" \
  --arg parent "$parent_access_key_id" \
  '{bucket: $bucket, parentAccessKeyId: $parent, permission: "object-read-write", ttlSeconds: 3600, prefixes: ["releases/"]}')
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
# AWS CLI v2.23+ defaults to trailing CRC32 checksums which Cloudflare R2 rejects on DeleteObjects/PutObject.
export AWS_REQUEST_CHECKSUM_CALCULATION=when_required
export AWS_RESPONSE_CHECKSUM_VALIDATION=when_required
ENDPOINT="https://${CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com"

EXISTING_KEYS_JSON=$(aws s3api list-objects-v2 \
  --bucket "$R2_BUCKET" \
  --prefix "releases/" \
  --endpoint-url "$ENDPOINT" \
  --query 'Contents[].Key' \
  --output json)

# Delete only versioned release keys (`releases/v<tag>/...`) whose tag is outside the
# newest KEEP_VERSIONS releases. Never touch `releases/latest.json` or `releases/experimental/*`.
OBSOLETE_KEYS_JSON=$(jq -nc \
  --argjson keys "${EXISTING_KEYS_JSON:-[]}" \
  --argjson keep "$KEEP_TAGS_JSON" \
  '($keep | map({(.): true}) | add // {}) as $keepSet
   | ($keys // [])
   | map(select(type == "string"))
   | map(
       select(test("^releases/v[^/]+/.+"))
       | select((split("/")[1]) as $tag | ($keepSet[$tag] | not))
     )')

DELETE_COUNT=$(jq 'length' <<<"$OBSOLETE_KEYS_JSON")
if [[ "$DELETE_COUNT" -eq 0 ]]; then
  echo "No obsolete R2 objects found under releases/"
  exit 0
fi

OBSOLETE_TAGS=$(jq -r 'map(split("/")[1]) | unique | join(", ")' <<<"$OBSOLETE_KEYS_JSON")
echo "Deleting ${DELETE_COUNT} obsolete R2 object(s) across tag(s): ${OBSOLETE_TAGS}"

BATCH_SIZE=1000
OFFSET=0
ERROR_TOTAL=0
while [[ "$OFFSET" -lt "$DELETE_COUNT" ]]; do
  PAYLOAD=$(jq -nc \
    --argjson keys "$OBSOLETE_KEYS_JSON" \
    --argjson offset "$OFFSET" \
    --argjson size "$BATCH_SIZE" \
    '{Objects: ($keys[$offset:($offset + $size)] | map({Key: .})), Quiet: true}')
  DEL_OUT=$(aws s3api delete-objects \
    --bucket "$R2_BUCKET" \
    --endpoint-url "$ENDPOINT" \
    --delete "$PAYLOAD" \
    --output json)
  ERR_COUNT=$(jq '(.Errors // []) | length' <<<"${DEL_OUT:-"{}"}")
  if [[ "$ERR_COUNT" -gt 0 ]]; then
    ERROR_TOTAL=$((ERROR_TOTAL + ERR_COUNT))
    echo "::warning::r2-cleanup reported ${ERR_COUNT} deletion error(s):" >&2
    jq -r '.Errors[] | "  \(.Key): \(.Code) \(.Message)"' <<<"$DEL_OUT" >&2
  fi
  OFFSET=$((OFFSET + BATCH_SIZE))
done

echo "R2 cleanup complete (${DELETE_COUNT} requested, ${ERROR_TOTAL} error(s))"
