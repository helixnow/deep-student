/**
 * 真实 Electron main（生产 `tauri://localhost` 入口，前端换成测试页）+ Host 协议替身：
 * Tauri 版 WebKit localStorage 迁移的完整启动路径（DESIGN.md §8.2）。
 *
 * 同一隔离目录内依次启动四次：
 * 1. 新用户：没有旧数据 → 直接完成；测试页写入两个“目标已有”的键后退出。
 * 2. 源库损坏 → 对话框选“退出”：不创建窗口、不完成迁移、源文件不变。
 * 3. 源库仍损坏 → 对话框选“重试”（重试前换成正常源库）：先加载空白迁移页，再加载应用；
 *    应用第一段脚本就能读到迁移数据，目标已有的键保留。
 * 4. 再次启动（源库又有新键）：迁移不再执行。
 *
 * 第 1 步结束后删除迁移状态目录，以便第 2～4 步在“目标已有数据”的前提下迁移。
 */
import { spawnElectron } from './electron-process.ts';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { buildPreload } from '../scripts/build-preload.mjs';
import { WebviewMigrationError } from '../storage-migration/index.ts';
import { writeWebKitLocalStorage } from '../storage-migration/tests/fixtures.ts';
import { WEBVIEW_MIGRATION_PAGE_PATH } from '../shell/webview-migration.ts';

const here = dirname(fileURLToPath(import.meta.url));
const identifier = (JSON.parse(readFileSync(join(here, '..', '..', 'resources/app', 'tauri.conf.json'), 'utf8')) as { identifier: string }).identifier;

const REPORT_SCRIPT = `
const storage = {};
for (let index = 0; index < localStorage.length; index += 1) {
  const key = localStorage.key(index);
  storage[key] = localStorage.getItem(key);
}
const I = window.__TAURI_INTERNALS__;
I.invoke('smoke_report', { href: location.href, storage }).then(() => I.invoke('plugin:process|exit', { code: 0 }));
`;
const SEED_SCRIPT = `
localStorage.setItem('dstu-theme-mode', 'light');
localStorage.setItem('target-only', 'keep');
${REPORT_SCRIPT}`;

function writeDist(dir: string, script: string): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"><script src="/page.js"></script></head><body></body></html>');
  writeFileSync(join(dir, 'page.js'), script);
  return dir;
}

interface RunResult {
  events: Array<Record<string, unknown>>;
  report: { href: string; storage: Record<string, string> } | null;
  output: string;
}

describe.skipIf(process.platform === 'win32')('Tauri WebView localStorage migration (real Electron main)', () => {
  const cleanups: Array<() => void> = [];
  afterAll(() => {
    for (const cleanup of cleanups) cleanup();
  });

  async function launcher() {
    await buildPreload();
    const electron = createRequire(import.meta.url)('electron') as string;
    const tmp = mkdtempSync(join(tmpdir(), 'dstu-webview-migration-'));
    const appData = join(tmp, 'appdata');
    const userData = join(tmp, 'userdata');
    const home = join(tmp, 'appdata.os', 'home');
    const sourceDb = process.platform === 'darwin'
      ? join(home, 'Library', 'WebKit', identifier, 'WebsiteData', 'LocalStorage', 'tauri_localhost_0.localstorage')
      : join(home, '.local', 'share', identifier, 'localstorage', 'tauri_localhost_0.localstorage');
    const stateFile = join(userData, 'webview-migration', 'state.json');
    const reportPath = join(tmp, 'report.json');
    const eventsPath = join(tmp, 'events.jsonl');
    const seedDist = writeDist(join(tmp, 'dist-seed'), SEED_SCRIPT);
    const appDist = writeDist(join(tmp, 'dist-app'), REPORT_SCRIPT);
    const run = async (dist: string, extra: Record<string, string>): Promise<RunResult> => {
      rmSync(reportPath, { force: true });
      rmSync(eventsPath, { force: true });
      const env: Record<string, string | undefined> = {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '',
        DS_ELECTRON_FRONTEND_DIST: dist,
        DS_HOST_ENTRY: join(here, 'fixtures', 'stub-host.ts'),
        DS_APP_DATA_DIR: appData,
        DS_ELECTRON_USER_DATA: userData,
        SMOKE_REPORT: reportPath,
        // This test's Host completes startup; HostReady alone no longer certifies the gate.
        SMOKE_STARTUP_READY: '1',
        MIGRATION_EVENTS: eventsPath,
        ...extra,
      };
      delete env.DS_ELECTRON_DEV_URL;
      const child = await spawnElectron(electron, [join(here, 'fixtures', 'webview-migration-main.ts')], { env, stdio: 'pipe' });
      cleanups.push(() => child.kill('SIGKILL'));
      let output = '';
      child.stdout.on('data', (chunk) => (output += String(chunk)));
      child.stderr.on('data', (chunk) => (output += String(chunk)));
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          reject(new Error(`electron did not exit; output:\n${output}`));
        }, 50_000);
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
      const events = existsSync(eventsPath)
        ? readFileSync(eventsPath, 'utf8').trim().split('\n').filter((line) => line !== '').map((line) => JSON.parse(line) as Record<string, unknown>)
        : [];
      const report = existsSync(reportPath) ? (JSON.parse(readFileSync(reportPath, 'utf8')) as RunResult['report']) : null;
      return { events, report, output };
    };
    const navigations = (result: RunResult) => result.events.filter((event) => event.event === 'navigate').map((event) => event.url);
    const prompts = (result: RunResult) => result.events.filter((event) => event.event === 'prompt');
    const appUrl = 'tauri://localhost/index.html';
    const migrationPageUrl = `tauri://localhost${WEBVIEW_MIGRATION_PAGE_PATH}`;
    const consoleErrors = (result: RunResult) => result.events.filter((event) => event.event === 'console' && event.level === 'error');
    return { tmp, userData, sourceDb, stateFile, seedDist, appDist, run, navigations, prompts, consoleErrors, appUrl, migrationPageUrl };
  }

  it('migrates once before the app runs, keeps target keys, and offers only retry / exit on failure', async () => {
    const { tmp, userData, sourceDb, stateFile, seedDist, appDist, run, navigations, prompts, consoleErrors, appUrl, migrationPageUrl } = await launcher();

    // 1. 新用户。
    const seed = await run(seedDist, {});
    expect(seed.events.find((event) => event.hook === 'fatal'), seed.output).toBeUndefined();
    expect(prompts(seed)).toEqual([]);
    expect(navigations(seed)).toEqual([appUrl]);
    expect(seed.report?.storage).toEqual({ 'dstu-theme-mode': 'light', 'target-only': 'keep' });
    expect(JSON.parse(readFileSync(stateFile, 'utf8'))).toMatchObject({ status: 'done', source: null });
    rmSync(join(userData, 'webview-migration'), { recursive: true, force: true });

    // 2. 源库损坏，选择退出。
    mkdirSync(dirname(sourceDb), { recursive: true });
    const corrupt = Buffer.from('this is not a sqlite database');
    writeFileSync(sourceDb, corrupt);
    const validDb = join(tmp, 'valid.localstorage');
    const migrated: Array<[string, string]> = [
      ['dstu-theme-mode', 'dark'],
      ['i18nextLng', 'zh-CN'],
      ['essay_draft_1', '作文草稿🙂'],
      ['empty', ''],
      ['nul', 'a\u0000b'],
      ['zustand', '{"state":{"x":1},"version":2}'],
      ['long', 'x'.repeat(70_000)],
    ];
    writeWebKitLocalStorage(validDb, migrated);

    const exited = await run(appDist, { MIGRATION_PROMPT_CHOICES: 'exit' });
    const unreadable = new WebviewMigrationError('SOURCE_UNREADABLE', '').userMessage;
    expect(prompts(exited).map((event) => [event.message, event.choice, event.windows]), exited.output).toEqual([[unreadable, 'exit', 0]]);
    expect(String(prompts(exited)[0]?.detail)).toContain('SOURCE_UNREADABLE');
    expect(exited.events.filter((event) => event.hook === 'exit')).toEqual([{ hook: 'exit', code: 0, windows: 0 }]);
    expect(navigations(exited)).toEqual([]);
    expect(exited.report).toBeNull();
    expect(JSON.parse(readFileSync(stateFile, 'utf8')).status).not.toBe('done');
    expect(readFileSync(sourceDb)).toEqual(corrupt);

    // 3. 重试成功。
    const retried = await run(appDist, { MIGRATION_PROMPT_CHOICES: 'retry', MIGRATION_FIX_FROM: validDb, MIGRATION_FIX_TO: sourceDb });
    expect(prompts(retried).map((event) => [event.message, event.choice, event.windows]), retried.output).toEqual([[unreadable, 'retry', 0]]);
    // 写入页 → 核对页（读回 + 落盘确认）→ 应用。
    expect(navigations(retried)).toEqual([migrationPageUrl, migrationPageUrl, appUrl]);
    expect(retried.report?.href).toBe(appUrl);
    expect(retried.report?.storage).toEqual({
      ...Object.fromEntries(migrated),
      'dstu-theme-mode': 'light',
      'target-only': 'keep',
    });
    const done = readFileSync(stateFile, 'utf8');
    expect(JSON.parse(done)).toMatchObject({ status: 'done', result: { written: migrated.length - 1, kept: 1 }, source: { kind: 'webkit-sqlite', path: sourceDb } });
    expect(retried.output).toContain(`[webview-migration] 完成：写入 ${migrated.length - 1} 个键，保留目标已有 1 个键`);
    // 迁移页 CSP 为 default-src 'none'：preload 的拖动区域样式不得触发 CSP 拒绝（升级首启控制台不报错）。
    expect(consoleErrors(retried)).toEqual([]);

    // 4. 只迁移一次。
    rmSync(sourceDb);
    writeWebKitLocalStorage(sourceDb, [...migrated, ['added-later', 'must not appear'], ['i18nextLng', 'en-US']]);
    const again = await run(appDist, {});
    expect(prompts(again)).toEqual([]);
    expect(navigations(again), again.output).toEqual([appUrl]);
    expect(again.report?.storage).toEqual(retried.report?.storage);
    expect(readFileSync(stateFile, 'utf8')).toBe(done);
    expect(again.output).not.toContain('准备快照');
  }, 240_000);

  it('killed after the keys are written and confirmed but before done is marked: the next launch replays and overwrites nothing', async () => {
    const { userData, sourceDb, stateFile, seedDist, appDist, run, navigations, prompts, consoleErrors, appUrl, migrationPageUrl } = await launcher();
    const seed = await run(seedDist, {});
    expect(seed.report?.storage, seed.output).toEqual({ 'dstu-theme-mode': 'light', 'target-only': 'keep' });
    rmSync(join(userData, 'webview-migration'), { recursive: true, force: true });
    const migrated: Array<[string, string]> = [
      ['dstu-theme-mode', 'dark'],
      ['i18nextLng', 'zh-CN'],
      ['essay_draft_1', '作文草稿🙂'],
      ['long', 'y'.repeat(70_000)],
    ];
    writeWebKitLocalStorage(sourceDb, migrated);

    const killed = await run(appDist, { MIGRATION_KILL_BEFORE_MARK: '1' });
    expect(killed.events.filter((event) => event.hook !== undefined), killed.output).toEqual([{ hook: 'kill-before-mark' }]);
    expect(navigations(killed)).toEqual([migrationPageUrl, migrationPageUrl]);
    expect(killed.report).toBeNull();
    expect(JSON.parse(readFileSync(stateFile, 'utf8')).status).toBe('snapshotted');

    const replayed = await run(appDist, {});
    expect(prompts(replayed), replayed.output).toEqual([]);
    expect(navigations(replayed)).toEqual([migrationPageUrl, migrationPageUrl, appUrl]);
    expect(consoleErrors(replayed)).toEqual([]);
    expect(replayed.report?.storage).toEqual({ ...Object.fromEntries(migrated), 'dstu-theme-mode': 'light', 'target-only': 'keep' });
    // 被杀前已确认落盘：重放时所有键都已在目标里，一个都不重写。
    expect(JSON.parse(readFileSync(stateFile, 'utf8'))).toMatchObject({ status: 'done', result: { written: 0, kept: migrated.length } });
  }, 240_000);
});
