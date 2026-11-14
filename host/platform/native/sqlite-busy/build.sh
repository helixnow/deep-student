#!/usr/bin/env bash
# Builds busy_handler.c for the current platform (linux-x64 / darwin-*).
# Inputs, all already in the repository / toolchain, nothing is downloaded:
#   - N-API headers: NODE_INCLUDE (default: <node prefix>/include/node)
#   - SQLite 3.53.4 headers shipped with better-sqlite3 13.0.3 (deps/sqlite3)
# napi_* symbols resolve from the host process (Node or Electron) at load time.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../../../.." && pwd)"
node_include="${NODE_INCLUDE:-$(dirname "$(dirname "$(command -v node)")")/include/node}"
sqlite_include="$root/node_modules/better-sqlite3/deps/sqlite3"
platform="$(node -p 'process.platform + "-" + process.arch')"
out="$here/prebuilds/f7-sqlite-busy.$platform.node"
mkdir -p "$here/prebuilds"
case "$platform" in
  linux-*)
    cc -std=c11 -O2 -fPIC -shared -fvisibility=hidden -Wall -Wextra -Werror \
      -I"$node_include" -I"$sqlite_include" -o "$out" "$here/busy_handler.c" ;;
  darwin-*)
    # install_name: the default is the absolute build path, which would leak into the committed binary.
    # 12.0 is Electron 45's minimum macOS; the SDK default would refuse to load on older systems.
    cc -std=c11 -O2 -fPIC -dynamiclib -fvisibility=hidden -Wall -Wextra -Werror -mmacosx-version-min=12.0 \
      -install_name "@rpath/$(basename "$out")" \
      -undefined dynamic_lookup -I"$node_include" -I"$sqlite_include" -o "$out" "$here/busy_handler.c" ;;
  *)
    echo "unsupported platform for build.sh: $platform (win32 needs MSVC + node.lib, see migration/spec/F7-native.md WP-085)" >&2
    exit 1 ;;
esac
node -e 'const [f]=process.argv.slice(1);const h=require("crypto").createHash("sha256").update(require("fs").readFileSync(f)).digest("hex");require("fs").writeFileSync(f+".sha256",h+"  "+require("path").basename(f)+"\n")' "$out"
echo "built $out"
