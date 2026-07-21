/**
 * 带诊断门闩启动 Tauri 开发版：
 * - VITE_WB_DIAGNOSTICS=1：开启 Workbench HUD + interactionTrace 落盘（.tmp/wb-interaction-trace.json）
 * - WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS：给 WebView2 开 CDP 远程调试端口 9223，
 *   供 scripts/cdp-drag-trace.mjs 抓取 Chromium 内部 trace（只影响本次诊断启动，
 *   不写入 tauri.windows.conf.json，生产构建不受影响）。
 */
import { spawn } from 'node:child_process';

process.env.VITE_WB_DIAGNOSTICS = '1';
process.env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = [
  process.env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS ?? '',
  '--remote-debugging-port=9223',
]
  .join(' ')
  .trim();

const child = spawn('npx', ['tauri', 'dev'], {
  stdio: 'inherit',
  shell: true,
  env: process.env,
  cwd: process.cwd(),
});

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
