/**
 * 真实 Electron main + Host 协议替身：验证 Host shell-request 到进程插件/PDF 白名单 op 的路由。
 * 测试入口只替换 restart/exit 两个不可逆 OS hooks；Host 协议、shellRequest 与错误出口保持生产实现。
 */
import { spawnElectron } from './electron-process.ts';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { resolveOsDirs, SHELL_OS_DIRS_ENV, type Platform } from '../../host/platform/paths/os-dirs.ts';
import { buildPreload } from '../scripts/build-preload.mjs';
import { buildInfo } from '../build-info.ts';
import packageJson from '../../package.json' with { type: 'json' };

const here = dirname(fileURLToPath(import.meta.url));

describe('host shell requests (real Electron main + protocol stub)', () => {
  const cleanups: Array<() => void> = [];
  afterAll(() => {
    for (const cleanup of cleanups) cleanup();
  });

  it('routes both restart aliases and pdf stream dirs without invoking OS restart hooks', async () => {
    await buildPreload();
    const info = buildInfo(resolve(here, '../..'), packageJson.version);
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/html' });
      response.end('<!doctype html><html><head><title>shell request probe</title></head><body>probe</body></html>');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    cleanups.push(() => server.close());
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');

    const tmp = mkdtempSync(join(tmpdir(), 'dstu-shell-request-'));
    const reportPath = join(tmp, 'shell-report.json');
    const hooksPath = join(tmp, 'restart-hooks.jsonl');
    const require = createRequire(import.meta.url);
    const electron = require('electron') as string;
    const child = await spawnElectron(electron, [join(here, 'fixtures', 'restart-main.ts')], {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '',
        DS_ELECTRON_DEV_URL: `http://127.0.0.1:${address.port}/`,
        DS_HOST_ENTRY: join(here, 'fixtures', 'shell-request-host.ts'),
        DS_APP_DATA_DIR: join(tmp, 'appdata'),
        DS_ELECTRON_USER_DATA: join(tmp, 'userdata'),
        SHELL_REPORT: reportPath,
        RESTART_HOOKS_REPORT: hooksPath,
      },
      stdio: 'pipe',
    });
    let output = '';
    child.stdout.on('data', (chunk) => (output += String(chunk)));
    child.stderr.on('data', (chunk) => (output += String(chunk)));
    cleanups.push(() => child.kill('SIGKILL'));

    const deadline = Date.now() + 50_000;
    while (!existsSync(reportPath) || !existsSync(hooksPath)) {
      if (Date.now() > deadline || child.exitCode !== null) {
        throw new Error(`no shell request report; electron output:\n${output}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    const report = JSON.parse(readFileSync(reportPath, 'utf8')) as Record<string, unknown>;
    expect(report.fullVersion).toEqual({ ok: true, value: `${info.version} (Build ${info.buildNumber}, ${info.gitHash})` });
    expect(report['plugin:process|restart']).toEqual({ ok: true, value: null });
    expect(report['process:restart']).toEqual({ ok: true, value: null });
    const dirs = report.pdfStreamDirs as { ok: boolean; value?: string[] };
    expect(dirs.ok).toBe(true);
    expect(dirs.value).toContain(join(tmp, 'appdata'));
    // DS_APP_DATA_DIR 隔离：home 与 dirs:: 目录都在 <appdata>.os/home 下按平台默认布局推导，不落到真实用户目录；
    // data 与 Host 握手的 appDataDir 一致。
    const identifier = (JSON.parse(readFileSync(join(here, '..', '..', 'resources/app', 'tauri.conf.json'), 'utf8')) as { identifier: string }).identifier;
    const isolatedHome = join(tmp, 'appdata.os', 'home');
    const dataLocalDir = process.platform === 'darwin'
      ? join(isolatedHome, 'Library', 'Application Support')
      : process.platform === 'win32' ? join(isolatedHome, 'AppData', 'Local') : join(isolatedHome, '.local', 'share');
    const cacheDir = process.platform === 'darwin'
      ? join(isolatedHome, 'Library', 'Caches')
      : process.platform === 'win32' ? join(isolatedHome, 'AppData', 'Local') : join(isolatedHome, '.cache');
    expect(dataLocalDir.startsWith(homedir() + '/')).toBe(false);
    // Host 进程启动时就继承的 DS_SHELL_OS_DIRS 与 app.dataDirs 来自同一次计算。
    expect(typeof report.shellOsDirsEnv).toBe('string');
    const osDirs = JSON.parse(report.shellOsDirsEnv as string) as Record<string, string>;
    expect(osDirs.home).toBe(isolatedHome);
    expect(osDirs.dataLocal).toBe(dataLocalDir);
    expect(osDirs.cache).toBe(cacheDir);
    // Host 实际收到的目录不是真实平台目录（dirs-sys 规则按本进程环境推导，子进程继承同一环境），
    // 也不在真实的 `<目录>/<identifier>` 之内。Windows 的 %TEMP% 本身在 %LOCALAPPDATA% 下，所以按应用目录判定。
    const { [SHELL_OS_DIRS_ENV]: _inherited, ...ownEnv } = process.env;
    const real = resolveOsDirs(process.platform as Platform, ownEnv);
    const within = (root: string, path: string) => {
      const rel = relative(root, path);
      return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
    };
    expect(osDirs.home).not.toBe(real.home);
    for (const key of ['data', 'dataLocal', 'config', 'cache'] as const) {
      expect(osDirs[key], key).not.toBe(real[key]);
      for (const reported of [osDirs[key]!, join(osDirs[key]!, identifier)]) {
        expect(within(join(real[key], identifier), reported), `${key}: ${reported} inside ${join(real[key], identifier)}`).toBe(false);
      }
    }
    expect(report.dataDirs).toEqual({
      ok: true,
      value: {
        data: join(tmp, 'appdata'),
        localData: join(dataLocalDir, identifier),
        cache: join(cacheDir, identifier),
        dataLocalDir,
      },
    });
    // path 插件（前端 appDataDir()/homeDir() 等）与 DS_SHELL_OS_DIRS 出自同一次隔离计算；AppData 即 DS_APP_DATA_DIR。
    const appLogDir = process.platform === 'darwin' ? join(isolatedHome, 'Library', 'Logs', identifier) : join(dataLocalDir, identifier, 'logs');
    const ok = (value: string) => ({ ok: true, value });
    expect(report.pathDirs).toEqual({
      home: ok(osDirs.home!),
      appData: ok(join(tmp, 'appdata')),
      appLocalData: ok(join(osDirs.dataLocal!, identifier)),
      appConfig: ok(join(osDirs.config!, identifier)),
      appCache: ok(join(osDirs.cache!, identifier)),
      appLog: ok(appLogDir),
      data: ok(osDirs.data!),
      config: ok(osDirs.config!),
      cache: ok(osDirs.cache!),
    });
    expect(report.unknownProcessOp).toEqual({
      ok: false,
      error: 'process.nope not allowed. Command not found',
    });

    const hooks = readFileSync(hooksPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(hooks.filter((entry) => entry.hook === 'restart')).toHaveLength(2);
    expect(hooks.some((entry) => entry.hook === 'exit')).toBe(false);
  }, 60_000);
});
