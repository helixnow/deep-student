/**
 * 真实 Electron 运行 `electron/main.ts` 的 `start()`：生产 Host 不检查事件载荷是否为纯 JSON（V08-10），
 * main 序列化失败的事件记日志后不投递（Rust `emit` 序列化失败即返回错误），之后的事件照常送达，主进程不抛错。
 * fixture 见 `fixtures/event-payload-main.ts`、`fixtures/event-payload-host.ts`。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildPreload } from '../scripts/build-preload.mjs';
import { spawnElectron } from './electron-process.ts';

describe.skipIf(process.platform === 'win32')('Host event payloads that are not JSON (real Electron main.ts)', () => {
  const cleanups: Array<() => void> = [];
  afterAll(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
  });

  it('a payload JSON.stringify rejects is logged and dropped; later events are still delivered', async () => {
    await buildPreload();
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/html' });
      response.end('<!doctype html><title>event payload</title>');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    cleanups.push(() => server.close());
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    const tmp = mkdtempSync(join(tmpdir(), 'dstu-event-payload-'));
    cleanups.push(() => rmSync(tmp, { recursive: true, force: true }));
    const reportPath = join(tmp, 'report.json');
    const child = await spawnElectron(createRequire(import.meta.url)('electron') as string, [join(import.meta.dirname, 'fixtures', 'event-payload-main.ts')], {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '',
        DS_ELECTRON_DEV_URL: `http://127.0.0.1:${address.port}/`,
        DS_HOST_ENTRY: join(import.meta.dirname, 'fixtures', 'event-payload-host.ts'),
        DS_APP_DATA_DIR: join(tmp, 'appdata'),
        DS_ELECTRON_USER_DATA: join(tmp, 'userdata'),
        EVENT_PAYLOAD_REPORT: reportPath,
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

    expect(report.emitted).toEqual([['test://after', '{"ok":true}']]);
    expect(output).toContain('[host] dropped event "test://cyclic": payload is not JSON (Converting circular structure to JSON');
    expect(output).toContain('[host] dropped event "test://bigint": payload is not JSON (Do not know how to serialize a BigInt)');
    expect(output).not.toContain('[process] uncaught exception');
  }, 60_000);
});
