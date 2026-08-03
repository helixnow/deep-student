#!/usr/bin/env bash
# Purge a list of URLs from the Cloudflare CDN cache.
#
# Usage:
#   bash scripts/ci/purge-cdn.sh <urls_file>
#
# Env:
#   CLOUDFLARE_API_TOKEN  (required)
#   CLOUDFLARE_ZONE_ID    (optional; auto-discovered from deepstudent.cn when missing)
#
# Behaviour:
#   - Missing CLOUDFLARE_API_TOKEN → explicit non-blocking skip with a warning
#     (manual purge-cache.yml remains the fallback), never a silent no-op.
#   - Any resolved zone + API failure → hard error.
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 <urls_file>" >&2
  exit 2
fi

URLS_FILE="$1"
if [[ ! -s "$URLS_FILE" ]]; then
  echo "::warning::purge-cdn: no URLs to purge (${URLS_FILE} empty or missing), skipping"
  exit 0
fi

if [[ -z "${CLOUDFLARE_API_TOKEN:-}" ]]; then
  echo "::warning::purge-cdn: CLOUDFLARE_API_TOKEN not configured — CDN cache NOT purged."
  echo "::warning::Run the manual 'Purge Cloudflare Cache' workflow if users must see the new assets immediately."
  exit 0
fi

ZONE_ID="${CLOUDFLARE_ZONE_ID:-}"
if [[ -z "$ZONE_ID" ]]; then
  echo "CLOUDFLARE_ZONE_ID missing, auto-discovering by domain..."
  for DOMAIN in "deepstudent.cn" "download.deepstudent.cn"; do
    RESP=$(curl -fsS \
      "https://api.cloudflare.com/client/v4/zones?name=${DOMAIN}&status=active&per_page=1" \
      -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
      -H "Content-Type: application/json")
    ZONE_ID=$(echo "$RESP" | jq -r '.result[0].id // empty')
    if [[ -n "$ZONE_ID" ]]; then
      echo "Found zone id for ${DOMAIN}"
      break
    fi
  done
fi

if [[ -z "$ZONE_ID" ]]; then
  echo "::error::purge-cdn: could not resolve Cloudflare zone id"
  exit 1
fi

sort -u "$URLS_FILE" -o "$URLS_FILE"
COUNT=$(wc -l < "$URLS_FILE" | tr -d ' ')
echo "Purging ${COUNT} URL(s) from Cloudflare cache..."

# Cloudflare purge_cache accepts at most 30 files per request.
split -l 30 "$URLS_FILE" /tmp/purge-chunk-
for CHUNK in /tmp/purge-chunk-*; do
  PAYLOAD=$(jq -Rn '[inputs | select(length > 0)] | {files: .}' < "$CHUNK")
  RESP=$(curl -fsS -X POST \
    "https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/purge_cache" \
    -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
    -H "Content-Type: application/json" \
    --data "$PAYLOAD")
  if [[ "$(echo "$RESP" | jq -r '.success // false')" != "true" ]]; then
    echo "$RESP" | jq . || true
    echo "::error::purge-cdn: Cloudflare purge failed"
    exit 1
  fi
done
rm -f /tmp/purge-chunk-*

echo "✅ Cloudflare cache purged (${COUNT} URLs)"
