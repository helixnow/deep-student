import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { threadId } from 'node:worker_threads';
import { afterEach, expect, it } from 'vitest';
import { createMigrationWorker, type MigrationWorker } from '../node.ts';
import { setStorageLogger } from '../logging.ts';
import { Connection } from '../connection.ts';
import { MigrationCoordinator } from '../migration/coordinator.ts';

let base: string;
let worker: MigrationWorker | undefined;
afterEach(async () => {
  await worker?.close(); worker = undefined;
  setStorageLogger(null);
  if (base) fs.rmSync(base, { recursive: true, force: true });
});

it('run_all migration job keeps the Host responsive, returns health, and closes after accepted work', async () => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-migration-worker-'));
  worker = createMigrationWorker({ baseDir: base });
  let began!: () => void;
  const started = new Promise<void>(resolve => { began = resolve; });
  const logs: string[] = [];
  setStorageLogger(target => ({ target,
    info(message) { logs.push(message); if (message.includes('开始执行所有数据库迁移')) began(); },
    debug() {}, warn() {}, error() {}, trace() {},
  }));
  let finished = false;
  const run = worker.runAll({ appDataDir: base, auditDbPath: null }).then(report => { finished = true; return report; });
  await started;
  await delay(1);
  expect(finished).toBe(false);
  const second = worker.runAll({ appDataDir: base, auditDbPath: null });
  // Shutdown drains both accepted tasks rather than terminating a live migration.
  const closing = worker.close();
  await expect(worker.runAll({ appDataDir: base })).rejects.toMatchObject({ code: 'TX_CLOSED' });
  const report = await run;
  expect(report.threadId).not.toBe(threadId);
  expect(report.success).toBe(true);
  expect(report.databases.map(db => db.id)).toEqual(['vfs', 'llm_usage', 'chat_v2', 'mistakes']);
  expect(report.databases.every(db => db.appliedCount > 0)).toBe(true);
  expect(report.componentHealth.components.every(component => component.status === 'healthy')).toBe(true);
  expect((await second).databases.every(db => db.appliedCount === 0)).toBe(true);
  await closing;
  expect(logs.some(message => message.includes('迁移完成'))).toBe(true);
  expect(fs.existsSync(path.join(base, 'databases/audit.db'))).toBe(false);
}, 120_000);

it('migration job preserves errors instead of returning a successful partial report', async () => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-migration-error-'));
  worker = createMigrationWorker({ baseDir: base });
  await expect(worker.runAll({ appDataDir: base, migrationsDir: path.join(base, 'missing') }))
    .rejects.toThrow(/missing/);
  expect(fs.existsSync(path.join(base, 'mistakes.db'))).toBe(false);
});

it('migration worker shares completed startup backup guards back to the Host before close', async () => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-migration-guard-'));
  const old = new Connection(path.join(base, 'mistakes.db'), { label: 'mistakes', profile: {} });
  old.exec('CREATE TABLE legacy_marker(value TEXT)'); old.close();
  worker = createMigrationWorker({ baseDir: base });
  expect((await worker.runAll({ appDataDir: base, auditDbPath: null })).success).toBe(true);
  await worker.close();
  const snapshots = path.join(base, 'migration_core_backups');
  const before = fs.readdirSync(snapshots);
  expect(before).toHaveLength(1);
  // Same real guard used by the existing main-thread coordinator, not a parallel cache.
  await new MigrationCoordinator({ appDataDir: base, auditDbPath: null }).backups.backupCoreDatabasesOncePerStartup();
  expect(fs.readdirSync(snapshots)).toEqual(before);
}, 120_000);
