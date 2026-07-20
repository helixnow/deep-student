#!/usr/bin/env bash
# ============================================================================
# Migration fixture fetcher for CI.
#
# Fixture archives contain real historical app-data directories used to prove
# that the production migration coordinator can upgrade old user databases.
#
# Archive layout convention (tar.gz):
#   representative/<case-name>/{databases/vfs.db, chat_v2.db, mistakes.db, llm_usage.db}
#   full/<case-name>/...
#   scale/<case-name>/...
#
# Sources, in priority order:
#   1. Checked-in fixtures at src-tauri/tests/migration-fixtures/ (small,
#      public cases; currently optional).
#   2. Private archive downloaded from $MIGRATION_FIXTURE_URL, authenticated
#      with optional $MIGRATION_FIXTURE_TOKEN (Bearer), integrity-pinned by
#      required $MIGRATION_FIXTURE_SHA256.
#
# Modes:
#   --mode skip     missing secrets => exit 0 with fixtures_available=false
#                   (PR / nightly tiers: explicit, non-blocking skip)
#   --mode require  missing secrets => exit 1
#                   (release tier: fail-closed, a release may never ship
#                   without running fixture upgrades)
#
# Outputs (appended to $GITHUB_OUTPUT when set, always echoed):
#   fixtures_available=true|false
#   fixture_hash=<sha256 of archive, or "local:<dir-hash>" or "none">
#   fixture_root=<absolute path of extracted tier directory>
# ============================================================================
set -euo pipefail

TIER="representative"
MODE="skip"
DEST=""

usage() {
  echo "usage: $0 --tier representative|full|scale --dest DIR [--mode skip|require]" >&2
  exit 2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --tier) TIER="$2"; shift 2 ;;
    --dest) DEST="$2"; shift 2 ;;
    --mode) MODE="$2"; shift 2 ;;
    *) usage ;;
  esac
done

[[ -n "$DEST" ]] || usage
case "$TIER" in representative|full|scale) ;; *) usage ;; esac
case "$MODE" in skip|require) ;; *) usage ;; esac

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LOCAL_FIXTURES="${REPO_ROOT}/src-tauri/tests/migration-fixtures"

emit() {
  local key="$1" value="$2"
  echo "${key}=${value}"
  if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
    echo "${key}=${value}" >> "$GITHUB_OUTPUT"
  fi
}

mkdir -p "$DEST"
DEST="$(cd "$DEST" && pwd)"

# ── Source 1: checked-in fixtures ──────────────────────────────────────────
if [[ -d "${LOCAL_FIXTURES}/${TIER}" ]] && [[ -n "$(ls -A "${LOCAL_FIXTURES}/${TIER}" 2>/dev/null)" ]]; then
  cp -R "${LOCAL_FIXTURES}/${TIER}/." "${DEST}/${TIER}/"
  # Deterministic content hash of the copied tree for the report.
  DIR_HASH="$(cd "${DEST}/${TIER}" && find . -type f -print0 | sort -z \
    | xargs -0 shasum -a 256 2>/dev/null | shasum -a 256 | awk '{print $1}')"
  echo "✅ Using checked-in fixtures: ${LOCAL_FIXTURES}/${TIER}"
  emit fixtures_available true
  emit fixture_hash "local:${DIR_HASH}"
  emit fixture_root "${DEST}/${TIER}"
  exit 0
fi

# ── Source 2: private archive ───────────────────────────────────────────────
if [[ -z "${MIGRATION_FIXTURE_URL:-}" ]]; then
  if [[ "$MODE" == "require" ]]; then
    echo "::error::MIGRATION_FIXTURE_URL is not configured and no checked-in fixtures exist." \
         "The release migration gate is fail-closed: configure the MIGRATION_FIXTURE_URL /" \
         "MIGRATION_FIXTURE_SHA256 (and optional MIGRATION_FIXTURE_TOKEN) secrets, or commit" \
         "fixtures under src-tauri/tests/migration-fixtures/${TIER}/." >&2
    exit 1
  fi
  echo "::warning::Migration fixtures unavailable (no MIGRATION_FIXTURE_URL secret, no checked-in fixtures). Fixture upgrade checks are SKIPPED for tier '${TIER}'."
  emit fixtures_available false
  emit fixture_hash none
  emit fixture_root ""
  exit 0
fi

if [[ -z "${MIGRATION_FIXTURE_SHA256:-}" ]]; then
  echo "::error::MIGRATION_FIXTURE_SHA256 must be set when MIGRATION_FIXTURE_URL is set (integrity pin)." >&2
  exit 1
fi

ARCHIVE="${DEST}/fixtures.tar.gz"
CURL_ARGS=(--fail --silent --show-error --location --retry 3 --retry-delay 5 -o "$ARCHIVE")
if [[ -n "${MIGRATION_FIXTURE_TOKEN:-}" ]]; then
  CURL_ARGS+=(-H "Authorization: Bearer ${MIGRATION_FIXTURE_TOKEN}")
fi
echo "⬇️  Downloading migration fixture archive..."
curl "${CURL_ARGS[@]}" "$MIGRATION_FIXTURE_URL"

ACTUAL_SHA="$(shasum -a 256 "$ARCHIVE" | awk '{print $1}')"
if [[ "$ACTUAL_SHA" != "$MIGRATION_FIXTURE_SHA256" ]]; then
  echo "::error::Fixture archive SHA-256 mismatch: expected ${MIGRATION_FIXTURE_SHA256}, got ${ACTUAL_SHA}" >&2
  exit 1
fi

tar -xzf "$ARCHIVE" -C "$DEST"
rm -f "$ARCHIVE"

if [[ ! -d "${DEST}/${TIER}" ]] || [[ -z "$(ls -A "${DEST}/${TIER}" 2>/dev/null)" ]]; then
  if [[ "$MODE" == "require" ]]; then
    echo "::error::Fixture archive does not contain a non-empty '${TIER}/' directory." >&2
    exit 1
  fi
  echo "::warning::Fixture archive has no '${TIER}/' tier. Fixture upgrade checks are SKIPPED for tier '${TIER}'."
  emit fixtures_available false
  emit fixture_hash "$ACTUAL_SHA"
  emit fixture_root ""
  exit 0
fi

CASE_COUNT="$(find "${DEST}/${TIER}" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')"
echo "✅ Fixture tier '${TIER}' ready: ${CASE_COUNT} case(s), archive sha256=${ACTUAL_SHA}"
emit fixtures_available true
emit fixture_hash "$ACTUAL_SHA"
emit fixture_root "${DEST}/${TIER}"
