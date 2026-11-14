/**
 * 端到端：前端 `@tauri-apps/api` invoke / listen → 主线程移动端外壳 → MessagePort → Web Worker 中的 Host
 * （按 host/profiles/mobile.json 装配）→ SQLite WASM + OPFS / FSRS WASM。
 *
 * 桌面基准由 `scripts/desktop-golden.ts` 用桌面 MigrationCoordinator（better-sqlite3）现场生成。
 */
import { expect, test, type ConsoleMessage, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fsrsCards, fsrsEvaluationMatches } from '../../host/platform/native/tests/wasm-portable-fixtures.ts';
import type { BootMetrics } from '../src/main.ts';

const RESULTS = new URL('../test-results/', import.meta.url);
const golden = JSON.parse(execFileSync(process.execPath, [fileURLToPath(new URL('../scripts/desktop-golden.ts', import.meta.url))], {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'ignore'],
  maxBuffer: 64 * 1024 * 1024,
})) as { sqliteVersion: string; databases: Record<string, { history: unknown[]; schema: unknown[] }>; files: Record<string, string> };

const metrics: Record<string, unknown> = {};

test.afterAll(() => {
  mkdirSync(RESULTS, { recursive: true });
  writeFileSync(new URL('mobile-metrics.json', RESULTS), `${JSON.stringify(metrics, null, 2)}\n`);
});

async function boot(page: Page): Promise<BootMetrics> {
  await page.goto('/index.html');
  await page.waitForFunction(() => document.body.dataset.ready !== undefined, undefined, { timeout: 60_000 });
  expect(await page.evaluate(() => document.body.dataset.ready), await page.locator('#status').textContent() ?? '').toBe('true');
  return page.evaluate(async () => (await globalThis.__dstuMobile!).metrics);
}

/** 经 `app.hostCall`（真实 Tauri 桥发 `plugin:host|call`，`caller` 默认诊断插件 id）调用诊断服务。 */
function diag<T = any>(page: Page, method: string, args: unknown[] = []): Promise<T> {
  return page.evaluate(async ({ method: m, args: a }) => {
    const app = await globalThis.__dstuMobile!;
    return app.hostCall('mobileDiagnostics', m, a);
  }, { method, args }) as Promise<T>;
}

test('cold boot: invoke → Worker Host → storage, migrations byte-identical to desktop', async ({ page }) => {
  const consoleErrors: string[] = [];
  const missingCaller: string[] = [];
  const noteMissingCaller = (message: ConsoleMessage) => { if (message.text().includes('carries no "caller"')) missingCaller.push(message.text()); };
  page.on('console', message => {
    if (message.type() === 'error') consoleErrors.push(message.text());
    noteMissingCaller(message);
  });
  page.on('worker', worker => worker.on('console', noteMissingCaller));
  const bootMetrics = await boot(page);
  const report = await diag(page, 'boot');
  // 不注入任何 Node 全局：Host 闭包靠可移植写法运行（扫描器守护），这里在真实 Worker 里确认。
  expect(report.nodeGlobals).toEqual({ Buffer: 'undefined', process: 'undefined', setImmediate: 'undefined' });

  // 迁移：四个核心库全部成功，按桌面顺序，应用条数 = 迁移文件数。
  expect(report.sqliteVersion).toBe(golden.sqliteVersion);
  expect(report.migration.success, JSON.stringify(report.migration)).toBe(true);
  expect(report.migration.databases.map((d: { id: string }) => d.id)).toEqual(['vfs', 'llm_usage', 'chat_v2', 'mistakes']);
  for (const db of report.migration.databases) {
    expect(db.appliedCount, db.id).toBe(golden.databases[db.id]!.history.length);
    expect(db.error, db.id).toBeNull();
  }
  // 连接不变式：EXCLUSIVE + WAL、外键开启、页大小与桌面一致。
  for (const name of ['vfs', 'llm_usage', 'chat_v2', 'mistakes']) {
    expect(report.pragmas[name], name).toEqual({ lockingMode: 'exclusive', journalMode: 'wal', foreignKeys: 1, pageSize: 4096 });
  }

  // 迁移 SQL 与桌面磁盘文件逐字节一致；refinery 历史（含 checksum）与完整 schema 与桌面相同。
  // 唯一已知差异：桌面迁移后写 schema 指纹表 `__governance_schema_fingerprints`，移动端尚未移植该步骤
  // （fingerprint.ts 依赖 better-sqlite3 / node:crypto）。这里断言差异恰好就是这一张表。
  expect(await diag(page, 'migrationDigests')).toEqual(golden.files);
  const snapshot = await diag(page, 'schemaSnapshot');
  const FINGERPRINT_TABLE = '__governance_schema_fingerprints';
  for (const name of Object.keys(golden.databases)) {
    expect(snapshot[name].history, `${name} refinery_schema_history`).toEqual(golden.databases[name]!.history);
    const desktopSchema = golden.databases[name]!.schema as Array<{ name: string }>;
    expect(desktopSchema.filter(o => o.name === FINGERPRINT_TABLE).length, `${name} desktop fingerprint table`).toBe(1);
    expect(snapshot[name].schema, `${name} sqlite_master`).toEqual(desktopSchema.filter(o => o.name !== FINGERPRINT_TABLE));
  }

  // 读写：integration 插件的 appCommandState 先写内存 + 落库，移出内存后再从 mistakes.db 读回修改。
  const roundTrip = await diag(page, 'tempSessionRoundTrip', ['mobile-e2e-1']);
  expect(roundTrip.first).toEqual({ stream_state: 'completed', tags: ['物理', 'mobile'] });
  expect(roundTrip.second).toEqual({ stream_state: 'completed', tags: ['物理', 'mobile'], last_error: 'reloaded-from-db', user_question: '移动端原型：牛顿第二定律的适用条件？' });
  expect(roundTrip.row).toMatchObject({ temp_id: 'mobile-e2e-1', stream_state: 'completed', last_error: 'reloaded-from-db', created_at: '2026-11-07T04:00:00.123456789+00:00' });

  // FTS5 trigram：真实迁移出的 notes_fts；≥3 字符子串命中，2 字符不命中（同桌面语义）；异步事务期间句柄 BUSY。
  const fts = await diag(page, 'ftsTrigram', ['牛顿第二定律', '加速度与合外力成正比', '合外力']);
  expect(fts.hits).toEqual([9_000_001]);
  expect(fts.tokenizer).toContain("tokenize='trigram'");
  expect(fts.busyWhileOpen).toBe('BUSY');
  expect((await diag(page, 'ftsTrigram', ['牛顿第二定律', '加速度与合外力成正比', '外力'])).hits).toEqual([]);

  // FSRS WASM：与桌面 golden 一致（同第三轮 fixture 与容差）。
  const fsrs = await diag(page, 'fsrsEvaluate', [fsrsCards()]);
  expect(fsrsEvaluationMatches(fsrs.evaluation), JSON.stringify(fsrs.evaluation)).toBe(true);

  // listen：Host 的 backend event 经主线程外壳扇出到前端 listen 回调。
  const pong = await page.evaluate(async () => {
    const app = await globalThis.__dstuMobile!;
    const received = new Promise<unknown>(resolve => {
      void app.listen<unknown>('mobile://pong', event => resolve(event.payload));
    });
    const reply = await app.hostCall('mobileDiagnostics', 'ping', ['hello']);
    return { reply, payload: await received };
  });
  expect(pong.reply).toBe('pong:hello');
  expect(pong.payload).toMatchObject({ message: 'hello' });

  // 错误路径：未声明 remote 的方法、未注册命令都以错误 reject（不挂起）。
  const errors = await page.evaluate(async () => {
    const app = await globalThis.__dstuMobile!;
    const capture = (p: Promise<unknown>) => p.then(() => 'resolved', (e: unknown) => (typeof e === 'string' ? e : JSON.stringify(e)));
    return {
      notRemote: await capture(app.hostCall('mobileDiagnostics', 'schemaSnapshotX')),
      unknownCommand: await capture(app.invoke('definitely_not_a_command')),
    };
  });
  expect(errors.notRemote).not.toBe('resolved');
  expect(errors.unknownCommand).not.toBe('resolved');

  // 批处理：与桌面 batch-operations 测试同一组数据与期望。
  expect(await diag(page, 'storageBatch')).toEqual({
    archived: 1,
    statuses: [
      { id: 'batch-new-active', status: 'completed' },
      { id: 'batch-old-active', status: 'archived' },
      { id: 'batch-old-archived', status: 'archived' },
    ],
    removed: 1,
    messages: [{ mistake_id: 'batch-old-active' }],
  });

  // 平台不支持：Worker 内是结构化 StorageError，前端 invoke 收到以固定前缀开头的消息；能力 id 登记在能力清单里。
  const capabilities = await diag<Array<{ id: string; status: string }>>(page, 'capabilities');
  expect(capabilities.find(entry => entry.id === 'storage.database.browser')?.status).toBe('unsupported');
  expect(capabilities.find(entry => entry.id === 'storage.batchArchiveOldMistakes')?.status).toBe('supported');
  expect(await diag(page, 'browserDatabase')).toMatchObject({
    name: 'StorageError', code: 'UNSUPPORTED_ON_PLATFORM', capability: 'storage.database.browser', platform: 'mobile',
  });
  const rejected = await page.evaluate(async () => {
    const app = await globalThis.__dstuMobile!;
    return app.hostCall('mobileDiagnostics', 'openBrowserDatabase').then(() => 'resolved', (e: unknown) => (typeof e === 'string' ? e : JSON.stringify(e)));
  });
  expect(rejected).toContain('UNSUPPORTED_ON_PLATFORM: storage.database.browser is not available on mobile');

  const after = await diag(page, 'boot');
  metrics.coldBoot = { page: bootMetrics, worker: report.timings, migration: report.migration, memoryAfterBoot: report.memory, memoryAfterE2e: after.memory, fsrsEvaluateMs: fsrs.ms };
  // 上面刻意触发的不支持错误由 kernel 按“非 CommandError 的内部错误”记一条日志；除此之外不得有任何错误。
  const expected = (text: string) => text.includes('UNSUPPORTED_ON_PLATFORM: storage.database.browser');
  expect(consoleErrors.filter(expected)).toHaveLength(1);
  expect(consoleErrors.filter(text => !expected(text))).toEqual([]);
  // hostCall 带 caller（SEC-E06），Host 不应记“缺 caller”的过渡期 warn。
  expect(missingCaller).toEqual([]);
});

test('warm boot after an unclean reload: data persists, no migrations re-applied', async ({ page }) => {
  await boot(page);
  await diag(page, 'tempSessionRoundTrip', ['persist-1']);
  // 刷新页面 = Worker 被直接终止（不发 shutdown），相当于应用被系统杀掉。
  const warmMetrics = await boot(page);
  const report = await diag(page, 'boot');
  expect(report.migration.success).toBe(true);
  expect(report.migration.databases.map((d: { appliedCount: number }) => d.appliedCount)).toEqual([0, 0, 0, 0]);
  expect(await diag(page, 'readTempSession', ['persist-1'])).toMatchObject({ temp_id: 'persist-1', stream_state: 'completed', last_error: 'reloaded-from-db' });
  const integrity = await page.evaluate(async () => (await globalThis.__dstuMobile!).hostCall('mobileDiagnostics', 'schemaSnapshot'));
  expect(Object.keys(integrity as object)).toEqual(['vfs', 'llm_usage', 'chat_v2', 'mistakes']);
  metrics.warmBoot = { page: warmMetrics, worker: report.timings, migration: report.migration, memory: report.memory };
});
