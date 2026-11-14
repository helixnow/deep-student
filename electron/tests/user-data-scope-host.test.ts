/**
 * 真实 Electron 运行 `electron/main.ts` 的 `start()`：deny-webview-data 的 `$ELECTRON_USERDATA/**`（W23，
 * RF-W23-fs-deny-webview-data-user-data）落在 `app.getPath('userData')` 上。main 把同一个目录交给 ShellRuntime（每次 fs 调用的
 * ACL 作用域）与全局 fs 作用域；`DS_ELECTRON_USER_DATA` 让 userData 不在 runtime 缺省推导的位置，两处少传任何一处都会在这里
 * 显出来。同一次拖放里的目录按 Tauri 递归放行（tauri-plugin-fs-2.4.5 `lib.rs:455`）。子进程的 TMPDIR 另设，探测文件不落在
 * capability 的 `$TEMP/**` 里，放行只能来自拖放。fixture 见 `fixtures/user-data-scope-main.ts`。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildPreload } from '../scripts/build-preload.mjs';
import { spawnElectron } from './electron-process.ts';

describe.skipIf(process.platform === 'win32')('Electron userData is the deny-webview-data target (real Electron main.ts)', () => {
  const cleanups: Array<() => void> = [];
  afterAll(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
  });

  it('main passes app.getPath(\'userData\') to the runtime and the global fs scope; a dropped file inside it is still refused, a dropped directory is allowed recursively', async () => {
    await buildPreload();
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/html' });
      response.end('<!doctype html><title>user data scope</title>');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    cleanups.push(() => server.close());
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    const tmp = mkdtempSync(join(tmpdir(), 'dstu-user-data-scope-'));
    cleanups.push(() => rmSync(tmp, { recursive: true, force: true }));
    const reportPath = join(tmp, 'report.json');
    const userData = join(tmp, 'userdata');
    const childTmp = join(tmp, 'child-tmp');
    mkdirSync(childTmp);
    const child = await spawnElectron(createRequire(import.meta.url)('electron') as string, [join(import.meta.dirname, 'fixtures', 'user-data-scope-main.ts')], {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '',
        DS_ELECTRON_DEV_URL: `http://127.0.0.1:${address.port}/`,
        DS_HOST_ENTRY: join(import.meta.dirname, 'fixtures', 'stub-host.ts'),
        DS_APP_DATA_DIR: join(tmp, 'appdata'),
        DS_ELECTRON_USER_DATA: userData,
        TMPDIR: childTmp,
        USER_DATA_SCOPE_REPORT: reportPath,
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

    const inside = join(userData, 'scope-probe', 'secret.txt');
    expect(report.userData).toBe(userData);
    // runtime 缺省推导是 `<config_dir>/<identifier>.electron`（隔离时在 appdata.os 下），与这里的 userData 不同。
    expect(report.runtimeUserDataDir).toBe(userData);
    expect(report.runtimeScopeAllows).toEqual({ inside: true, outside: true });
    expect(report.globalScopeForbids).toEqual({ inside: true, userDataItself: true, outside: false });
    const yes = { ok: true, body: { kind: 'json', data: 'true' } };
    expect(report.exists).toEqual({
      inside: { ok: false, body: { kind: 'json', data: JSON.stringify(`forbidden path: ${inside}`) } },
      outside: yes,
    });
    const notDropped = join(tmp, 'not-dropped', 'plain.txt');
    expect(report.droppedDirExists).toEqual({
      top: yes,
      nested: yes,
      notDropped: { ok: false, body: { kind: 'json', data: JSON.stringify(`forbidden path: ${notDropped}, maybe it is not allowed on the scope for \`allow-exists\` permission in your capability file`) } },
    });
  }, 60_000);
});
