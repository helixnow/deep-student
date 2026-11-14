/**
 * WP-045 取证夹具（非生产代码）：验证"WebKitGTK localStorage SQLite → Electron `tauri://localhost` localStorage"
 * 的最窄写入路径是否无损。在 Electron main 中以 node:sqlite 读取**源快照副本**，经 sandbox preload 在页面脚本
 * 之前写入，flushStorageData 后退出；另起进程读回比对。
 *
 * 用法：electron electron-probe.mjs <seed|import|import-kill|verify> <源 .localstorage 文件> <userData> <结果 JSON>
 * 全部路径由调用者给出且应位于隔离目录；源文件只复制、不打开写入。
 */
import { app, BrowserWindow, ipcMain, protocol, session } from 'electron';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [mode, source, userData, resultFile] = process.argv.slice(-4);
app.setPath('userData', userData);
// 与 electron/shell/protocols.ts registerSchemePrivileges 相同的特权。
protocol.registerSchemesAsPrivileged([
  { scheme: 'tauri', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

const PAGE = `<!doctype html><meta charset=utf-8><script>
window.__firstRead = localStorage.getItem('i18nextLng');
if (new URLSearchParams(location.search).get('mode') === 'seed') localStorage.setItem('dstu-theme-mode', 'light');
</script>`;

function fingerprint(file) {
  if (!existsSync(file)) return null;
  const s = statSync(file);
  return { size: s.size, mtimeMs: s.mtimeMs, sha256: createHash('sha256').update(readFileSync(file)).digest('hex') };
}
function sourceFingerprints() {
  return Object.fromEntries(['', '-wal', '-shm'].map((suffix) => [suffix || 'db', fingerprint(source + suffix)]));
}

/** UTF-16LE 逐码元还原（不经 TextDecoder，保留孤立代理与 NUL）。 */
function utf16le(bytes) {
  if (bytes.length % 2 !== 0) throw new Error(`odd UTF-16 byte length ${bytes.length}`);
  const units = new Uint16Array(bytes.length / 2);
  for (let i = 0; i < units.length; i += 1) units[i] = bytes[2 * i] | (bytes[2 * i + 1] << 8);
  let out = '';
  for (let i = 0; i < units.length; i += 8192) out += String.fromCharCode(...units.subarray(i, i + 8192));
  return out;
}

/** 复制 db/-wal/-shm 到 userData 下的快照目录后读取；源文件不被 SQLite 打开。 */
function readSourceSnapshot() {
  const dir = join(userData, 'wp045-source-snapshot');
  mkdirSync(dir, { recursive: true });
  const target = join(dir, 'source.localstorage');
  for (const suffix of ['', '-wal', '-shm']) if (existsSync(source + suffix)) copyFileSync(source + suffix, target + suffix);
  const db = new DatabaseSync(target);
  const integrity = db.prepare('PRAGMA integrity_check').get();
  const rows = db.prepare('SELECT key, value, typeof(value) AS t FROM ItemTable ORDER BY rowid').all();
  db.close();
  return { integrity, items: rows.map((r) => [r.key, r.t === 'blob' ? utf16le(r.value) : String(r.value)]) };
}

app.whenReady().then(async () => {
  const before = sourceFingerprints();
  session.defaultSession.protocol.handle('tauri', () => new Response(PAGE, { headers: { 'Content-Type': 'text/html' } }));
  const result = { mode, electron: process.versions.electron, node: process.versions.node };
  let pending = null;
  if (mode === 'import' || mode === 'import-kill') {
    const snapshot = readSourceSnapshot();
    result.integrity = snapshot.integrity;
    result.sourceCount = snapshot.items.length;
    pending = JSON.stringify(snapshot.items);
  }
  ipcMain.on('wp045:pending', (event) => { event.returnValue = pending; });
  ipcMain.on('wp045:applied', (event, report) => { result.applied = JSON.parse(report); event.returnValue = null; });
  const win = new BrowserWindow({
    show: false,
    webPreferences: { preload: join(import.meta.dirname, 'electron-probe-preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true },
  });
  await win.loadURL(`tauri://localhost/index.html?mode=${mode}`);
  result.origin = await win.webContents.executeJavaScript('location.origin');
  result.firstReadByPage = await win.webContents.executeJavaScript('window.__firstRead');
  result.localStorageJson = await win.webContents.executeJavaScript(
    'JSON.stringify(Array.from({length: localStorage.length}, (_, i) => localStorage.key(i)).sort().map((k) => [k, localStorage.getItem(k)]))',
  );
  session.defaultSession.flushStorageData();
  result.sourceUnchanged = JSON.stringify(before) === JSON.stringify(sourceFingerprints());
  result.source = before;
  const leveldb = join(userData, 'Local Storage', 'leveldb');
  result.leveldbFiles = existsSync(leveldb) ? readdirSync(leveldb).sort() : null;
  writeFileSync(resultFile, JSON.stringify(result, null, 2));
  if (mode === 'import-kill') {
    // flush 后 1 秒强杀，验证不依赖正常退出路径的落盘。
    setTimeout(() => process.kill(process.pid, 'SIGKILL'), 1000);
  } else {
    app.quit();
  }
});
