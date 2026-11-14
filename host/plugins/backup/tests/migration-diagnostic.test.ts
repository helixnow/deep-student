/** WP-005: commands.rs:1061-1275, real kernel/F3 diagnostic under X1's 5000ms invoke budget. */
import { readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { TestHost } from '../../../kernel/testing.ts';
import { createMigrationWorker, type MigrationWorkerReport } from '../../../platform/storage/node.ts';
import { createStorageService, type StorageServiceImpl } from '../../../platform/storage/service.ts';
import { setStorageLogger } from '../../../platform/storage/logging.ts';
import { Governance } from '../src/governance.ts';
import { DATABASE_IDS, latestVersion, migrationVersions } from '../src/migrations.ts';
import { createBackupHost } from './helpers.ts';

const X1_INVOKE_BUDGET_MS = 5000;
const SECTIONS = [
  '--- 数据库状态 ---', '--- 错误信息 ---', '--- 最近迁移失败记录（审计日志） ---',
  '--- 空库迁移测试 (Slot C) ---', '--- 当前库重试迁移测试 (Slot D) ---',
  '--- 迁移历史 ---', '--- 磁盘空间 ---', '--- 数据目录 ---',
];

let host: TestHost | undefined;
afterEach(async () => {
  try { await host?.dispose(); }
  finally { host = undefined; vi.restoreAllMocks(); setStorageLogger(null); }
});

/** X1 invokes after startup migration: a separate real runner leaves the command's own worker cold. */
async function migratedHost(): Promise<{ host: TestHost; activeDir: string }> {
  let storage!: StorageServiceImpl;
  const created = await createBackupHost({ storageFactory: dataDir => {
    storage = createStorageService({ baseDir: dataDir, dataLocalDir: dataDir });
    return storage;
  } });
  host = created.host;
  host.ctx.effect(() => () => storage.dispose());
  const activeDir = storage.locations.activeDir;
  // No schema/history/result cache or pre-run Slot C/D.
  const startup = createMigrationWorker({ baseDir: host.app.dataDir });
  try {
    const initial = await startup.runAll({ appDataDir: activeDir });
    expect(initial.success, initial.error ?? '').toBe(true);
  } finally { await startup.close(); }
  writeFileSync(join(activeDir, '.last_migration_error'), JSON.stringify({
    error: 'WP-005 retained SQL failure', timestamp: '2026-11-05T00:00:00+00:00',
  }));
  return { host, activeDir };
}

it('migration diagnostic preserves full current-database report with phase evidence', async ({ task }) => {
  const { host, activeDir } = await migratedHost();
  const before = performance.now();
  const stages: Array<{ name: string; start_ms: number; elapsed_ms: number; report?: MigrationWorkerReport }> = [];
  const logs: Array<{ at_ms: number; level: string; message: string }> = [];
  let migrationStarted = false;
  setStorageLogger(target => {
    const logger = host.ctx.logger(target);
    return { target, info: logger.info.bind(logger), warn: logger.warn.bind(logger),
      error: logger.error.bind(logger), debug: logger.debug.bind(logger), trace: logger.debug.bind(logger) };
  });
  host.ctx.logger.exporter({ levels: { default: 3 }, export(message) {
    const text = message.args.map(String).join(' ');
    if (text.includes('[Migration] 开始迁移数据库')) migrationStarted = true;
    logs.push({ at_ms: performance.now() - before, level: message.type, message: text });
  } });
  // Timing-only pass-through: all original production methods, SQL, logs and errors run.
  const runMigrations = Governance.prototype.runMigrations;
  vi.spyOn(Governance.prototype, 'runMigrations').mockImplementation(async function (this: Governance, dir, auditDbPath) {
    const start = performance.now();
    let report: MigrationWorkerReport | undefined;
    try { return report = await runMigrations.call(this, dir, auditDbPath); }
    finally { stages.push({ name: `${basename(dir)}.worker`, start_ms: start - before,
      elapsed_ms: performance.now() - start, report }); }
  });
  for (const name of ['runSlotCTest', 'runSlotDTest'] as const) {
    const run = Governance.prototype[name];
    vi.spyOn(Governance.prototype, name).mockImplementation(async function (this: Governance) {
      const start = performance.now();
      try { return await run.call(this); }
      finally { stages.push({ name, start_ms: start - before, elapsed_ms: performance.now() - start }); }
    });
  }
  let ticks = 0;
  let lastTick = before;
  let maxGap = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    maxGap = Math.max(maxGap, now - lastTick);
    lastTick = now;
    if (migrationStarted) ticks += 1;
  }, 5);
  let report: string;
  try {
    report = await host.invoke<string>('data_governance_get_migration_diagnostic_report');
  } finally {
    clearInterval(timer);
    const evidence = { elapsed_ms: performance.now() - before, budget_ms: X1_INVOKE_BUDGET_MS,
      ticks_after_migration_start: ticks, max_timer_gap_ms: maxGap, stages,
      coordinator_logs: logs.filter(log => log.message.includes('[MigrationCoordinator]') || log.message.includes('[Migration] 开始')) };
    Object.assign(task.meta, { migration_diagnostic: evidence });
    console.info('WP-005 migration diagnostic phases', JSON.stringify(evidence));
  }
  expect(typeof report).toBe('string');
  expect(report.match(/^--- .* ---$/gm)).toEqual(SECTIONS);
  expect(report).toContain('[2026-11-05T00:00:00+00:00] 真实迁移错误: WP-005 retained SQL failure');
  expect(report).toContain('(审计日志中无迁移失败记录)');
  expect(report).toMatch(/^时间: .*\+00:00$/m);
  expect(report).toContain(`应用版本: ${host.app.version}`);
  expect(report).toMatch(/可用: \d+MB, 数据库总大小: \d+MB/);
  expect(report.endsWith(`--- 数据目录 ---\n${activeDir}`)).toBe(true);
  const migrations = stages.filter(stage => stage.report !== undefined).map(stage => stage.report!);
  expect(migrations).toHaveLength(2);
  for (const migration of migrations) {
    expect(migration.success, migration.error ?? '').toBe(true);
    expect(migration.threadId).toBeGreaterThan(0);
    expect(migration.databases.map(db => db.id)).toEqual(DATABASE_IDS);
  }
  expect(new Set(migrations.map(migration => migration.threadId)).size).toBe(2);
  for (const id of DATABASE_IDS) {
    expect(report).toContain(`[${id}] 当前: v${latestVersion(id)}, 目标: v${latestVersion(id)}, 待执行: 0`);
    expect(report).toContain(`  [${id}] v0 -> v${latestVersion(id)}, 应用 ${migrationVersions(id)!.length} 个迁移,`);
    expect(report).toContain(`  [${id}] v${latestVersion(id)} (已是最新)`);
    expect(report).toMatch(new RegExp(`\\[${id}\\] v\\d+\\([^)]+\\)( v\\d+\\([^)]+\\))*\\n`));
  }
  expect(stages.map(stage => stage.name).sort()).toEqual(['runSlotCTest', 'runSlotDTest', 'slotC.worker', 'slotD.worker']);
  const stage = (name: string) => stages.find(entry => entry.name === name)!;
  expect(stage('slotD.worker').start_ms).toBeLessThan(stage('slotC.worker').start_ms + stage('slotC.worker').elapsed_ms);
  for (const slot of ['slotC', 'slotD']) expect(readdirSync(join(dirname(activeDir), slot))).toEqual([]);
  expect(ticks).toBeGreaterThan(0);
  expect(logs.filter(log => log.level === 'info' && log.message.includes('[MigrationCoordinator] 迁移完成'))).toHaveLength(2);
});

// The 5s oracle times the production invocation alone: no log rerouting, exporter, spies or
// polling timer inside the window. The phase evidence above is for C2, not a replacement timeout
// or an async job receipt returned to the caller.
it('migration diagnostic settles within X1 5000ms', async ({ task }) => {
  const { host, activeDir } = await migratedHost();
  const before = performance.now();
  const report = await host.invoke<string>('data_governance_get_migration_diagnostic_report');
  const elapsed = performance.now() - before;
  Object.assign(task.meta, { migration_diagnostic_budget: { elapsed_ms: elapsed, budget_ms: X1_INVOKE_BUDGET_MS } });
  console.info('WP-005 migration diagnostic budget', JSON.stringify({ elapsed_ms: elapsed, budget_ms: X1_INVOKE_BUDGET_MS }));
  expect(report.match(/^--- .* ---$/gm)).toEqual(SECTIONS);
  expect(report.endsWith(`--- 数据目录 ---\n${activeDir}`)).toBe(true);
  expect(elapsed, 'X1 invocation budget (5000ms)').toBeLessThanOrEqual(X1_INVOKE_BUDGET_MS);
});

/** No startup migration: Slot D has nothing to clone and fails fast, Slot C still runs every real migration. */
async function unmigratedHost(): Promise<{ host: TestHost; activeDir: string }> {
  let storage!: StorageServiceImpl;
  const created = await createBackupHost({ storageFactory: dataDir => {
    storage = createStorageService({ baseDir: dataDir, dataLocalDir: dataDir });
    return storage;
  } });
  host = created.host;
  host.ctx.effect(() => () => storage.dispose());
  return { host, activeDir: storage.locations.activeDir };
}

function timeSlots(): Record<'runSlotCTest' | 'runSlotDTest', { start: number; end?: number }> {
  const spans = { runSlotCTest: { start: Number.NaN }, runSlotDTest: { start: Number.NaN } } as
    Record<'runSlotCTest' | 'runSlotDTest', { start: number; end?: number }>;
  for (const name of ['runSlotCTest', 'runSlotDTest'] as const) {
    const run = Governance.prototype[name];
    vi.spyOn(Governance.prototype, name).mockImplementation(async function (this: Governance) {
      spans[name].start = performance.now();
      try { return await run.call(this); }
      finally { spans[name].end = performance.now(); }
    });
  }
  return spans;
}

it('RF-W08-diagnostic-slots-concurrent: Slot D starts and settles while Slot C still migrates, report keeps C before D', async () => {
  const { host, activeDir } = await unmigratedHost();
  const spans = timeSlots();
  const report = await host.invoke<string>('data_governance_get_migration_diagnostic_report');

  // Rust commands.rs:1199-1217 starts D only after C returned; both slots now share the wall clock.
  expect(spans.runSlotDTest.start).toBeLessThan(spans.runSlotCTest.end!);
  expect(spans.runSlotDTest.end!).toBeLessThan(spans.runSlotCTest.end!);
  expect(report.match(/^--- .* ---$/gm)).toEqual(SECTIONS);
  const slotC = report.slice(report.indexOf('--- 空库迁移测试 (Slot C) ---'), report.indexOf('--- 当前库重试迁移测试 (Slot D) ---'));
  const slotD = report.slice(report.indexOf('--- 当前库重试迁移测试 (Slot D) ---'), report.indexOf('--- 迁移历史 ---'));
  expect(slotC).toMatch(/^--- 空库迁移测试 \(Slot C\) ---\n结果: 成功 \(\d+ms\)\n/);
  for (const id of DATABASE_IDS) {
    expect(slotC).toContain(`  [${id}] v0 -> v${latestVersion(id)}, 应用 ${migrationVersions(id)!.length} 个迁移,`);
  }
  expect(slotD).toBe('--- 当前库重试迁移测试 (Slot D) ---\n'
    + '(复制当前活跃插槽的数据库，重新执行迁移流程；若成功说明重启可恢复)\n'
    + '复制文件时出错: /chat_v2.db: 源数据库不存在; /mistakes.db: 源数据库不存在; '
    + '/llm_usage.db: 源数据库不存在; databases/vfs.db: 源数据库不存在\n\n\n');
  for (const slot of ['slotC', 'slotD']) expect(readdirSync(join(dirname(activeDir), slot))).toEqual([]);
});

it.each([
  { failing: 'executeSlotCTest', other: 'runSlotDTest', otherDir: 'slotD', message: 'EACCES: permission denied, mkdir slotC' },
  { failing: 'executeSlotDTest', other: 'runSlotCTest', otherDir: 'slotC', message: 'EACCES: permission denied, mkdir slotD' },
] as const)('RF-W08-diagnostic-slots-concurrent: a rejected $failing fails the report only after the other slot settled and cleaned up', async ({ failing, other, otherDir, message }) => {
  const { host, activeDir } = await unmigratedHost();
  const spans = timeSlots();
  vi.spyOn(Governance.prototype as unknown as Record<string, () => Promise<unknown>>, failing)
    .mockRejectedValue(Object.assign(new Error(message), { code: 'EACCES' }));
  let settledAt = Number.NaN;
  const failure = await host.invoke<string>('data_governance_get_migration_diagnostic_report')
    .then(() => null, (error: unknown) => { settledAt = performance.now(); return error; });

  expect(failure).toBe(message);
  expect(spans[other].end!).toBeLessThanOrEqual(settledAt);
  expect(readdirSync(join(dirname(activeDir), otherDir))).toEqual([]);
});
