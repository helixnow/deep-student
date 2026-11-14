import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createStorageService } from '../../../platform/storage/service.ts';
import type { MasteryProfileSink } from '../../review/api.ts';
import review from '../../review/index.ts';
import backup from '../../backup/index.ts';
import sync from '../index.ts';
import type { EngineChange } from '../src/change-payload.ts';
import { createManifest } from '../src/merge.ts';
import { createTestHost } from './host-fixture.ts';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

async function fixture(sink?: MasteryProfileSink) {
  const root = mkdtempSync(join(tmpdir(), 'sync-mastery-'));
  const storage = createStorageService({ baseDir: root, dataLocalDir: root });
  const db = storage.database('vfs');
  db.exec(`CREATE TABLE __change_log(id INTEGER PRIMARY KEY, table_name TEXT, record_id TEXT,
    operation TEXT, changed_at TEXT, sync_version INTEGER DEFAULT 0);`);
  for (const name of ['V20260718__add_mastery_tables.sql', 'V20260719__mastery_events_signal.sql',
    'V20260720__mastery_events_sync.sql', 'V20260909__mastery_events_insight_source.sql']) {
    db.exec(readFileSync(`resources/app/migrations/vfs/${name}`, 'utf8'));
  }
  const host = await createTestHost({ app: { dataDir: root }, plugins: [review, backup, sync], provide: {
    storage, mastery: undefined, backup: undefined, masteryProfileSink: sink,
    settings: { get: () => null }, paths: { deviceId: async () => 'mastery-receiver' },
  } });
  cleanups.push(async () => { await host.dispose(); storage.dispose(); rmSync(root, { recursive: true, force: true }); });
  const writeImport = (changes: EngineChange[]) => {
    const file = join(root, 'import.json');
    writeFileSync(file, JSON.stringify({ manifest: createManifest('mastery-sender', {}),
      pending_changes: changes, exported_at: '2026-01-01T00:00:00Z' }));
    return file;
  };
  return { host, db, writeImport };
}

function event(id: string): EngineChange {
  return { database_name: 'vfs', table_name: 'mastery_events', record_id: id, operation: 'Insert',
    changed_at: '2026-01-01T00:00:00Z', data: { id, created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z', source: 'qbank', concept_key: '代数', item_id: id,
      outcome: 'wrong', weight: 1, signal: 0 } };
}

// commands_sync.rs:2694-2749 → commands_backup.rs:518-601; real review owns all mastery calls.
it('import_sync_data injects real mastery, rebuilds committed evidence and returns the Rust response', async () => {
  const reflux: Array<{ concept: string; total: number; inTransaction: boolean | undefined }> = [];
  const { host, db, writeImport } = await fixture({
    upsertWeakPointFromMastery: (conn, concept, evidence) => {
      reflux.push({ concept, total: evidence.total, inTransaction: conn.inTransaction });
      expect(conn.pluck('SELECT COUNT(*) FROM mastery_events')).toBe(3);
    },
    removeWeakPointFromMastery: () => { throw new Error('unexpected recovered concept'); },
  });
  const inputPath = writeImport([event('a'), event('b'), event('c')]);
  await expect(host.invoke('data_governance_import_sync_data', { inputPath })).resolves.toEqual({
    success: true, imported_changes: 3, conflicts_detected: 0,
    needs_manual_resolution: false, error_message: null,
  });
  expect(host.ctx.mastery.getState('代数')).toMatchObject({ total: 3, wrongCount: 3, streak: 0,
    lastSignalAt: '2026-01-01T00:00:00Z' });
  expect(reflux).toEqual([{ concept: '代数', total: 3, inTransaction: false }]);
  expect(db.pluck('SELECT COUNT(*) FROM __change_log WHERE sync_version = 0')).toBe(0);
  expect(host.events).toEqual([]);
  const permit = host.ctx.backup.tryAcquireOperation('backup'); permit.release();
});

it('public multi-database apply uses real mastery for remote tombstones and profile recovery', async () => {
  const removed: string[] = [];
  const { host, db } = await fixture({
    upsertWeakPointFromMastery: () => { throw new Error('unexpected weak concept'); },
    removeWeakPointFromMastery: (_conn, concept) => { removed.push(concept); },
  });
  await expect(host.ctx.sync.applyDownloadedChangesToDatabases([event('a')], 'KeepLatest'))
    .resolves.toMatchObject({ total_success: 1, total_failed: 0 });
  expect(host.ctx.mastery.getState('代数')?.total).toBe(1);
  await expect(host.ctx.sync.applyDownloadedChangesToDatabases([
    { ...event('a'), operation: 'Delete', data: null, changed_at: '2026-01-02T00:00:00Z' },
  ], 'KeepLatest')).resolves.toMatchObject({ total_success: 1, total_failed: 0 });
  expect(host.ctx.mastery.getState('代数')).toEqual({ conceptKey: '代数', score: 0.5,
    total: 0, wrongCount: 0, streak: 0, lastSignalAt: null });
  expect(db.pluck("SELECT deleted_at FROM mastery_events WHERE id = 'a'")).not.toBeNull();
  expect(removed).toEqual(['代数']);
});

it('import_sync_data preserves rebuild error text and the already committed event transaction', async () => {
  const { host, db, writeImport } = await fixture();
  db.exec(`CREATE TRIGGER reject_mastery_state BEFORE INSERT ON mastery_states
    BEGIN SELECT RAISE(ABORT, 'mastery state write denied'); END;`);
  const inputPath = writeImport([event('a')]);
  await expect(host.invoke('data_governance_import_sync_data', { inputPath })).rejects.toBe(
    '应用导入变更失败: 同步 mastery_events 后重建 mastery_states 失败: upsert mastery_states: mastery state write denied。请检查导入文件完整性后重试');
  // Rust recomputes after apply's COMMIT: derived-state failure must not roll back source evidence.
  expect(db.pluck('SELECT COUNT(*) FROM mastery_events')).toBe(1);
  expect(db.pluck('SELECT COUNT(*) FROM mastery_states')).toBe(0);
  const permit = host.ctx.backup.tryAcquireOperation('backup'); permit.release();
});

it('import_sync_data preserves profile error text after source and derived state commit', async () => {
  const { host, db, writeImport } = await fixture({
    upsertWeakPointFromMastery: () => { throw new Error('profile write denied'); },
    removeWeakPointFromMastery: () => { throw new Error('unexpected recovered concept'); },
  });
  const inputPath = writeImport([event('a'), event('b'), event('c')]);
  await expect(host.invoke('data_governance_import_sync_data', { inputPath })).rejects.toBe(
    '应用导入变更失败: 同步 mastery learner profile 失败: profile write denied。请检查导入文件完整性后重试');
  expect(db.pluck('SELECT COUNT(*) FROM mastery_events')).toBe(3);
  expect(host.ctx.mastery.getState('代数')?.total).toBe(3);
  const permit = host.ctx.backup.tryAcquireOperation('backup'); permit.release();
});

it('import_sync_data keeps invalid-strategy errors and releases the real permit before retry', async () => {
  const { host, db, writeImport } = await fixture();
  const inputPath = writeImport([event('a')]);
  await expect(host.invoke('data_governance_import_sync_data', { inputPath, strategy: 'invalid' })).rejects.toBe(
    '无效的合并策略: invalid。可选值: keep_local, use_cloud, keep_latest, manual');
  expect(db.pluck('SELECT COUNT(*) FROM mastery_events')).toBe(0);
  const permit = host.ctx.backup.tryAcquireOperation('backup'); permit.release();
  await expect(host.invoke('data_governance_import_sync_data', { inputPath })).resolves.toMatchObject({
    success: true, imported_changes: 1, error_message: null,
  });
});
