#!/usr/bin/env bash
# The compiler cache is optional infrastructure, never a build prerequisite.
set -euo pipefail
if command -v sccache >/dev/null 2>&1; then
  for attempt in 1 2; do
    if sccache --show-stats >/dev/null 2>&1; then
      echo 'RUSTC_WRAPPER=sccache' >> "$GITHUB_ENV"
      exit 0
    fi
    sleep "$attempt"
  done
fi
echo '::warning::sccache unavailable; compiling directly for this job'
echo 'RUSTC_WRAPPER=' >> "$GITHUB_ENV"
