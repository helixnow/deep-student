/**
 * V06-02：启动迁移失败与桌面相同（Rust lib.rs:1098-1141 + 1312-1318）。
 *
 * - 同一种损坏（某个核心库文件不是 SQLite 库）交给桌面 `MigrationCoordinator` 与移动端 `runAll`：
 *   逐库报告、失败原因、依赖跳过与组件健康逐字段相同（库文件路径除外）。
 * - 插件层：vfs 被阻断时移动端存储插件在业务插件装配前进入核心恢复屏障，业务命令得到 kernel 的
 *   MAINTENANCE 占位错误，诊断 / 恢复类调用照常可用，并发出与桌面相同的迁移状态事件载荷。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { definePlugin } from '../../../host/kernel/core.ts';
import type { LaneContract } from '../../../host/kernel/contract.ts';
import { HOST_STATUS_COMMAND } from '../../../host/kernel/core.ts';
import { loadImportedProfile } from '../../../host/kernel/profile-install.ts';
import { createTestHost, type TestHost } from '../../../host/kernel/testing.ts';
import type { CoordinatedDatabaseName, DatabaseMigrationReport } from '../../../host/platform/storage/api.ts';
import { MigrationCoordinator } from '../../../host/platform/storage/migration/coordinator.ts';
import mobileStorage, { MobileStorageService } from '../../../host/platform/storage-mobile/index.ts';
import { nodeRuntime, nodeSqlite } from './support/sqlite-node.ts';

const GARBAGE = new Uint8Array(8192).fill(0x5a);
const temps: string[] = [];
let host: TestHost | undefined;

afterEach(async () => {
  await host?.dispose();
  host = undefined;
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function comparable(report: { databases: readonly DatabaseMigrationReport[]; success: boolean; error: string | null }, health: unknown, path: (id: CoordinatedDatabaseName) => string) {
  const scrub = (text: string | null) => {
    if (text === null) return null;
    let out = text;
    for (const id of ['vfs', 'chat_v2', 'mistakes', 'llm_usage'] as const) out = out.replaceAll(path(id), `<${id}.db>`);
    return out;
  };
  return {
    success: report.success,
    error: scrub(report.error),
    databases: report.databases.map(({ durationMs: _ignored, ...db }) => ({ ...db, error: scrub(db.error) })),
    health: JSON.parse(scrub(JSON.stringify(health))!),
  };
}

async function desktopRun(broken: CoordinatedDatabaseName) {
  const dir = mkdtempSync(join(tmpdir(), 'w31-desktop-migration-'));
  temps.push(dir);
  const coordinator = new MigrationCoordinator({ appDataDir: dir, auditDbPath: null, log: () => undefined });
  mkdirSync(dirname(coordinator.getDatabasePath(broken)), { recursive: true });
  writeFileSync(coordinator.getDatabasePath(broken), GARBAGE);
  const report = await coordinator.runAll();
  return comparable(report, report.componentHealth.toJSON(), id => coordinator.getDatabasePath(id));
}

async function mobileRun(broken: CoordinatedDatabaseName) {
  const runtime = nodeRuntime(await nodeSqlite());
  const storage = new MobileStorageService({ runtime, baseDir: '/data' });
  runtime.put(storage.pathOf(broken), GARBAGE);
  try {
    const report = await storage.migrations.runAll();
    return { storage, shape: comparable(report, storage.componentHealth.toJSON(), id => storage.pathOf(id)) };
  } finally {
    storage.dispose();
  }
}

describe('single-database migration failure matches the desktop coordinator', () => {
  it.each(['vfs', 'mistakes', 'llm_usage'] as const)('%s.db is not a database', async broken => {
    const desktop = await desktopRun(broken);
    const { shape } = await mobileRun(broken);
    expect(shape).toEqual(desktop);
    expect(shape.databases.find(db => db.id === broken)!.error).toMatch(new RegExp(`^Database '${broken}' migration failed: Database error: file is not a database\\. No snapshot was taken`));
  }, 60_000);
});

const recoveryContract: LaneContract = {
  lane: 'W31-fixture', generator: 'hand-written fixture', $defs: {}, commands: [{
    name: 'fixture_recovery_status', lane: 'W31-fixture', rust: { file: 'fixture.rs', line: 1, fn: 'fixture_recovery_status' },
    async: true, args: [], injected: [],
    result: { 'x-rust': 'serde_json::Value' }, error: { 'x-rust': 'serde_json::Value' }, frontend: 'none',
  }], events: [],
};

describe('core recovery barrier on the mobile storage plugin', () => {
  it('vfs blocked: business plugins degrade to MAINTENANCE placeholders, recovery calls keep working, status payload matches desktop', async () => {
    host = await createTestHost({ contracts: [recoveryContract], provide: { sqliteRuntime: nodeRuntime(await nodeSqlite()) } });
    const runtime = host.ctx.get('sqliteRuntime') as ReturnType<typeof nodeRuntime>;
    const probe = new MobileStorageService({ runtime, baseDir: host.ctx.app.dataDir });
    runtime.put(probe.pathOf('vfs'), GARBAGE);

    const business = definePlugin({
      meta: { id: 'dstu.notes', commands: ['notes_list'] },
      inject: ['storage'],
      apply(ctx) {
        const db = ctx.storage.database('vfs');
        ctx.commands.register('notes_list', () => db.all('SELECT 1'));
      },
    });
    const recovery = definePlugin({
      meta: { id: 'fixture.recovery', commands: ['fixture_recovery_status'] },
      inject: ['storage'],
      apply(ctx) {
        ctx.commands.register('fixture_recovery_status', () => ({
          recovery: ctx.storage.startupCoreRecovery(),
          llmUsageTables: ctx.storage.database('llm_usage').pluck("SELECT COUNT(*) FROM sqlite_master WHERE type='table'"),
        }));
      },
    });
    const loaded = await loadImportedProfile(host.runtime, [
      { plugin: mobileStorage, source: 'test:storage-mobile' },
      { plugin: business, source: 'test:business' },
      { plugin: recovery, source: 'test:recovery' },
    ]);
    await host.ctx.storage.runStartupFinalizers();

    const storage = host.ctx.storage;
    const report = storage.startupMigrationReport()!;
    expect(storage.startupMigrationFailure()).toBeNull();
    expect(report.success).toBe(false);
    const byId = new Map(report.databases.map(db => [db.id, db]));
    const vfsReason = byId.get('vfs')!.error!;
    expect(vfsReason).toMatch(/^Database 'vfs' migration failed: Database error: file is not a database\./);
    const dependencyReason = "Skipped because dependency 'vfs' is blocked";
    expect(byId.get('chat_v2')!.error).toBe(dependencyReason);
    expect(byId.get('mistakes')!.error).toBe(dependencyReason);
    expect(byId.get('llm_usage')!.success).toBe(true);

    // 与桌面 core-recovery-profile.test.ts 相同的载荷（lib.rs:1133-1140）。
    expect(host.eventsNamed('data-governance-migration-status')).toEqual([{
      success: true,
      global_version: byId.get('llm_usage')!.toVersion,
      migrations_applied: report.databases.reduce((sum, db) => sum + db.appliedCount, 0),
      duration_ms: report.totalDurationMs,
      warnings: [vfsReason, dependencyReason],
      has_warnings: true,
    }]);

    expect(storage.startupMaintenance()).toEqual({ reason: vfsReason });
    expect(storage.startupCoreRecovery()).toEqual({ reason: vfsReason, databases: ['mistakes', 'vfs', 'chat_v2'] });
    expect(() => storage.database('vfs')).toThrow('Database vfs is in maintenance mode');
    expect(() => storage.database('mistakes')).toThrow('Database mistakes is in maintenance mode');
    expect(() => storage.database('chat_v2')).toThrow('Database chat_v2 is in maintenance mode');

    expect(loaded.degraded.map(entry => entry.id)).toEqual(['dstu.notes']);
    await expect(host.invoke('notes_list', {})).rejects.toEqual({
      error_type: 'Database',
      message: 'MAINTENANCE_MODE: notes is temporarily unavailable',
      details: { code: 'MAINTENANCE', component: 'notes', reason: vfsReason },
    });

    const status = await host.invoke<{ id: string }[]>(HOST_STATUS_COMMAND, {});
    expect(status.map(entry => entry.id)).toEqual(['dstu.notes']);
    await expect(host.invoke('fixture_recovery_status', {})).resolves.toEqual({
      recovery: { reason: vfsReason, databases: ['mistakes', 'vfs', 'chat_v2'] },
      llmUsageTables: expect.any(Number),
    });
  }, 60_000);

  it('healthy start: no barrier, success payload without has_warnings', async () => {
    host = await createTestHost({ provide: { sqliteRuntime: nodeRuntime(await nodeSqlite()) } });
    await loadImportedProfile(host.runtime, [{ plugin: mobileStorage, source: 'test:storage-mobile' }]);
    await host.ctx.storage.runStartupFinalizers();
    const report = host.ctx.storage.startupMigrationReport()!;
    expect(report.success).toBe(true);
    expect(host.ctx.storage.startupMaintenance()).toBeNull();
    expect(host.ctx.storage.startupCoreRecovery()).toBeNull();
    expect(host.eventsNamed('data-governance-migration-status')).toEqual([{
      success: true,
      global_version: Math.max(...report.databases.map(db => db.toVersion)),
      migrations_applied: report.databases.reduce((sum, db) => sum + db.appliedCount, 0),
      duration_ms: report.totalDurationMs,
      warnings: [],
    }]);
  }, 60_000);

  it('handles taken before a re-run keep working after migrations reopen the file', async () => {
    const runtime = nodeRuntime(await nodeSqlite());
    const storage = new MobileStorageService({ runtime, baseDir: '/data' });
    try {
      await storage.migrations.runAll();
      const handle = storage.database('llm_usage');
      const before = handle.pluck<number>("SELECT COUNT(*) FROM sqlite_master WHERE type='table'");
      await storage.migrations.runAll();
      expect(storage.database('llm_usage')).toBe(handle);
      expect(handle.pluck<number>("SELECT COUNT(*) FROM sqlite_master WHERE type='table'")).toBe(before);
    } finally {
      storage.dispose();
    }
  }, 60_000);
});
