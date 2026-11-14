import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { createTestHost } from './host-fixture.ts';
import { createTestHost as createBareHost } from '../../../kernel/testing.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import sync from '../index.ts';
import { mergeField } from '../api.ts';
import { setDefaultNoteHistory } from '../repository/apply.ts';

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

it('publishes sync through the Host lifecycle', async () => {
  const host = await createTestHost({ plugins: [sync], provide: { storage: {}, paths: { deviceId: async () => 'test-device' } } });
  try {
    expect(host.ctx.sync.parseHlc('1700000000123-42')?.toString()).toBe('001700000000123-00042');
    expect(host.ctx.get('sync@1')).toBeUndefined();
  } finally {
    await host.dispose();
  }
});

it('test_checksum_detects_content_drift_without_updated_at_change', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sync-checksum-'));
  dirs.push(dir);
  const storage = createStorageService({ baseDir: dir, dataLocalDir: dir });
  const db = storage.openFile(join(dir, 'checksum.db'), { profile: 'plain' });
  db.exec(`CREATE TABLE refinery_schema_history(version INTEGER);
    CREATE TABLE notes(id TEXT PRIMARY KEY, title TEXT, body TEXT, updated_at TEXT, deleted_at TEXT);
    INSERT INTO notes VALUES ('note-1', 'Title', 'before', '2026-01-01T00:00:00Z', NULL);`);
  const host = await createTestHost({ plugins: [sync], provide: { storage, paths: {} } });
  try {
    const before = host.ctx.sync.getDatabaseSyncState(db, 'vfs').checksum;
    db.run("UPDATE notes SET body = 'after' WHERE id = 'note-1'");
    const after = host.ctx.sync.getDatabaseSyncState(db, 'vfs').checksum;
    expect(before).not.toBe(after);
    expect(db.pluck('SELECT COUNT(*) FROM notes')).toBe(1);
    expect(db.pluck('SELECT updated_at FROM notes')).toBe('2026-01-01T00:00:00Z');
  } finally {
    storage.close(db);
    await host.dispose();
  }
});

it('publishes the engine apply/pending API through sync', async () => {
  const host = await createTestHost({ plugins: [sync], provide: { storage: {}, paths: { deviceId: async () => 'test-device' } } });
  // 该测试只验证引擎 API 接线；无 notes@1 时按 L20 既有约定关闭笔记钩子。
  setDefaultNoteHistory(null);
  const dir = mkdtempSync(join(tmpdir(), 'sync-plugin-engine-'));
  dirs.push(dir);
  const storage = createStorageService({ baseDir: dir, dataLocalDir: dir });
  await storage.migrations.runAll();
  const db = storage.openFile(storage.pathOf('vfs'), { profile: 'plain' });
  try {
    db.exec('CREATE TABLE test_records (id TEXT PRIMARY KEY, content TEXT, updated_at TEXT)');
    const service = host.ctx.sync;
    const result = service.applyDownloadedChanges(db, [{
      table_name: 'test_records',
      record_id: 'r1',
      operation: 'Insert',
      data: { id: 'r1', content: 'cloud', updated_at: '2026-02-10T00:00:00Z' },
      changed_at: '2026-02-10T00:00:00Z',
      suppress_change_log: true,
    }], { deviceId: 'device-local', allowSyncTestFixtureTables: true });
    expect(result.success_count).toBe(1);
    expect(result.failure_count).toBe(0);
    expect(result.skipped_count).toBe(0);
    expect(result.applied_keys.has('test_records\u001fr1')).toBe(true);
    expect(db.pluck('SELECT content FROM test_records WHERE id = ?1', ['r1'])).toBe('cloud');
    expect(service.getPendingChanges(db).total_count).toBe(0);
    expect(service.hasPruneGap(5n, 10n)).toBe(true);
    expect(service.hasPruneGap(10n, 10n)).toBe(false);
  } finally {
    storage.close(db);
    await host.dispose();
  }
});

it('regression_j8c_resources_data_merges_learner_profiles', async () => {
  const host = await createTestHost({ plugins: [sync], provide: { storage: {}, paths: { deviceId: async () => 'test-device' } } });
  try {
    const profile = (version: number, updatedAt: string, goal: string) => JSON.stringify({
      version,
      updated_at: updatedAt,
      weak_points: [],
      preferences: { explanation_style: null, language: null, pace: null, others: [] },
      goals: [{ goal, deadline: null }],
      recent_status: null,
      last_promotion_fingerprint: null,
    });
    // src/sync_app_tests.rs:13-57: app 组合根注册 memory 的 merger 后，
    // merge_field("resources","data") 对两侧画像 JSON 做结构化合并。
    const [result, changed, conflict] = mergeField(
      'resources',
      'data',
      profile(3, '2026-07-19T10:00:00+00:00', '本地目标'),
      profile(4, '2026-07-19T11:00:00+00:00', '远端目标'),
    );
    expect(changed).toBe(true);
    expect(conflict).toBe(false);
    const merged = JSON.parse(result as string) as { version: number; goals: Array<{ goal: string }> };
    expect(merged.version).toBe(5);
    expect(merged.goals.map(goal => goal.goal)).toContain('本地目标');
    expect(merged.goals.map(goal => goal.goal)).toContain('远端目标');
  } finally {
    await host.dispose();
  }
});

it('waits for declared cross-plugin services before registering sync', async () => {
  await expect(createBareHost({ plugins: [sync], provide: {
    storage: {}, paths: { deviceId: async () => 'test-device' },
  } })).rejects.toThrow('required services not available: "notes", "backup", "syncProvider", "secrets", "vfsDatabase", "syncSupport", "nativeCompression"');
});

it('published write commands require the backup provider before plugin activation', async () => {
  await expect(createTestHost({ plugins: [sync], provide: { storage: {}, paths: {}, backup: undefined } })).rejects.toThrow('backup');
  const host = await createTestHost({ plugins: [sync], provide: {
    storage: {}, paths: { deviceId: async () => 'test-device' }, backup: {
      tryAcquireOperation: () => { throw new Error('required operation provider failure'); },
    },
  } });
  try {
    for (const name of ['import_sync_data', 'resolve_record_conflict', 'rollback_sync_snapshot_batch']) {
      expect(host.ctx.commands.has(`data_governance_${name}`)).toBe(true);
    }
    await expect(host.invoke('data_governance_rollback_sync_snapshot_batch', { databaseName: 'vfs', batchId: 'batch' })).rejects.toBe('required operation provider failure');
  } finally {
    await host.dispose();
  }
});
