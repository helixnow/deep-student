import { describe, expect, it } from 'vitest';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
// boundary-allow cross-plugin-impl: L22 集成测试直接验证 L20 发布的生产 apply/history 实现
import { applyDownloadedChanges, applyDownloadedChangesWithConflictGuard, type ApplyChangesResult } from '../../sync/repository/apply.ts';
// boundary-allow cross-plugin-impl: L20 history 常量为生产实现的一部分
import { DEFAULT_MAX_BATCHES, REASON_POLICY_OVERRIDE, REASON_ROLLBACK_UNDO, newBatchId } from '../../sync/src/history.ts';
// boundary-allow cross-plugin-impl: L20 history repository 是被测生产实现
import { pruneBatchesToCap, rollbackBatch, snapshotRecordWithData } from '../../sync/repository/history.ts';
import { openTestDatabase, type TestDatabase } from './sync-fixture.ts';

/**
 * `sync_r11_history.rs` 行为级移植（除命令 e2e 外的 8 条）。
 *
 * 直接调用 L20 生产实现：冲突守卫覆盖前快照、快照去重、单批回退、
 * 回声抑制下的回退存活、未来时钟胜方回退、删除复活/撤销删除、保留策略。
 * 不复制快照/回退算法，也不替身被测函数。
 */
const suite = it;

function newDb(): TestDatabase {
  const db = openTestDatabase();
  db.exec(`
    CREATE TABLE resources (
        id TEXT PRIMARY KEY,
        content TEXT,
        updated_at TEXT
    );
    CREATE TABLE __change_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        table_name TEXT NOT NULL,
        record_id TEXT NOT NULL,
        operation TEXT NOT NULL CHECK(operation IN ('INSERT', 'UPDATE', 'DELETE')),
        changed_at TEXT NOT NULL DEFAULT (datetime('now')),
        sync_version INTEGER DEFAULT 0
    );
    CREATE TRIGGER trg_items_insert
    AFTER INSERT ON resources
    BEGIN
        INSERT INTO __change_log(table_name, record_id, operation)
        VALUES('resources', NEW.id, 'INSERT');
    END;
    CREATE TRIGGER trg_items_update
    AFTER UPDATE ON resources
    BEGIN
        INSERT INTO __change_log(table_name, record_id, operation)
        VALUES('resources', NEW.id, 'UPDATE');
    END;
    CREATE TRIGGER trg_items_delete
    AFTER DELETE ON resources
    BEGIN
        INSERT INTO __change_log(table_name, record_id, operation)
        VALUES('resources', OLD.id, 'DELETE');
    END;
  `);
  return db;
}

function seedLocallyEditedRow(db: TestDatabase, recordId: string, content: string, updatedAt: string): void {
  db.run(
    "INSERT INTO resources (id, content, updated_at) VALUES (?1, 'base', ?2)",
    [recordId, updatedAt],
  );
  db.run('UPDATE __change_log SET sync_version = 1 WHERE sync_version = 0');
  db.run('UPDATE resources SET content = ?2 WHERE id = ?1', [recordId, content]);
}

function cloudUpdate(recordId: string, content: string, ts: string): never {
  return {
    table_name: 'resources',
    record_id: recordId,
    operation: 'Update',
    data: { id: recordId, content, updated_at: ts },
    changed_at: ts,
    change_log_id: null,
    database_name: 'vfs',
    suppress_change_log: true,
    source_device_id: 'device-cloud',
    source_seq: 1,
  } as never;
}

function cloudDelete(recordId: string, ts: string): never {
  return {
    table_name: 'resources',
    record_id: recordId,
    operation: 'Delete',
    data: null,
    changed_at: ts,
    change_log_id: null,
    database_name: 'vfs',
    suppress_change_log: true,
    source_device_id: 'device-cloud',
    source_seq: 2,
  } as never;
}

function applyGuarded(
  db: TestDatabase,
  changes: readonly never[],
  policy: 'KeepCloud' | 'KeepLocal' | 'KeepLatest',
  cloudDevice = 'device-cloud',
): { apply: ApplyChangesResult; conflict: { conflicts_saved: number } } {
  return applyDownloadedChangesWithConflictGuard(
    db,
    changes,
    { deviceId: 'device-local' },
    { policy, cloudDeviceId: cloudDevice, localDeviceId: 'device-local' },
  );
}

function row(db: TestDatabase, recordId: string): { content: string; updated_at: string } | null {
  const value = db.get<{ content: string; updated_at: string }>(
    'SELECT content, updated_at FROM resources WHERE id = ?1',
    [recordId],
  );
  return value ?? null;
}

function snapshotRows(db: TestDatabase, recordId: string): Array<{
  batch_id: string;
  reason: string;
  existed: boolean;
  data_json: string | null;
}> {
  const exists = Number(db.pluck<number>(
    "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='__sync_record_history')",
  ) ?? 0) > 0;
  if (!exists) return [];
  return db.all<{ batch_id: string; reason: string; existed: number; data_json: string | null }>(
    `SELECT batch_id, reason, existed, data_json FROM __sync_record_history
     WHERE table_name = 'resources' AND record_id = ?1 ORDER BY id ASC`,
    [recordId],
  ).map(snap => ({ ...snap, existed: snap.existed !== 0 }));
}

function pendingChangeLogRows(db: TestDatabase, recordId: string): number {
  return Number(db.pluck<number>(
    `SELECT COUNT(*) FROM __change_log
     WHERE table_name = 'resources' AND record_id = ?1 AND sync_version = 0`,
    [recordId],
  ) ?? 0);
}

function overwriteWithPolicy(db: TestDatabase, recordId: string): string {
  seedLocallyEditedRow(db, recordId, 'local-edit', '2026-07-10T13:00:00Z');
  const { apply } = applyGuarded(db, [cloudUpdate(recordId, 'cloud-wins', '2026-07-10T14:00:00Z')], 'KeepCloud');
  expect(apply.success_count).toBe(1);
  expect(row(db, recordId)?.content).toBe('cloud-wins');
  const snapshot = snapshotRows(db, recordId);
  expect(snapshot).toHaveLength(1);
  return snapshot[0]!.batch_id;
}

describe('sync_r11_history.rs', () => {
  suite('r11_policy_override_snapshots_local_row_before_overwrite', () => {
    const db = newDb();
    overwriteWithPolicy(db, 'rec-snap');

    const snapshot = snapshotRows(db, 'rec-snap');
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0]!.reason).toBe(REASON_POLICY_OVERRIDE);
    expect(snapshot[0]!.existed).toBe(true);
    const data = JSON.parse(snapshot[0]!.data_json!) as { content?: string };
    expect(data.content).toBe('local-edit');
  });

  suite('r11_local_win_does_not_snapshot', () => {
    const db = newDb();
    seedLocallyEditedRow(db, 'rec-localwin', 'local-edit', '2026-07-10T13:00:00Z');

    const { conflict } = applyGuarded(
      db,
      [cloudUpdate('rec-localwin', 'cloud-loses', '2026-07-10T14:00:00Z')],
      'KeepLocal',
    );
    expect(conflict.conflicts_saved).toBeGreaterThan(0);
    expect(snapshotRows(db, 'rec-localwin')).toEqual([]);
  });

  suite('r11_snapshot_dedup_within_batch_keeps_first_state', () => {
    const db = newDb();
    const batch = newBatchId();
    const first = { id: 'rec-dedup', content: 'first' };
    const second = { id: 'rec-dedup', content: 'second' };

    expect(snapshotRecordWithData(db, batch, REASON_POLICY_OVERRIDE, 'resources', 'rec-dedup', first)).toBe(true);
    expect(snapshotRecordWithData(db, batch, REASON_POLICY_OVERRIDE, 'resources', 'rec-dedup', second)).toBe(false);

    const snapshot = snapshotRows(db, 'rec-dedup');
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0]!.data_json).toContain('first');
  });

  suite('r11_rollback_restores_record_and_leaves_pending_upload', () => {
    const db = newDb();
    const batch = overwriteWithPolicy(db, 'rec-rollback');
    db.run('UPDATE __change_log SET sync_version = 1 WHERE sync_version = 0');

    const outcome = rollbackBatch(db as DatabaseHandle, batch, null, 'vfs');
    expect(outcome.restored).toBe(1);
    expect(outcome.deleted).toBe(0);
    expect(row(db, 'rec-rollback')?.content).toBe('local-edit');
    expect(row(db, 'rec-rollback')!.updated_at > '2026-07-10T14:00:00Z').toBe(true);
    expect(pendingChangeLogRows(db, 'rec-rollback')).toBeGreaterThan(0);

    const rolledBackAt = db.pluck<string | null>(
      'SELECT MAX(rolled_back_at) FROM __sync_record_history WHERE batch_id = ?1',
      [batch],
    );
    expect(rolledBackAt).not.toBeNull();
    expect(() => rollbackBatch(db as DatabaseHandle, batch, null, 'vfs')).toThrow();

    const undoRows = snapshotRows(db, 'rec-rollback').filter(row =>
      row.batch_id === outcome.undo_batch_id && row.reason === REASON_ROLLBACK_UNDO);
    expect(undoRows).toHaveLength(1);
    expect(undoRows[0]!.data_json).toContain('cloud-wins');
  });

  suite('r11_rollback_not_reoverwritten_by_lww_replay_or_echo_suppression', () => {
    const db = newDb();
    const batch = overwriteWithPolicy(db, 'rec-replay');
    db.run('UPDATE __change_log SET sync_version = 1 WHERE sync_version = 0');
    rollbackBatch(db as DatabaseHandle, batch, null, 'vfs');
    const pendingBefore = pendingChangeLogRows(db, 'rec-replay');
    expect(pendingBefore).toBeGreaterThan(0);

    const replay = cloudUpdate('rec-replay', 'cloud-wins', '2026-07-10T14:00:00Z');
    const result = applyDownloadedChanges(db, [replay], { deviceId: 'device-local' });
    expect(result.success_count).toBe(0);
    expect(row(db, 'rec-replay')?.content).toBe('local-edit');
    expect(pendingChangeLogRows(db, 'rec-replay')).toBe(pendingBefore);

    const { apply } = applyGuarded(db, [replay], 'KeepLatest');
    expect(apply.success_count).toBe(0);
    expect(row(db, 'rec-replay')?.content).toBe('local-edit');
  });

  suite('r11_rollback_beats_accepted_future_skewed_cloud_winner', () => {
    const cloudTimestamp = new Date(Date.now() + 30_000).toISOString();

    const upsertDb = newDb();
    seedLocallyEditedRow(upsertDb, 'rec-future-upsert', 'local-edit', '2026-07-10T13:00:00Z');
    const { apply } = applyGuarded(
      upsertDb,
      [cloudUpdate('rec-future-upsert', 'future-cloud', cloudTimestamp)],
      'KeepCloud',
    );
    expect(apply.success_count).toBe(1);
    const upsertBatch = snapshotRows(upsertDb, 'rec-future-upsert')[0]!.batch_id;
    upsertDb.run('UPDATE __change_log SET sync_version = 1 WHERE sync_version = 0');

    rollbackBatch(upsertDb as DatabaseHandle, upsertBatch, null, 'vfs');
    const rollbackTimestamp = row(upsertDb, 'rec-future-upsert')!.updated_at;
    expect(Date.parse(rollbackTimestamp)).toBeGreaterThan(Date.parse(cloudTimestamp));

    const replay = applyDownloadedChanges(
      upsertDb,
      [cloudUpdate('rec-future-upsert', 'future-cloud', cloudTimestamp)],
      { deviceId: 'device-local' },
    );
    expect(replay.success_count).toBe(0);
    expect(row(upsertDb, 'rec-future-upsert')?.content).toBe('local-edit');
    expect(pendingChangeLogRows(upsertDb, 'rec-future-upsert')).toBeGreaterThan(0);

    const deleteDb = newDb();
    seedLocallyEditedRow(deleteDb, 'rec-future-delete', 'local-edit', '2026-07-10T13:00:00Z');
    const { apply: deleteApply } = applyGuarded(
      deleteDb,
      [cloudDelete('rec-future-delete', cloudTimestamp)],
      'KeepCloud',
    );
    expect(deleteApply.success_count).toBe(1);
    expect(row(deleteDb, 'rec-future-delete')).toBeNull();
    const deleteBatch = snapshotRows(deleteDb, 'rec-future-delete')[0]!.batch_id;

    const outcome = rollbackBatch(deleteDb as DatabaseHandle, deleteBatch, null, 'vfs');
    expect(outcome.restored).toBe(1);
    expect(row(deleteDb, 'rec-future-delete')?.content).toBe('local-edit');

    const deleteReplay = applyDownloadedChanges(
      deleteDb,
      [cloudDelete('rec-future-delete', cloudTimestamp)],
      { deviceId: 'device-local' },
    );
    expect(deleteReplay.success_count).toBe(0);
    expect(row(deleteDb, 'rec-future-delete')?.content).toBe('local-edit');
  });

  suite('r11_delete_overwrite_rollback_resurrects_then_undo_deletes_again', () => {
    const db = newDb();
    seedLocallyEditedRow(db, 'rec-del', 'local-edit', '2026-07-10T13:00:00Z');
    const { apply } = applyGuarded(
      db,
      [cloudDelete('rec-del', '2026-07-10T14:00:00Z')],
      'KeepCloud',
    );
    expect(apply.success_count).toBe(1);
    expect(row(db, 'rec-del')).toBeNull();

    const snapshot = snapshotRows(db, 'rec-del');
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0]!.existed).toBe(true);

    const outcome = rollbackBatch(db as DatabaseHandle, snapshot[0]!.batch_id, null, 'vfs');
    expect(outcome.restored).toBe(1);
    expect(row(db, 'rec-del')?.content).toBe('local-edit');

    const undoOutcome = rollbackBatch(db as DatabaseHandle, outcome.undo_batch_id, null, 'vfs');
    expect(undoOutcome.deleted).toBe(1);
    expect(row(db, 'rec-del')).toBeNull();
  });

  suite('r11_retention_caps_batches_and_prunes_oldest', () => {
    const db = newDb();
    const total = DEFAULT_MAX_BATCHES + 5;
    const batchIds: string[] = [];
    for (let index = 0; index < total; index += 1) {
      const batch = `batch-${String(index).padStart(4, '0')}`;
      snapshotRecordWithData(
        db,
        batch,
        REASON_POLICY_OVERRIDE,
        'resources',
        `rec-${index}`,
        { id: `rec-${index}`, content: 'x' },
      );
      batchIds.push(batch);
    }

    expect(Number(db.pluck<number>('SELECT COUNT(DISTINCT batch_id) FROM __sync_record_history'))).toBe(DEFAULT_MAX_BATCHES);
    expect(Number(db.pluck<number>(
      'SELECT COUNT(*) FROM __sync_record_history WHERE batch_id = ?1',
      [batchIds[0]!],
    ))).toBe(0);
    expect(Number(db.pluck<number>(
      'SELECT COUNT(*) FROM __sync_record_history WHERE batch_id = ?1',
      [batchIds[batchIds.length - 1]!],
    ))).toBe(1);

    pruneBatchesToCap(db, 3);
    expect(Number(db.pluck<number>('SELECT COUNT(DISTINCT batch_id) FROM __sync_record_history'))).toBe(3);
  });
});
