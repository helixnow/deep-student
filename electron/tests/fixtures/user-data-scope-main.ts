/**
 * 真实 `electron/main.ts`：deny-webview-data 的 `$ELECTRON_USERDATA/**` 必须落在 `app.getPath('userData')` 上——main 把它交给
 * ShellRuntime（每次 fs 调用的 ACL 作用域）与全局 fs 作用域（`fsScopeFromPatterns`）。先以拖放把 userData 内外各一个文件
 * 和一个目录加进运行时作用域（之后只有 deny 能拒绝），再从主窗口经 ipcMain 调 `plugin:fs|exists`。报告写到 USER_DATA_SCOPE_REPORT。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { app, BrowserWindow, ipcMain } from 'electron';
import { start, type ShellScopes } from '../../main.ts';
import { IPC_CHANNEL_TO_MAIN, IPC_CHANNEL_TO_RENDERER } from '../../shell/bridge-messages.ts';
import type { ShellRuntime } from '../../shell/runtime.ts';

const reportPath = process.env.USER_DATA_SCOPE_REPORT!;
let shell: { runtime: ShellRuntime; scopes: ShellScopes } | null = null;

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
  if (shell === null) throw new Error('onRuntime was not called');
  const { runtime, scopes } = shell;
  const contents = (await mainWindowLoaded()).webContents;
  const sent: Array<{ callbackId: number; body: unknown }> = [];
  const send = contents.send.bind(contents);
  contents.send = (channel: string, ...args: unknown[]) => {
    if (channel === IPC_CHANNEL_TO_RENDERER) sent.push(args[0] as { callbackId: number; body: unknown });
    send(channel, ...args);
  };
  const event = { sender: contents, senderFrame: contents.mainFrame };
  const userData = app.getPath('userData');
  const inside = join(userData, 'scope-probe', 'secret.txt');
  const outside = join(dirname(userData), 'outside-probe', 'plain.txt');
  const droppedDir = join(dirname(userData), 'dropped-dir');
  const top = join(droppedDir, 'top.txt');
  const nested = join(droppedDir, 'sub', 'deeper', 'nested.txt');
  const notDropped = join(dirname(userData), 'not-dropped', 'plain.txt');
  for (const file of [inside, outside, top, nested, notDropped]) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, 'probe');
  }
  ipcMain.emit(IPC_CHANNEL_TO_MAIN, event, { type: 'drag-drop', phase: 'drop', paths: [inside, outside, droppedDir], position: { x: 1, y: 1 } });
  let callback = 100;
  const exists = async (path: string) => {
    const ok = callback++;
    const error = callback++;
    ipcMain.emit(IPC_CHANNEL_TO_MAIN, event, {
      type: 'invoke', cmd: 'plugin:fs|exists', callback: ok, error, payload: { contentType: 'application/json', data: JSON.stringify({ path }) }, headers: {},
    });
    const deadline = Date.now() + 5_000;
    for (;;) {
      const reply = sent.find((message) => message.callbackId === ok || message.callbackId === error);
      if (reply !== undefined) return { ok: reply.callbackId === ok, body: reply.body };
      if (Date.now() > deadline) return { timeout: true };
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  return {
    userData,
    runtimeUserDataDir: runtime.userDataDir,
    runtimeScopeAllows: { inside: scopes.fsRuntime.isAllowed(inside), outside: scopes.fsRuntime.isAllowed(outside) },
    globalScopeForbids: { inside: scopes.fsGlobal.isForbidden(inside), userDataItself: scopes.fsGlobal.isForbidden(userData), outside: scopes.fsGlobal.isForbidden(outside) },
    exists: { inside: await exists(inside), outside: await exists(outside) },
    droppedDirExists: { top: await exists(top), nested: await exists(nested), notDropped: await exists(notDropped) },
  };
}

void app.whenReady().then(() => start({
  processHooks: { restart: () => undefined, exit: () => undefined },
  onRuntime: (runtime, scopes) => { shell = { runtime, scopes }; },
})).then(run).then((report) => {
  writeFileSync(reportPath, JSON.stringify(report));
  app.exit(0);
}, (error: unknown) => {
  writeFileSync(reportPath, JSON.stringify({ fatal: error instanceof Error ? error.stack ?? error.message : String(error) }));
  app.exit(1);
});
