/**
 * 真实 `electron/main.ts` 的 renderer → main 入口（`IPC_CHANNEL_TO_MAIN`）：主窗口加载完成后，以主窗口的 webContents
 * 与主 frame 作为发送方，把消息直接投进 main 注册的 ipcMain 监听。记录每条消息是否让监听抛错，以及 main 回给页面的
 * invoke 结果；报告写到 RENDERER_IPC_REPORT，main 的日志照常打到 stdout。
 */
import { writeFileSync } from 'node:fs';
import { app, BrowserWindow, ipcMain } from 'electron';
import { start } from '../../main.ts';
import { IPC_CHANNEL_TO_MAIN, IPC_CHANNEL_TO_RENDERER } from '../../shell/bridge-messages.ts';

const reportPath = process.env.RENDERER_IPC_REPORT!;

async function mainWindowLoaded(): Promise<BrowserWindow> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const main = BrowserWindow.getAllWindows().find((window) => !window.webContents.isLoading() && window.webContents.getURL().startsWith('http'));
    if (main !== undefined) return main;
    if (Date.now() > deadline) throw new Error('main window did not load');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function run(): Promise<Record<string, unknown>> {
  const main = await mainWindowLoaded();
  const contents = main.webContents;
  const sent: unknown[] = [];
  const send = contents.send.bind(contents);
  contents.send = (channel: string, ...args: unknown[]) => {
    if (channel === IPC_CHANNEL_TO_RENDERER) sent.push(args[0]);
    send(channel, ...args);
  };
  const event = { sender: contents, senderFrame: contents.mainFrame };
  const deliver = (value: unknown): string => {
    try {
      ipcMain.emit(IPC_CHANNEL_TO_MAIN, event, value);
      return 'handled';
    } catch (error) {
      return `threw ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`;
    }
  };
  const report: Record<string, unknown> = {
    null: deliver(null),
    string: deliver('invoke'),
    array: deliver([{ type: 'window-drag-end' }]),
    unknownType: deliver({ type: 'shell-exec', cmd: 'rm -rf /' }),
    dragDropBadPhase: deliver({ type: 'drag-drop', phase: 'explode' }),
    dragDropBadPaths: deliver({ type: 'drag-drop', phase: 'drop', paths: [42] }),
    scriptErrorNotString: deliver({ type: 'script-error', message: { toString: () => 'object message' } }),
    scriptErrorLong: deliver({ type: 'script-error', message: `long:${'A'.repeat(100_000)}` }),
    windowDragEnd: deliver({ type: 'window-drag-end' }),
    invokeEmptyCmd: deliver({ type: 'invoke', cmd: '', callback: 11, error: 12, payload: { contentType: 'application/json', data: '{}' }, headers: {} }),
  };
  await new Promise((resolve) => setTimeout(resolve, 300));
  report.sent = sent;
  return report;
}

void app.whenReady().then(() => start({ processHooks: { restart: () => undefined, exit: () => undefined } })).then(run).then((report) => {
  writeFileSync(reportPath, JSON.stringify(report));
  app.exit(0);
}, (error: unknown) => {
  writeFileSync(reportPath, JSON.stringify({ fatal: error instanceof Error ? error.stack ?? error.message : String(error) }));
  app.exit(1);
});
