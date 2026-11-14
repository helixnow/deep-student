/**
 * 测试入口：生产 `start()`。安全策略拦下主窗口渲染端发起的跨 origin 顶层导航后，由 main 以 `loadURL`
 * 程序化加载同一 URL（不经过 will-navigate），用来继续验证“主窗口停在远程 origin 时 Host ACL 拒绝调用”。
 */
import { app } from 'electron';
import { start } from '../../main.ts';

app.on('web-contents-created', (_event, contents) => {
  contents.on('will-navigate', (event) => {
    if (!event.isMainFrame) return;
    // 等同一事件的其余监听（含安全策略）都执行完，再看导航是否被拦下。
    setImmediate(() => {
      if (event.defaultPrevented && !contents.isDestroyed()) void contents.loadURL(event.url);
    });
  });
});

void app.whenReady().then(() => start()).catch((error: unknown) => {
  process.stderr.write(`fatal: ${error instanceof Error ? error.message : String(error)}\n`);
  app.exit(1);
});
