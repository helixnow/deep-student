#!/usr/bin/env bash
# Generate or check the canonical linux baselines in the pinned container (any Docker host).
#   tests/visual/linux/run-docker.sh check            # compare with tests/visual/__{golden__/dom,screenshots__}/linux
#   tests/visual/linux/run-docker.sh update           # rewrite them (on the baseline commit only)
#   tests/visual/linux/run-docker.sh check --scenes shell-chat,notes
# First run needs registry access for the image and `npm ci` (cached in the ds-visual-node-modules volume).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
image="ds-visual:pw1.60.0"
docker build -t "$image" "$here"
exec docker run --rm --init --ipc=host \
  -v "$repo:/src:ro" \
  -v "$repo/tests/visual:/out" \
  -v ds-visual-node-modules:/work/node_modules \
  "$image" bash /src/tests/visual/linux/in-container.sh "$@"
