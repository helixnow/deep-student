#!/usr/bin/env bash
# ============================================================================
# Production migration test gate.
#
# Replaces the former `cargo test --test migration_tests` CI entry, which was
# a fake green: tests/migration_tests.rs is gated behind the non-default
# `old_migration_impl` feature, so it compiled to an empty binary and passed
# with "0 passed; 0 failed".
#
# This script runs the real data_governance migration tests that live inside
# the library (src/data_governance/migration_tests.rs and inline tests in
# src/data_governance/migration/), then parses the cargo test summary and
# fails unless a minimum number of tests actually executed.
#
# Usage:
#   run-migration-tests.sh [--min-tests N] [--filter STR] [--count-out FILE]
#
# Outputs (appended to $GITHUB_OUTPUT when set):
#   migration_test_count=<total passed>
# ============================================================================
set -euo pipefail

MIN_TESTS=1
FILTER="data_governance::migration"
COUNT_OUT=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --min-tests) MIN_TESTS="$2"; shift 2 ;;
    --filter) FILTER="$2"; shift 2 ;;
    --count-out) COUNT_OUT="$2"; shift 2 ;;
    *) echo "usage: $0 [--min-tests N] [--filter STR] [--count-out FILE]" >&2; exit 2 ;;
  esac
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "${REPO_ROOT}/src-tauri"

LOG="$(mktemp)"
trap 'rm -f "$LOG"' EXIT

echo "▶ cargo test --lib '${FILTER}'"
# Stream output while capturing it for the summary parse. cargo's own exit
# code still gates failures; the count check below gates the 0-tests case.
set +e
cargo test --lib "$FILTER" 2>&1 | tee "$LOG"
CARGO_EXIT=${PIPESTATUS[0]}
set -e

if [[ $CARGO_EXIT -ne 0 ]]; then
  echo "::error::Migration test run failed (cargo exit ${CARGO_EXIT})." >&2
  exit "$CARGO_EXIT"
fi

# Sum "N passed" across every "test result:" summary line (one per target).
PASSED="$(awk '/^test result:/ { for (i=1;i<=NF;i++) if ($(i+1) == "passed;") sum += $i } END { print sum+0 }' "$LOG")"

echo "══════════════════════════════════════════"
echo "  Migration tests passed: ${PASSED} (minimum required: ${MIN_TESTS})"
echo "══════════════════════════════════════════"

if [[ "$PASSED" -lt "$MIN_TESTS" ]]; then
  echo "::error::Only ${PASSED} migration test(s) executed (< ${MIN_TESTS})." \
       "A 0/low-test run means the production data_governance migration tests" \
       "did not actually run — refusing to report green." >&2
  exit 1
fi

if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  echo "migration_test_count=${PASSED}" >> "$GITHUB_OUTPUT"
fi
if [[ -n "$COUNT_OUT" ]]; then
  printf '{"migration_test_count": %d, "filter": "%s"}\n' "$PASSED" "$FILTER" > "$COUNT_OUT"
fi
