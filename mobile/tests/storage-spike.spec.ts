/**
 * S1–S6 spike：真实 Chromium Worker + OPFS（opfs-sahpool）。断言即结论；完整测量值写入
 * test-results/storage-spike.json，由 PROGRESS.md 引用。
 *
 * 其中两条是“危险行为的刻画”（S2 同 Worker 双连接丢写、S3 回滚日志崩溃后损坏）：它们说明
 * 移动端存储驱动为什么必须单连接 + `locking_mode=EXCLUSIVE` + WAL。若 sqlite-wasm 升级后这两条
 * 开始失败，说明 VFS 行为变了，需要重新评估而不是放宽断言。
 */
import { expect, test } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';

type Outcome = { ok: boolean; value?: any; error?: string };

declare global {
  // eslint-disable-next-line no-var
  var __dstuSpike: {
    run(op: string, options?: { rows?: number; mode?: string; keep?: boolean }): Promise<Outcome>;
    releaseKept(): void;
    persist(): Promise<{ persisted: boolean | null; persistedBefore: boolean | null; estimate: { quota?: number; usage?: number } | null }>;
  };
}

const RESULTS = new URL('../test-results/', import.meta.url);
const ROWS = 4000;
const findings: Record<string, unknown> = {};

test.afterAll(() => {
  mkdirSync(RESULTS, { recursive: true });
  writeFileSync(new URL('storage-spike.json', RESULTS), `${JSON.stringify(findings, null, 2)}\n`);
});

test.beforeEach(async ({ page }) => {
  await page.goto('/spike.html');
  await page.waitForFunction(() => document.body.dataset.ready === 'true');
});

test('S1/S2/S3/S5/S6 measurements', async ({ page }) => {
  const spike = await page.evaluate(() => globalThis.__dstuSpike.run('spike'));
  expect(spike.ok, spike.error).toBe(true);
  const report = spike.value;
  findings.spike = report;

  // S1：与桌面 better-sqlite3 同版本；FTS5 trigram 可用；大整数以 bigint 读出；DEFENSIVE 默认关闭（同桌面 unsafeMode）。
  expect(report.libVersion).toBe('3.53.4');
  expect(report.s1.ok, report.s1.error).toBe(true);
  expect(report.s1.value.compileOptions).toContain('ENABLE_FTS5');
  expect(report.s1.value.trigram).toEqual(['深度学习伴侣']);
  expect(report.s1.value.like).toEqual(['错题本复习']);
  expect(report.s1.value.bigintType).toBe('bigint');
  expect(report.s1.value.defensive).toBe(0);

  // S2（同一 Worker 两条连接）：VFS 的 xLock 不互斥，B 在 A 持写锁时也能 BEGIN IMMEDIATE，A 的写入丢失。
  expect(report.s2.ok, report.s2.error).toBe(true);
  expect(report.s2.value.bBeginImmediate).toBe('acquired');
  expect(report.s2.value.afterCommit).not.toContain('pending');

  // S3：普通锁模式下没有 WAL（无共享内存）；EXCLUSIVE 锁模式下 WAL 可用。
  expect(report.s3.ok, report.s3.error).toBe(true);
  expect(report.s3.value.wal).toBe('delete');
  expect(report.s3.value.walExclusive).toBe('wal');
  expect(report.s3.value.truncate).toBe('truncate');

  // S5：VACUUM INTO 可在 pool 内生成标准 SQLite 文件并整体导出。
  expect(report.s5.ok, report.s5.error).toBe(true);
  expect(report.s5.value.header).toBe('SQLite format 3');

  findings.persist = await page.evaluate(() => globalThis.__dstuSpike.persist());
});

test('S2: a second Worker cannot install the same SAH pool while the first holds it', async ({ page }) => {
  const first = await page.evaluate(() => globalThis.__dstuSpike.run('hold', { keep: true }));
  expect(first.ok, first.error).toBe(true);
  const second = await page.evaluate(() => globalThis.__dstuSpike.run('hold'));
  findings.poolContention = { first, second };
  expect(second.ok).toBe(false);
  await page.evaluate(() => globalThis.__dstuSpike.releaseKept());
  await expect.poll(async () => (await page.evaluate(() => globalThis.__dstuSpike.run('hold'))).ok, { timeout: 10_000 }).toBe(true);
});

test('S3: rollback-journal mode is corrupted by a crash mid-transaction (hot journal is never replayed)', async ({ page }) => {
  const prepared = await page.evaluate(rows => globalThis.__dstuSpike.run('crash-prepare', { rows, mode: 'truncate' }), ROWS);
  expect(prepared.ok, prepared.error).toBe(true);
  expect(prepared.value.files).toContain('/crash.db-journal');
  const recovered = await page.evaluate(rows => globalThis.__dstuSpike.run('crash-recover', { rows, mode: 'truncate' }), ROWS);
  findings.crashTruncate = { prepared, recovered: { ...recovered, value: { ...recovered.value, integrity: String(recovered.value?.integrity).split('\n').slice(0, 3) } } };
  expect(recovered.ok, recovered.error).toBe(true);
  expect(recovered.value.integrity).not.toBe('ok');
});

test('S3: EXCLUSIVE + WAL recovers to the last commit after a crash mid-transaction', async ({ page }) => {
  const prepared = await page.evaluate(rows => globalThis.__dstuSpike.run('crash-prepare', { rows, mode: 'wal-exclusive' }), ROWS);
  expect(prepared.ok, prepared.error).toBe(true);
  expect(prepared.value.journalMode).toBe('wal');
  expect(prepared.value.files).toContain('/crash.db-wal');
  const recovered = await page.evaluate(rows => globalThis.__dstuSpike.run('crash-recover', { rows, mode: 'wal-exclusive' }), ROWS);
  findings.crashWalExclusive = { prepared, recovered };
  expect(recovered.ok, recovered.error).toBe(true);
  expect(recovered.value.integrity).toBe('ok');
  expect(recovered.value.count).toBe(ROWS);
  expect(recovered.value.overwritten).toBe(0);
  expect(recovered.value.sum).toBe(prepared.value.committedSum);
});
