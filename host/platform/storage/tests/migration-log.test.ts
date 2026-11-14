/**
 * 迁移协调器的 tracing 输出必须进入主日志，target 与 Rust `module_path!()` 一致
 * （`dstu-storage/src/migration/coordinator.rs` → `dstu_storage::migration::coordinator`）。
 * 启动迁移走 `StorageServiceImpl.migrations.runAll()`（主线程），数据治理/备份恢复走迁移 worker。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createMigrationWorker, type MigrationWorker } from '../node.ts';
import { setStorageLogger, type StorageLogLevel } from '../logging.ts';
import { forgetStartupBackupGuard } from '../migration/backup.ts';
import { MigrationCoordinator } from '../migration/coordinator.ts';
import { createStorageService, refineryLogTarget } from '../service.ts';

const TARGET = 'dstu_storage::migration::coordinator';

interface Line { target: string; level: StorageLogLevel; message: string }

let base: string | undefined;
let worker: MigrationWorker | undefined;
afterEach(async () => {
  await worker?.close();
  worker = undefined;
  setStorageLogger(null);
  if (base !== undefined) fs.rmSync(base, { recursive: true, force: true });
  base = undefined;
});

function captureStorageLog(): Line[] {
  const lines: Line[] = [];
  setStorageLogger((target) => {
    const push = (level: StorageLogLevel) => (message: string) => { lines.push({ target, level, message }); };
    return { target, error: push('error'), warn: push('warn'), info: push('info'), debug: push('debug'), trace: push('trace') };
  });
  return lines;
}

it('the startup migration through the storage service writes the coordinator and its recovery decision to the main log', async () => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-migration-log-'));
  const first = createStorageService({ baseDir: base, dataLocalDir: base, auditDbPath: null });
  let vfs: string;
  try {
    expect((await first.migrations.runAll()).success).toBe(true);
    vfs = first.pathOf('vfs');
  } finally {
    first.dispose();
  }
  for (const side of ['-wal', '-shm']) fs.rmSync(`${vfs}${side}`, { force: true });
  fs.writeFileSync(vfs, Buffer.alloc(8192, 0x5a));
  const activeDir = path.dirname(path.dirname(vfs));
  forgetStartupBackupGuard(new MigrationCoordinator({ appDataDir: activeDir, auditDbPath: null }).backups.startupGuardKey());

  const lines = captureStorageLog();
  const second = createStorageService({ baseDir: base, dataLocalDir: base, auditDbPath: null });
  try {
    const report = await second.migrations.runAll();
    expect(report.success).toBe(false);
  } finally {
    second.dispose();
  }
  const coordinator = lines.filter((line) => line.target === TARGET);
  expect(coordinator.some((line) => line.level === 'info' && line.message.includes('开始执行所有数据库迁移'))).toBe(true);
  expect(coordinator.some((line) => line.level === 'error' && line.message.includes('vfs 迁移失败'))).toBe(true);
  expect(coordinator).toContainEqual(expect.objectContaining({
    level: 'warn',
    message: expect.stringContaining(`未删除或覆盖数据库，原文件保留在原位置: ${vfs}`),
  }));
}, 120_000);

it('the migration worker forwards coordinator lines under the Rust target', async () => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-migration-log-worker-'));
  const lines = captureStorageLog();
  worker = createMigrationWorker({ baseDir: base });
  const report = await worker.runAll({ appDataDir: base, auditDbPath: null });
  expect(report.success, report.error ?? '').toBe(true);
  expect(lines.length).toBeGreaterThan(0);
  expect(lines.filter((line) => !line.target.startsWith('dstu_storage::'))).toEqual([]);
  const coordinator = lines.filter((line) => line.target === TARGET);
  expect(coordinator.some((line) => line.message.includes('开始执行所有数据库迁移'))).toBe(true);
  expect(coordinator.some((line) => line.message.includes('已完成迁移前核心库备份'))).toBe(true);
}, 120_000);

it('browser.db refinery lines reach the main log under the refinery_core targets, the observer is optional', () => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-migration-log-browser-'));
  const lines = captureStorageLog();
  const observed: string[] = [];
  const first = createStorageService({ baseDir: base, dataLocalDir: base, auditDbPath: null, log: (_level, message) => { observed.push(message); } });
  try {
    expect(first.database('browser').pluck('SELECT MAX(version) FROM refinery_schema_history')).toBe(20260711);
  } finally {
    first.dispose();
  }
  expect(lines).toContainEqual({ target: 'refinery_core::traits', level: 'info', message: 'schema history table is empty, going to apply all migrations' });
  expect(lines).toContainEqual({ target: 'refinery_core::traits::sync', level: 'info', message: 'applying migration: V20260711__init ...' });
  expect(lines.filter((line) => line.target.startsWith('refinery_core::')).map((line) => `[refinery:browser] ${line.message}`)).toEqual(observed);

  lines.length = 0;
  const second = createStorageService({ baseDir: base, dataLocalDir: base, auditDbPath: null });
  try {
    second.database('browser').pluck('SELECT 1');
  } finally {
    second.dispose();
  }
  expect(lines).toEqual([
    { target: 'refinery_core::traits', level: 'info', message: 'current version: 20260711' },
    { target: 'refinery_core::traits::sync', level: 'info', message: 'no migrations to apply' },
  ]);
});

it('refinery verify diagnostics keep their explicit Rust targets', () => {
  expect(refineryLogTarget('migration V1__a is missing from the filesystem')).toBe('refinery_core::traits::missing');
  expect(refineryLogTarget('found migration on file system V2__b not applied')).toBe('refinery_core::traits::missing');
  expect(refineryLogTarget('applied migration V1__a is different than filesystem one V1__a')).toBe('refinery_core::traits::divergent');
  expect(refineryLogTarget('applied migration:  V1__a writing state to db.')).toBe('refinery_core::traits::sync');
  expect(refineryLogTarget('stopping at migration: 3, due to user option')).toBe('refinery_core::traits::sync');
});
