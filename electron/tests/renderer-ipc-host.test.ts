/**
 * 真实 Electron 运行 `electron/main.ts` 的 `start()`：renderer → main 的消息先经 `checkRendererMessage` 校验
 * （bridge-messages.ts），形状不对的记日志后丢弃，不让 ipcMain 监听抛错（那会弹出主进程错误对话框）；
 * invoke 仍交给 runtime，按来源校验并把错误回给页面。fixture 见 `fixtures/renderer-ipc-main.ts`。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildPreload } from '../scripts/build-preload.mjs';
import { MAX_SCRIPT_ERROR_LENGTH } from '../shell/bridge-messages.ts';
import { spawnElectron } from './electron-process.ts';

describe.skipIf(process.platform === 'win32')('renderer → main messages are validated before use (real Electron main.ts)', () => {
  const cleanups: Array<() => void> = [];
  afterAll(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
  });

  it('malformed messages are logged and dropped without throwing; invokes still get an error reply', async () => {
    await buildPreload();
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/html' });
      response.end('<!doctype html><title>renderer ipc</title>');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    cleanups.push(() => server.close());
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    const tmp = mkdtempSync(join(tmpdir(), 'dstu-renderer-ipc-'));
    cleanups.push(() => rmSync(tmp, { recursive: true, force: true }));
    const reportPath = join(tmp, 'report.json');
    const child = await spawnElectron(createRequire(import.meta.url)('electron') as string, [join(import.meta.dirname, 'fixtures', 'renderer-ipc-main.ts')], {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '',
        DS_ELECTRON_DEV_URL: `http://127.0.0.1:${address.port}/`,
        DS_HOST_ENTRY: join(import.meta.dirname, 'fixtures', 'stub-host.ts'),
        DS_APP_DATA_DIR: join(tmp, 'appdata'),
        DS_ELECTRON_USER_DATA: join(tmp, 'userdata'),
        RENDERER_IPC_REPORT: reportPath,
      },
      stdio: 'pipe',
    });
    cleanups.push(() => child.kill('SIGKILL'));
    let output = '';
    child.stdout.on('data', (chunk) => (output += String(chunk)));
    child.stderr.on('data', (chunk) => (output += String(chunk)));
    const code = await new Promise<number | null>((resolve) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(null); }, 40_000);
      child.once('exit', (exitCode) => { clearTimeout(timer); resolve(exitCode); });
    });
    expect(existsSync(reportPath), output.slice(-4000)).toBe(true);
    const report = JSON.parse(readFileSync(reportPath, 'utf8')) as Record<string, unknown>;
    expect(report.fatal, output.slice(-4000)).toBeUndefined();
    expect(code).toBe(0);

    const { sent, ...delivered } = report;
    for (const [name, outcome] of Object.entries(delivered)) expect(outcome, name).toBe('handled');

    const ignored = (reason: string) => `[dstu-shell] [main] ignored a malformed renderer message: ${reason}`;
    const lines = output.split('\n');
    expect(lines.filter((line) => line === ignored('message must be an object'))).toHaveLength(3);
    expect(lines).toContain(ignored('unknown message type'));
    expect(lines).toContain(ignored('drag-drop phase is invalid'));
    expect(lines).toContain(ignored('drag-drop paths must be non-empty strings'));
    expect(lines).toContain(ignored('script-error message must be a string'));
    expect(output).not.toContain('object message');
    // 整条拖放消息作废，不进入 checkDragDrop（它会接受消息、逐个丢弃不合格的路径并记 `drag-drop: ignored …`）。
    expect(output).not.toContain('[main] drag-drop');

    const scriptError = lines.filter((line) => line.startsWith('[dstu-shell] [main] initialization script failed: long:'));
    expect(scriptError).toHaveLength(1);
    expect(scriptError[0]!.slice('[dstu-shell] [main] initialization script failed: '.length)).toHaveLength(MAX_SCRIPT_ERROR_LENGTH);

    expect(lines).toContain('[dstu-shell] [invoke] rejected a malformed message from window "main", webview "main": cmd must be a non-empty string');
    expect(sent).toEqual([{
      type: 'result',
      callbackId: 12,
      otherId: 11,
      body: { kind: 'json', data: JSON.stringify('invalid IPC message: cmd must be a non-empty string') },
    }]);
    expect(output).not.toContain('[process] uncaught exception');
  }, 60_000);
});
