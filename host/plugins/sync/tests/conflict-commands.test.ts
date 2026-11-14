import './local-runtime-fixture.ts';
import { describe, expect, it } from 'vitest';
import { CommandError } from '../../../kernel/api.ts';
import type { CoordinatedDatabaseName, StorageService } from '../../../platform/storage/api.ts';
import { resolveRecordConflict, rollbackSyncSnapshotBatch } from '../src/conflict-commands.ts';
import { snapshotRecordWithData } from '../repository/history.ts';
import { getRecordData } from '../repository/record-data.ts';
import { openTestDatabase, type TestDatabase } from './test-db.ts';

const suite = describe;

function storageFor(db: TestDatabase): StorageService {
  return {
    pathOf: (name: CoordinatedDatabaseName) => (name === 'vfs' ? '/tmp' : `/nonexistent/${name}.db`),
    openFile: () => db,
    close: () => undefined,
  } as unknown as StorageService;
}

function createDb(): TestDatabase {
  const db = openTestDatabase();
  db.exec(`
    CREATE TABLE __change_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        table_name TEXT NOT NULL,
        record_id TEXT NOT NULL,
        operation TEXT NOT NULL,
        changed_at TEXT NOT NULL DEFAULT (datetime('now')),
        sync_version INTEGER DEFAULT 0
    );
    CREATE TABLE __sync_conflicts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        table_name TEXT NOT NULL,
        record_id TEXT NOT NULL,
        side TEXT NOT NULL CHECK(side IN ('local','cloud')),
        data_json TEXT NOT NULL,
        data_hash TEXT NOT NULL DEFAULT '',
        winning_device_id TEXT,
        losing_device_id TEXT,
        detected_at TEXT NOT NULL DEFAULT (datetime('now')),
        resolved_at TEXT,
        resolution TEXT
    );
    CREATE TABLE __sync_record_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        batch_id TEXT NOT NULL,
        reason TEXT NOT NULL,
        table_name TEXT NOT NULL,
        record_id TEXT NOT NULL,
        existed INTEGER NOT NULL CHECK(existed IN (0,1)),
        data_json TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        rolled_back_at TEXT
    );
    CREATE UNIQUE INDEX idx__sync_record_history_dedup
        ON __sync_record_history(batch_id, table_name, record_id);
    CREATE TABLE notes (
        id TEXT PRIMARY KEY,
        title TEXT,
        updated_at TEXT,
        local_version INTEGER DEFAULT 0
    );
  `);
  return db;
}

function seedConflict(db: TestDatabase, local: unknown, cloud: unknown): number[] {
  const insert = db.run(
    `INSERT INTO __sync_conflicts (table_name, record_id, side, data_json)
     VALUES ('notes', 'note-1', ?1, ?2)`,
    ['local', JSON.stringify(local)],
  );
  const localId = Number(insert.lastInsertRowid);
  const cloudInsert = db.run(
    `INSERT INTO __sync_conflicts (table_name, record_id, side, data_json)
     VALUES ('notes', 'note-1', ?1, ?2)`,
    ['cloud', JSON.stringify(cloud)],
  );
  return [localId, Number(cloudInsert.lastInsertRowid)];
}

suite('conflict commands', () => {
  it('resolve_record_conflict_keep_cloud_writes_business_row_and_marks_resolved', () => {
    const db = createDb();
    db.run(
      "INSERT INTO notes (id, title, updated_at) VALUES ('note-1', 'local', '2026-01-01T00:00:00Z')",
    );
    db.run(
      "INSERT INTO __change_log (table_name, record_id, operation, sync_version) VALUES ('notes', 'note-1', 'UPDATE', 0)",
    );
    const ids = seedConflict(
      db,
      getRecordData(db, 'notes', 'note-1', 'id'),
      { id: 'note-1', title: 'cloud', updated_at: '2026-01-02T00:00:00Z' },
    );

    resolveRecordConflict(storageFor(db), 'vfs', 'notes', 'note-1', 'keep_cloud', null, ids);

    expect(db.pluck<string>('SELECT title FROM notes WHERE id = ?1', ['note-1'])).toBe('cloud');
    expect(Number(db.pluck<number>('SELECT COUNT(*) FROM __sync_conflicts WHERE resolved_at IS NULL'))).toBe(0);
    expect(Number(db.pluck<number>('SELECT COUNT(*) FROM __sync_record_history'))).toBe(1);
  });

  it('resolve_record_conflict_rejects_stale_generation', () => {
    const db = createDb();
    db.run("INSERT INTO notes (id, title) VALUES ('note-1', 'local')");
    const ids = seedConflict(db, getRecordData(db, 'notes', 'note-1', 'id'), { id: 'note-1', title: 'cloud' });

    expect(() => resolveRecordConflict(storageFor(db), 'vfs', 'notes', 'note-1', 'keep_cloud', null, [ids[1] as number]))
      .toThrow('冲突已在后台变化，旧决策未执行；请刷新后重新确认');
    expect(Number(db.pluck<number>('SELECT COUNT(*) FROM __sync_conflicts WHERE resolved_at IS NULL'))).toBe(2);
  });

  it('resolve_record_conflict_rejects_unknown_database', () => {
    const db = createDb();
    expect(() => resolveRecordConflict(storageFor(db), 'unknown', 'notes', 'note-1', 'keep_cloud', null, [1]))
      .toThrow('未知数据库: unknown');
  });

  it('resolve_record_conflict_requires_expected_ids', () => {
    const db = createDb();
    expect(() => resolveRecordConflict(storageFor(db), 'vfs', 'notes', 'note-1', 'keep_cloud', null, []))
      .toThrow('缺少冲突版本标识，请刷新冲突列表后重试');
  });

  it('rollback_snapshot_batch_restores_snapshot_and_marks_batch', () => {
    const db = createDb();
    db.run(
      "INSERT INTO notes (id, title, updated_at) VALUES ('note-1', 'current', '2026-01-02T00:00:00Z')",
    );
    snapshotRecordWithData(db, 'batch-1', 'policy_override', 'notes', 'note-1',
      { id: 'note-1', title: 'snapshot', updated_at: '2026-01-01T00:00:00Z' });

    const outcome = rollbackSyncSnapshotBatch(storageFor(db), 'vfs', 'batch-1');
    expect(outcome.restored).toBe(1);
    expect(outcome.deleted).toBe(0);
    expect(outcome.skipped).toBe(0);
    expect(db.pluck<string>('SELECT title FROM notes WHERE id = ?1', ['note-1'])).toBe('snapshot');
    expect(db.pluck<string>('SELECT rolled_back_at FROM __sync_record_history WHERE batch_id = ?1', ['batch-1']))
      .not.toBeNull();
    expect(Number(db.pluck<number>(
      "SELECT COUNT(*) FROM __sync_record_history WHERE reason = 'rollback_undo' AND batch_id = ?1",
      [outcome.undo_batch_id],
    ))).toBe(1);
  });

  it('rollback_snapshot_batch_rejects_second_rollback', () => {
    const db = createDb();
    db.run("INSERT INTO notes (id, title) VALUES ('note-1', 'current')");
    snapshotRecordWithData(db, 'batch-1', 'policy_override', 'notes', 'note-1', { id: 'note-1', title: 'snapshot' });
    rollbackSyncSnapshotBatch(storageFor(db), 'vfs', 'batch-1');
    expect(() => rollbackSyncSnapshotBatch(storageFor(db), 'vfs', 'batch-1'))
      .toThrow(/已回退过/);
  });

  it('rollback_snapshot_batch_deletes_record_missing_at_snapshot', () => {
    const db = createDb();
    db.run("INSERT INTO notes (id, title) VALUES ('note-1', 'current')");
    snapshotRecordWithData(db, 'batch-1', 'policy_override', 'notes', 'note-1', null);
    const outcome = rollbackSyncSnapshotBatch(storageFor(db), 'vfs', 'batch-1');
    expect(outcome.deleted).toBe(1);
    expect(Number(db.pluck<number>('SELECT COUNT(*) FROM notes'))).toBe(0);
  });

  it('resolve_record_conflict_keep_local_restores_recorded_local_after_cloud_overwrite', () => {
    const db = createDb();
    db.run(
      "INSERT INTO notes (id, title, updated_at) VALUES ('note-1', 'cloud', '2026-01-02T00:00:00Z')",
    );
    const cloudRow = getRecordData(db, 'notes', 'note-1', 'id');
    db.run("UPDATE notes SET title = 'local', updated_at = '2026-01-01T00:00:00Z' WHERE id = 'note-1'");
    const localRow = getRecordData(db, 'notes', 'note-1', 'id');
    db.run("UPDATE notes SET title = 'cloud', updated_at = '2026-01-02T00:00:00Z' WHERE id = 'note-1'");
    const ids = seedConflict(db, localRow, cloudRow);
    resolveRecordConflict(storageFor(db), 'vfs', 'notes', 'note-1', 'keep_local', null, ids);
    expect(db.pluck<string>('SELECT title FROM notes WHERE id = ?1', ['note-1'])).toBe('local');
  });

  it('resolve_record_conflict_merged_requires_payload', () => {
    const db = createDb();
    db.run("INSERT INTO notes (id, title) VALUES ('note-1', 'local')");
    const ids = seedConflict(db, getRecordData(db, 'notes', 'note-1', 'id'), { id: 'note-1', title: 'cloud' });
    expect(() => resolveRecordConflict(storageFor(db), 'vfs', 'notes', 'note-1', 'merged', null, ids))
      .toThrow("resolution='merged' 时必须提供 merged_data_json");
  });

  it('resolve_record_conflict_without_cloud_side_reports_actionable_error', () => {
    const db = createDb();
    db.run("INSERT INTO notes (id, title) VALUES ('note-1', 'local')");
    const insert = db.run(
      `INSERT INTO __sync_conflicts (table_name, record_id, side, data_json)
       VALUES ('notes', 'note-1', 'local', ?1)`,
      [JSON.stringify(getRecordData(db, 'notes', 'note-1', 'id'))],
    );
    expect(() => resolveRecordConflict(storageFor(db), 'vfs', 'notes', 'note-1', 'keep_cloud', null, [Number(insert.lastInsertRowid)]))
      .toThrow('找不到该冲突的 cloud side 数据');
  });

  it('rollback_snapshot_batch_unknown_database_uses_rust_error', () => {
    const db = createDb();
    expect(() => rollbackSyncSnapshotBatch(storageFor(db), 'nope', 'batch-1')).toThrow(CommandError);
    expect(() => rollbackSyncSnapshotBatch(storageFor(db), 'nope', 'batch-1')).toThrow('未知数据库: nope');
  });
});
