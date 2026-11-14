#!/usr/bin/env bash
# WP-045：Linux WebKitGTK（Tauri 端）localStorage/IndexedDB 真实格式取证。
# 全部在新建的隔离目录内进行（HOME/XDG_* 均指向 mktemp 目录），不读写用户真实资料。
# 用法：bash electron/tests/fixtures/webview-storage/probe-webkitgtk.sh [输出目录]
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
out="${1:-$(mktemp -d /tmp/opencode/wp045-webkit-XXXXXX)}"
mkdir -p "$out/home"
export HOME="$out/home" XDG_DATA_HOME="$out/home/.local/share" XDG_CACHE_HOME="$out/home/.cache" XDG_CONFIG_HOME="$out/home/.config"
# Tauri 2.11.5 manager/webview.rs:536-545：Linux 默认 data_directory = LocalData/<identifier>
data="$XDG_DATA_HOME/com.deepstudent.app"
mkdir -p "$data"
probe="$out/webkit-probe"
gcc -O1 -Wall -o "$probe" "$here/webkit-probe.c" $(pkg-config --cflags --libs webkit2gtk-4.1)
echo "webkit2gtk $(pkg-config --modversion webkit2gtk-4.1)"
xvfb-run -a "$probe" write "$data"
xvfb-run -a "$probe" read "$data"
echo "--- files"
(cd "$data" && find . -type f | sort)
echo "--- localStorage sqlite"
for f in $(cd "$data" && find . -name 'localstorage.sqlite3' -o -name '*.localstorage' | sort); do
  echo "# $f"
  sqlite3 "$data/$f" '.schema'
  sqlite3 "$data/$f" "SELECT key, typeof(value), length(value), hex(substr(value,1,24)) FROM ItemTable ORDER BY key;"
done
echo "--- IndexedDB sqlite"
for f in $(cd "$data" && find . -name 'IndexedDB.sqlite3' | sort); do
  echo "# $f"
  sqlite3 "$data/$f" "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;"
  sqlite3 "$data/$f" "SELECT key, value FROM IDBDatabaseInfo ORDER BY key;"
  sqlite3 "$data/$f" "SELECT objectStoreID, hex(key), length(value), hex(substr(value,1,32)) FROM Records;"
done
echo "--- origin files"
for f in $(cd "$data" && find . -name 'origin' | sort); do echo "# $f"; od -A d -c "$data/$f" | head -4; done
echo "probe dir: $out"
