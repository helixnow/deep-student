#!/usr/bin/env bash
# Generate or check linux baselines directly on a Linux host that already has Linux node_modules
# (e.g. the build server). Fonts are whatever the host has installed: font-environment.json makes a
# drift fail loudly. Prefer run-docker.sh when Docker is available.
#   tests/visual/linux/run-native.sh check|update [layer args…]
set -euo pipefail
mode="${1:-check}"; shift || true
case "$mode" in check|update) ;; *) echo "usage: run-native.sh check|update" >&2; exit 2 ;; esac
[ "$(uname -s)" = Linux ] || { echo "run-native.sh is for Linux hosts; use run-docker.sh elsewhere" >&2; exit 2; }
cd "$(dirname "$0")/../../.."
heavy="${HEAVY:-}"
[ -z "$heavy" ] && [ -x bin/heavy ] && heavy=bin/heavy
for font in 'Noto Sans' 'Noto Sans CJK SC'; do
  fc-list | grep -q "$font" || echo "warning: font '$font' not installed (apt install fonts-noto-core fonts-noto-cjk)" >&2
done
export DS_VISUAL_PLATFORM=linux
$heavy node --max-old-space-size=8192 tests/visual/lib/build.mjs demo
status=0
node tests/visual/dom-golden.mjs "--$mode" "$@" || status=$?
$heavy node tests/visual/screenshots.mjs "--$mode" "$@" || status=$?
[ "$mode" = check ] && { node scripts/plugins/ipc-trace.mjs --check "$@" || status=$?; }
[ "$mode" = check ] && { node tests/visual/motion-check.mjs --check || status=$?; }
exit "$status"
