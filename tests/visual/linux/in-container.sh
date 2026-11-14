#!/usr/bin/env bash
# Runs inside the ds-visual image. /src = repository (read-only), /out = repository tests/visual (rw),
# /work/node_modules = cached Linux node_modules volume. Usage: in-container.sh check|update [layer args…]
set -euo pipefail
mode="${1:-check}"; shift || true
case "$mode" in check|update) ;; *) echo "usage: in-container.sh check|update" >&2; exit 2 ;; esac

# Private copy: macOS node_modules / build output of the host must never leak in.
rsync -a --delete --exclude node_modules --exclude dist --exclude dist-demo --exclude 'tests/visual/.out' \
  --exclude '.git' /src/ /work/
cd /work
if [ ! -f node_modules/.ds-visual-lock ] || ! cmp -s package-lock.json node_modules/.ds-visual-lock; then
  npm ci --no-audit --no-fund
  cp package-lock.json node_modules/.ds-visual-lock
fi

echo "fonts: $(fc-match sans-serif) | $(fc-match 'Noto Sans CJK SC') | $(fc-match monospace)"
node --max-old-space-size=8192 tests/visual/lib/build.mjs demo

status=0
node tests/visual/dom-golden.mjs "--$mode" "$@" || status=$?
node tests/visual/screenshots.mjs "--$mode" "$@" || status=$?
if [ "$mode" = check ]; then
  # Platform-independent layers must agree with the committed (darwin-generated) goldens too.
  node scripts/plugins/ipc-trace.mjs --check "$@" || status=$?
  node tests/visual/motion-check.mjs --check || status=$?
fi

mkdir -p /out/__golden__/dom /out/__screenshots__ /out/.out
if [ "$mode" = update ]; then
  rm -rf /out/__golden__/dom/linux /out/__screenshots__/linux
  cp -a tests/visual/__golden__/dom/linux /out/__golden__/dom/
  cp -a tests/visual/__screenshots__/linux /out/__screenshots__/
fi
rm -rf /out/.out/linux && cp -a tests/visual/.out /out/.out/linux 2>/dev/null || true
exit "$status"
