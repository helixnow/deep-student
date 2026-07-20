#!/usr/bin/env bash
# ============================================================================
# Runs the migration fixture upgrade gate against a fixture root.
#
# The gate is the cargo integration test
# src-tauri/tests/migration_fixture_upgrade_gate.rs. If that file is already
# present in the working tree (it is committed alongside the Rust
# compatibility-test work), it is used as-is — provided it matches the
# template in scripts/migration-ci/fixture-upgrade-harness.rs. If it is
# absent, the template is installed for the duration of the run and removed
# afterwards. A pre-existing file is never deleted.
#
# The run fails unless at least one test actually executed, so a
# feature-gated-to-empty test binary can never report a fake green.
#
# Usage:
#   run-fixture-upgrades.sh --fixture-root DIR [--mode upgrade|fault|scale]
#                           [--report FILE] [--max-seconds N]
# ============================================================================
set -euo pipefail

FIXTURE_ROOT=""
MODE="upgrade"
REPORT=""
MAX_SECONDS="300"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --fixture-root) FIXTURE_ROOT="$2"; shift 2 ;;
    --mode) MODE="$2"; shift 2 ;;
    --report) REPORT="$2"; shift 2 ;;
    --max-seconds) MAX_SECONDS="$2"; shift 2 ;;
    *) echo "usage: $0 --fixture-root DIR [--mode upgrade|fault|scale] [--report FILE] [--max-seconds N]" >&2; exit 2 ;;
  esac
done

if [[ -z "$FIXTURE_ROOT" || ! -d "$FIXTURE_ROOT" ]]; then
  echo "::error::--fixture-root must point to an existing directory (got '${FIXTURE_ROOT}')" >&2
  exit 1
fi
case "$MODE" in upgrade|fault|scale) ;; *) echo "invalid --mode ${MODE}" >&2; exit 2 ;; esac

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
HARNESS_SRC="${SCRIPT_DIR}/fixture-upgrade-harness.rs"
HARNESS_DST="${REPO_ROOT}/src-tauri/tests/migration_fixture_upgrade_gate.rs"

if [[ -e "$HARNESS_DST" ]]; then
  if ! cmp -s "$HARNESS_SRC" "$HARNESS_DST"; then
    echo "::error::${HARNESS_DST} exists but differs from the template" \
         "scripts/migration-ci/fixture-upgrade-harness.rs — sync the two files" \
         "(the committed test and the template must stay identical)." >&2
    exit 1
  fi
  echo "ℹ️  Using committed harness at ${HARNESS_DST} (matches template)"
else
  cp "$HARNESS_SRC" "$HARNESS_DST"
  cleanup() { rm -f "$HARNESS_DST"; }
  trap cleanup EXIT
fi

FIXTURE_ROOT="$(cd "$FIXTURE_ROOT" && pwd)"
if [[ -n "$REPORT" ]]; then
  mkdir -p "$(dirname "$REPORT")"
  # Resolve to an absolute path: cargo runs from src-tauri/.
  REPORT="$(cd "$(dirname "$REPORT")" && pwd)/$(basename "$REPORT")"
fi

echo "▶ migration fixture gate: mode=${MODE} root=${FIXTURE_ROOT}"
LOG="$(mktemp)"
run_gate() {
  cd "${REPO_ROOT}/src-tauri"
  MIGRATION_FIXTURE_ROOT="$FIXTURE_ROOT" \
  MIGRATION_GATE_MODE="$MODE" \
  MIGRATION_GATE_REPORT="$REPORT" \
  MIGRATION_GATE_MAX_SECONDS="$MAX_SECONDS" \
    cargo test --test migration_fixture_upgrade_gate -- --nocapture
}
set +e
( run_gate ) 2>&1 | tee "$LOG"
GATE_EXIT=${PIPESTATUS[0]}
set -e
if [[ $GATE_EXIT -ne 0 ]]; then
  rm -f "$LOG"
  exit "$GATE_EXIT"
fi

# A feature-gated-to-empty binary would pass with "0 passed" — refuse that.
PASSED="$(awk '/^test result:/ { for (i=1;i<=NF;i++) if ($(i+1) == "passed;") sum += $i } END { print sum+0 }' "$LOG")"
rm -f "$LOG"
if [[ "$PASSED" -lt 1 ]]; then
  echo "::error::migration_fixture_upgrade_gate executed ${PASSED} tests — the gate did not actually run (feature-gated out?); refusing to report green." >&2
  exit 1
fi
echo "✅ migration fixture gate passed (${PASSED} test(s) executed)"
