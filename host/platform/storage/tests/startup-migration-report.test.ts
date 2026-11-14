/**
 * `StorageService.startupMigrationReport()` / `startupMigrationFailure()`：启动迁移（第一次 `runAll`）
 * 的报告与全局失败分类（Rust `lib.rs:1098-1306`、`should_force_maintenance_mode_on_init_failure`）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import secrets from '../../secrets/index.ts';
import storage from '../index.ts';
import { classifyStartupMigrationFailure, createStorageService } from '../service.ts';
import { MigrationError } from '../migration/errors.ts';
import { CORE_BACKUP_ROOT_DIR_NAME } from '../migration/backup.ts';

let base: string;
let host: Awaited<ReturnType<typeof createTestHost>> | undefined;
const services: Array<{ dispose(): void }> = [];

beforeEach(() => { base = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-startup-migration-')); });
afterEach(async () => {
  for (const service of services.splice(0)) service.dispose();
  await host?.dispose();
  host = undefined;
  fs.rmSync(base, { recursive: true, force: true });
});

function service() {
  const created = createStorageService({ baseDir: base, dataLocalDir: base, auditDbPath: null });
  services.push(created);
  return created;
}

/** 迁移前核心快照目录被普通文件占位：`backup_core_databases_once_per_startup` 全局失败。 */
function breakCoreSnapshot(): void {
  const active = path.join(base, 'slots', 'slotA');
  fs.mkdirSync(active, { recursive: true });
  fs.writeFileSync(path.join(active, CORE_BACKUP_ROOT_DIR_NAME), 'not a directory');
}

it('records the first runAll report and never overwrites it with a later run', async () => {
  const storageService = service();
  expect(storageService.startupMigrationReport()).toBeNull();
  expect(storageService.startupMigrationFailure()).toBeNull();
  const first = await storageService.migrations.runAll();
  expect(first.success).toBe(true);
  expect(first.databases.reduce((sum, db) => sum + db.appliedCount, 0)).toBeGreaterThan(0);
  expect(storageService.startupMigrationReport()).toBe(first);

  const second = await storageService.migrations.runAll();
  expect(second.databases.every((db) => db.appliedCount === 0)).toBe(true);
  expect(storageService.startupMigrationReport()).toBe(first);
  expect(storageService.startupMigrationFailure()).toBeNull();
});

it('a global runAll failure is recorded with blocked core components (lib.rs:1259-1280)', async () => {
  breakCoreSnapshot();
  const storageService = service();
  const error = await storageService.migrations.runAll().then(() => null, (e: unknown) => e);
  expect(error).toBeInstanceOf(MigrationError);
  const failure = storageService.startupMigrationFailure();
  expect(failure).toEqual({
    error: `Migration error: ${(error as Error).message}`,
    kind: (error as MigrationError).detail.kind,
    recovered: false,
    maintenanceForced: true,
  });
  expect(storageService.startupMigrationReport()).toBeNull();
  const reason = `启动迁移无法建立安全状态: ${failure!.error}`;
  expect(storageService.componentHealth.issues()).toEqual(['vfs', 'mistakes', 'chat_v2', 'llm_usage'].map((component) => ({
    component, status: 'blocked', reason, dependency: null,
  })));
  expect(storageService.componentHealth.requiresCoreRecovery()).toBe(true);
});

it('classifies RecoveredFromBackup, schema fingerprint drift and non-migration errors like Rust', () => {
  const recovered = new MigrationError({ kind: 'RecoveredFromBackup', originalError: 'boom', restoredCount: 2 });
  expect(classifyStartupMigrationFailure(recovered)).toEqual({
    error: 'Migration error: Migration failed but recovered from backup: boom (restored 2 databases)',
    kind: 'RecoveredFromBackup', recovered: true, maintenanceForced: true,
  });
  const drift = new MigrationError({
    kind: 'VerificationFailed', version: 20260524, reason: 'Schema fingerprint drift detected at v20260524 (db: mistakes).',
  });
  expect(classifyStartupMigrationFailure(drift)).toEqual({
    error: 'Migration error: Verification failed for migration 20260524: Schema fingerprint drift detected at v20260524 (db: mistakes).',
    kind: 'VerificationFailed', recovered: false, maintenanceForced: false,
  });
  const verification = new MigrationError({ kind: 'VerificationFailed', version: 1, reason: 'missing table' });
  expect(classifyStartupMigrationFailure(verification).maintenanceForced).toBe(true);
  const disk = new MigrationError({ kind: 'InsufficientDiskSpace', availableMb: 1, requiredMb: 50 });
  expect(classifyStartupMigrationFailure(disk)).toMatchObject({ kind: 'InsufficientDiskSpace', maintenanceForced: true });
  expect(classifyStartupMigrationFailure(new Error('plain'))).toEqual({
    error: 'plain', kind: null, recovered: false, maintenanceForced: true,
  });
});

it('RecoveredFromBackup blocks core components with the recovered reason; drift only degrades mistakes', async () => {
  const recovered = service();
  recovered.coordinator = () => ({
    runAll: async () => { throw new MigrationError({ kind: 'RecoveredFromBackup', originalError: 'boom', restoredCount: 1 }); },
  }) as never;
  await expect(recovered.migrations.runAll()).rejects.toBeInstanceOf(MigrationError);
  const recoveredReason = '迁移失败后已恢复旧版数据结构: Migration error: Migration failed but recovered from backup: boom (restored 1 databases)';
  expect(recovered.componentHealth.blockedComponents()).toEqual(['vfs', 'mistakes', 'chat_v2', 'llm_usage']);
  expect(recovered.componentHealth.issues().every((issue) => issue.reason === recoveredReason)).toBe(true);

  const drift = service();
  drift.coordinator = () => ({
    runAll: async () => {
      throw new MigrationError({ kind: 'VerificationFailed', version: 7, reason: 'Schema fingerprint drift detected at v7' });
    },
  }) as never;
  await expect(drift.migrations.runAll()).rejects.toBeInstanceOf(MigrationError);
  expect(drift.startupMigrationFailure()?.maintenanceForced).toBe(false);
  expect(drift.componentHealth.issues()).toEqual([{
    component: 'mistakes', status: 'degraded', dependency: null,
    reason: 'Migration error: Verification failed for migration 7: Schema fingerprint drift detected at v7',
  }]);
});

async function start() {
  const logger = () => ({ debug() {}, info() {}, warn() {}, error() {} });
  host = await createTestHost({
    app: { dataDir: base },
    plugins: [secrets, [storage, { dataLocalDir: base }]],
    provide: {
      paths: { os: { home: base, data: base, dataLocal: base, config: base, temp: base } },
      log: { logger },
      storageStartupSync: { resetDefaultAfterLocalPurge() {} },
    },
    shell: () => null,
  });
  return host;
}

it('the storage plugin starts despite a global migration failure and exposes it on ctx.storage', async () => {
  breakCoreSnapshot();
  const h = await start();
  expect(h.ctx.get('storage')).toBeDefined();
  const failure = h.ctx.storage.startupMigrationFailure();
  expect(failure).toMatchObject({ recovered: false, maintenanceForced: true });
  expect(failure!.error.startsWith('Migration error: ')).toBe(true);
  expect(h.ctx.storage.startupMigrationReport()).toBeNull();
});

it('the storage plugin exposes the startup report on ctx.storage after a successful boot', async () => {
  const h = await start();
  const report = h.ctx.storage.startupMigrationReport();
  expect(report).toMatchObject({ success: true, error: null });
  expect(report!.databases.map((db) => db.id)).toEqual(['vfs', 'llm_usage', 'chat_v2', 'mistakes']);
  expect(h.ctx.storage.startupMigrationFailure()).toBeNull();
});
