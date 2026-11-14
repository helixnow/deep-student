/** WindowManager 的首个 loadURL 失败（开发服务器未启动等）：只记日志，不留下未处理的 Promise 拒绝。 */
import { writeFileSync } from 'node:fs';
import { app } from 'electron';
import { WindowManager } from '../../shell/windows.ts';

const logs: string[] = [];
const rejections: string[] = [];
process.on('unhandledRejection', (reason) => { rejections.push(String(reason)); });

app.setPath('userData', process.env.DS_ELECTRON_USER_DATA!);
void app.whenReady().then(async () => {
  const manager = new WindowManager({
    platform: process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux',
    debug: false,
    preloadPath: '',
    resolveUrl: () => 'http://127.0.0.1:1/unreachable',
    emit: () => undefined,
    hasJsListener: () => false,
    lifecycle: () => undefined,
    webviewGone: () => undefined,
    log: (message) => { logs.push(message); },
  });
  manager.create({ label: 'main', visible: false });
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  writeFileSync(process.env.LOAD_FAILURE_REPORT!, JSON.stringify({ logs, rejections }));
  app.exit(0);
}).catch((error: unknown) => {
  writeFileSync(process.env.LOAD_FAILURE_REPORT!, JSON.stringify({ error: String(error) }));
  app.exit(1);
});
