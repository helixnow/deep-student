#!/usr/bin/env bash
# WP-045 可复跑迁移验证场景（Linux）：WebKitGTK 写入 → Electron 导入（目标已有键保留，flush 后强杀）→ 新进程读回比对。
# 全部在隔离目录中进行；源 WebKit 文件只复制读取，比对其前后指纹。
# 用法：bash electron/tests/fixtures/webview-storage/run-scenario.sh [输出目录]
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../../../.." && pwd)"
out="${1:-$(mktemp -d /tmp/opencode/wp045-scenario-XXXXXX)}"
mkdir -p "$out"
bash "$here/probe-webkitgtk.sh" "$out/webkit" | tee "$out/webkit.log"
grep '"mode":"read"' "$out/webkit.log" > "$out/webkit-read.json"
src="$out/webkit/home/.local/share/com.deepstudent.app/localstorage/tauri_localhost_0.localstorage"
ud="$out/electron-userdata"
electron="$repo/node_modules/.bin/electron"
for m in seed import-kill verify; do
  set +e
  xvfb-run -a "$electron" --no-sandbox "$here/electron-probe.mjs" "$m" "$src" "$ud" "$out/electron-$m.json" 2>"$out/electron-$m.stderr"
  code=$?
  set -e
  echo "electron $m exit $code"
  if [ "$m" = import-kill ]; then [ "$code" -ne 0 ] || { echo "import-kill expected SIGKILL"; exit 1; }; else [ "$code" -eq 0 ] || exit "$code"; fi
done
node - "$out" <<'EOF'
const fs = require('node:fs');
const dir = process.argv[2];
const webkit = JSON.parse(fs.readFileSync(`${dir}/webkit-read.json`, 'utf8'));
const imp = JSON.parse(fs.readFileSync(`${dir}/electron-import-kill.json`, 'utf8'));
const ver = JSON.parse(fs.readFileSync(`${dir}/electron-verify.json`, 'utf8'));
const got = new Map(JSON.parse(ver.localStorageJson));
const failures = [];
const check = (name, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` ${detail}` : ''}`); if (!ok) failures.push(name); };
check('electron origin is tauri://localhost', ver.origin === 'tauri://localhost', ver.origin);
check('source integrity ok', imp.integrity && Object.values(imp.integrity)[0] === 'ok');
check('source files unchanged by import', imp.sourceUnchanged === true);
check('preload ran before page script', imp.firstReadByPage === 'zh-CN', String(imp.firstReadByPage));
check('target-wins kept seeded key', JSON.stringify(imp.applied.kept) === '["dstu-theme-mode"]', JSON.stringify(imp.applied.kept));
for (const [key, value] of Object.entries(webkit.localStorage)) {
  const expected = key === 'dstu-theme-mode' ? 'light' : value;
  const actual = got.get(key);
  check(`key ${JSON.stringify(key)}`, actual === expected, actual === expected ? '' : `${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
}
const big = got.get('big');
check('key "big" (70000 x)', big === 'x'.repeat(webkit.bigLength), `len ${big?.length}`);
check('key count', got.size === Object.keys(webkit.localStorage).length + 1, `${got.size}`);
check('lone surrogate code units', JSON.stringify([...got.get('lone')].map((c) => c.charCodeAt(0))) === JSON.stringify(webkit.loneCodes));
check('NUL code units', JSON.stringify([...got.get('nul')].map((c) => c.charCodeAt(0))) === JSON.stringify(webkit.nulCodes));
console.log(failures.length === 0 ? 'SCENARIO PASS' : `SCENARIO FAIL (${failures.length})`);
process.exit(failures.length === 0 ? 0 : 1);
EOF
