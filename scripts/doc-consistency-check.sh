#!/usr/bin/env bash
set -euo pipefail

TARGET_DIR="docs/user-guide"

if [[ ! -d "$TARGET_DIR" ]]; then
  echo "[doc-check] missing target dir: $TARGET_DIR"
  exit 1
fi

# Terms tied to removed IA/routes. Keep this list tight to reduce false positives.
FORBIDDEN=(
  "nav-library"
  "跳转到复习模式"
  "跳转到笔记"
)

fail=0
for term in "${FORBIDDEN[@]}"; do
  if rg -n --fixed-strings "$term" "$TARGET_DIR" >/tmp/doc_check_hits.txt; then
    echo "[doc-check] forbidden term found: $term"
    cat /tmp/doc_check_hits.txt
    fail=1
  fi
done

if [[ $fail -ne 0 ]]; then
  echo "[doc-check] FAILED"
  exit 1
fi

echo "[doc-check] PASS"
