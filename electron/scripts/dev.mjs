// npm run dev:electron：若 1422 端口没有 vite，先启动 `npm run dev`；打包 preload；启动 Electron 运行 electron/main.ts。
// 退出 Electron 时一并结束本脚本启动的 vite。
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPreload } from './build-preload.mjs';

const electronDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = join(electronDir, '..');
const tauriConf = JSON.parse(readFileSync(join(repoRoot, 'resources/app', 'tauri.conf.json'), 'utf8'));
const devUrl = process.env.DS_ELECTRON_DEV_URL ?? tauriConf.build.devUrl;

async function reachable(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    return res.status > 0;
  } catch (error) {
    if (error instanceof Error) return false;
    throw error;
  }
}

let vite = null;
if (!(await reachable(devUrl))) {
  process.stdout.write(`[dev:electron] ${devUrl} not reachable, starting vite (npm run dev)\n`);
  vite = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'dev'], { cwd: repoRoot, stdio: 'inherit' });
  const deadline = Date.now() + 120_000;
  while (!(await reachable(devUrl))) {
    if (Date.now() > deadline) {
      vite.kill();
      throw new Error(`vite did not come up on ${devUrl}`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

await buildPreload();

const require = createRequire(import.meta.url);
const electronBinary = require('electron');
if (process.platform === 'darwin') {
  require('./build-system-ocr.cjs')(join(electronDir, '.build', 'dstu-system-ocr'),
    process.arch === 'arm64' ? 'arm64' : 'x86_64');
}
const child = spawn(electronBinary, [join(electronDir, 'main.ts'), ...process.argv.slice(2)], {
  cwd: repoRoot,
  stdio: 'inherit',
  env: { ...process.env, DS_ELECTRON_DEV_URL: devUrl },
});
const stop = () => {
  if (vite && !vite.killed) vite.kill();
};
child.on('exit', (code) => {
  stop();
  process.exit(code ?? 0);
});
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
