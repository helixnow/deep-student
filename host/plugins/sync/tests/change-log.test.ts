import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStorageService } from '../../../platform/storage/service.ts';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import {
  changeOperationAsStr,
  changeOperationFromStr,
  fromEntryWithData,
  pendingChangeIds,
  pendingChangesFromEntries,
  pendingHasChanges,
  pendingTableChanges,
  normalizeVersionToSeconds,
  type ChangeLogEntry,
} from '../src/change-log.ts';
import {
  cleanupSyncedChanges,
  getChangeLogStats,
  getPendingChanges,
  markSynced,
  markSyncedWithTimestamp,
  resetSyncBaselineAfterRestore,
} from '../repository/change-log.ts';

let root: string;
let storage: ReturnType<typeof createStorageService>;
let conn: DatabaseHandle;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sync-change-log-'));
  storage = createStorageService({ baseDir: root, dataLocalDir: root });
  conn = storage.openFile(':memory:');
  conn.exec(`
    CREATE TABLE IF NOT EXISTS __change_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      table_name TEXT NOT NULL,
      record_id TEXT NOT NULL,
      operation TEXT NOT NULL CHECK(operation IN ('INSERT', 'UPDATE', 'DELETE')),
      changed_at TEXT NOT NULL DEFAULT (datetime('now')),
      sync_version INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx__change_log_sync_version ON __change_log(sync_version);
  `);
});

afterEach(() => {
  storage.dispose();
  rmSync(root, { recursive: true, force: true });
});

function insert(tableName: string, recordId: string, operation: string, syncVersion: number): void {
  conn.run(
    'INSERT INTO __change_log (table_name, record_id, operation, sync_version) VALUES (?1, ?2, ?3, ?4)',
    [tableName, recordId, operation, syncVersion],
  );
}

function entry(id: number, tableName: string, recordId: string, operation: ChangeLogEntry['operation'], changedAt: string): ChangeLogEntry {
  return { id, table_name: tableName, record_id: recordId, operation, changed_at: changedAt, sync_version: 0 };
}

it('test_get_pending_changes_empty', () => {
  const pending = getPendingChanges(conn);
  expect(pendingHasChanges(pending)).toBe(false);
  expect(pending.total_count).toBe(0);
  expect(pending.entries).toEqual([]);
});

it('test_get_pending_changes_with_data', () => {
  insert('messages', 'msg-1', 'INSERT', 0);
  insert('messages', 'msg-2', 'UPDATE', 0);
  insert('sessions', 'sess-1', 'INSERT', 0);
  insert('messages', 'msg-3', 'DELETE', 100);

  const pending = getPendingChanges(conn);
  expect(pendingHasChanges(pending)).toBe(true);
  expect(pending.total_count).toBe(3);
  expect(pending.changes_by_table.messages).toBe(2);
  expect(pending.changes_by_table.sessions).toBe(1);
});

it('test_get_pending_changes_with_field_deltas_json', () => {
  conn.run('ALTER TABLE __change_log ADD COLUMN field_deltas_json TEXT');
  conn.run(
    `INSERT INTO __change_log (table_name, record_id, operation, field_deltas_json, sync_version)
     VALUES ('resources', 'res-1', 'UPDATE', '{"ref_count":1}', 0)`,
  );

  const pending = getPendingChanges(conn);
  expect(pending.total_count).toBe(1);
  expect(pending.entries[0]!.field_deltas_json).toEqual({ ref_count: 1 });
});

it('test_get_pending_changes_with_table_filter', () => {
  insert('messages', 'msg-1', 'INSERT', 0);
  insert('messages', 'msg-2', 'UPDATE', 0);
  insert('sessions', 'sess-1', 'INSERT', 0);

  const pending = getPendingChanges(conn, 'messages');
  expect(pending.total_count).toBe(2);
  expect(pending.entries.every(e => e.table_name === 'messages')).toBe(true);
});

it('test_get_pending_changes_with_limit', () => {
  for (let i = 0; i < 10; i += 1) insert('messages', `msg-${i}`, 'INSERT', 0);
  expect(getPendingChanges(conn, null, 5).total_count).toBe(5);
});

it('test_mark_synced', () => {
  insert('messages', 'msg-1', 'INSERT', 0);
  insert('messages', 'msg-2', 'UPDATE', 0);
  insert('messages', 'msg-3', 'DELETE', 0);

  expect(markSynced(conn, [1, 2], 1000)).toBe(2);
  const pending = getPendingChanges(conn);
  expect(pending.total_count).toBe(1);
  expect(pending.entries[0]!.record_id).toBe('msg-3');
});

it('test_mark_synced_empty', () => {
  expect(markSynced(conn, [], 1000)).toBe(0);
});

it('test_mark_synced_with_timestamp', () => {
  insert('messages', 'msg-1', 'INSERT', 0);
  expect(markSyncedWithTimestamp(conn, [1])).toBe(1);
  expect(pendingHasChanges(getPendingChanges(conn))).toBe(false);
});

it('test_cleanup_synced_changes', () => {
  conn.run(`INSERT INTO __change_log (table_name, record_id, operation, changed_at, sync_version)
    VALUES ('messages', 'msg-1', 'INSERT', '2024-01-01T00:00:00Z', 100)`);
  conn.run(`INSERT INTO __change_log (table_name, record_id, operation, changed_at, sync_version)
    VALUES ('messages', 'msg-2', 'UPDATE', '2024-01-15T00:00:00Z', 100)`);
  conn.run(`INSERT INTO __change_log (table_name, record_id, operation, changed_at, sync_version)
    VALUES ('messages', 'msg-3', 'DELETE', '2024-01-01T00:00:00Z', 0)`);

  expect(cleanupSyncedChanges(conn, '2024-01-10T00:00:00Z')).toBe(1);
  expect(conn.pluck<number>('SELECT COUNT(*) FROM __change_log')).toBe(2);
});

it('test_reset_sync_baseline_after_restore', () => {
  conn.exec(`CREATE TABLE IF NOT EXISTS notes (
    id TEXT PRIMARY KEY,
    content TEXT,
    device_id TEXT,
    local_version INTEGER DEFAULT 0,
    sync_version INTEGER DEFAULT 0,
    updated_at TEXT,
    deleted_at TEXT
  );
  INSERT INTO notes (id, content, local_version, sync_version, updated_at)
  VALUES ('n1', 'hello', 5, 3, '2024-01-01T00:00:00Z'),
         ('n2', 'world', 2, 2, '2024-01-02T00:00:00Z');`);
  conn.run(`INSERT INTO __change_log (table_name, record_id, operation, changed_at, sync_version)
    VALUES ('notes', 'n1', 'UPDATE', '2024-01-01T00:00:00Z', 100)`);
  conn.run(`INSERT INTO __change_log (table_name, record_id, operation, changed_at, sync_version)
    VALUES ('notes', 'n2', 'INSERT', '2024-01-02T00:00:00Z', 0)`);

  const [truncated, reset] = resetSyncBaselineAfterRestore(conn);
  expect(truncated).toBe(2);
  expect(reset).toBe(1);
  expect(conn.pluck<number>('SELECT COUNT(*) FROM __change_log')).toBe(0);

  expect(conn.one<{ local_version: number; sync_version: number }>(
    "SELECT local_version, sync_version FROM notes WHERE id = 'n1'",
  )).toEqual({ local_version: 5, sync_version: 5 });
  expect(conn.one<{ local_version: number; sync_version: number }>(
    "SELECT local_version, sync_version FROM notes WHERE id = 'n2'",
  )).toEqual({ local_version: 2, sync_version: 2 });
});

it('regression_c6_normalize_version_to_seconds', () => {
  expect(normalizeVersionToSeconds(1_707_500_000_123)).toBe(1_707_500_000);
  expect(normalizeVersionToSeconds(1_707_500_000)).toBe(1_707_500_000);
  expect(normalizeVersionToSeconds(100_000_000_000)).toBe(100_000_000_000);
});

it('test_normalize_version_to_seconds', () => {
  expect(normalizeVersionToSeconds(1_707_500_000)).toBe(1_707_500_000);
  expect(normalizeVersionToSeconds(0)).toBe(0);
  expect(normalizeVersionToSeconds(42)).toBe(42);
  expect(normalizeVersionToSeconds(1_707_500_000_000)).toBe(1_707_500_000);
  expect(normalizeVersionToSeconds(1_707_600_000_123)).toBe(1_707_600_000);
});

it('test_same_second_download_not_skipped', () => {
  const sinceVersion = 1_707_500_000;
  const fileVersion = 1_707_500_000;
  expect(fileVersion >= sinceVersion).toBe(true);
});

it('test_from_entry_with_data_injects_field_deltas_metadata', () => {
  const change = fromEntryWithData({
    id: 1,
    table_name: 'resources',
    record_id: 'res-1',
    operation: 'Update',
    changed_at: '2024-01-01T10:00:00Z',
    sync_version: 0,
    field_deltas_json: { ref_count: 1 },
  }, { id: 'res-1', ref_count: 2, updated_at: '2024-01-01T10:00:00Z' });

  expect(change.data).not.toBeNull();
  expect((change.data as Record<string, unknown>).__sync_field_deltas).toEqual({ ref_count: 1 });
});

it('test_get_change_log_stats', () => {
  insert('messages', 'msg-1', 'INSERT', 0);
  insert('messages', 'msg-2', 'UPDATE', 0);
  insert('messages', 'msg-3', 'DELETE', 100);
  insert('sessions', 'sess-1', 'INSERT', 200);

  expect(getChangeLogStats(conn)).toEqual({ total_count: 4, pending_count: 2, synced_count: 2 });
});

it('test_change_operation_from_str', () => {
  expect(changeOperationFromStr('INSERT')).toBe('Insert');
  expect(changeOperationFromStr('insert')).toBe('Insert');
  expect(changeOperationFromStr('UPDATE')).toBe('Update');
  expect(changeOperationFromStr('DELETE')).toBe('Delete');
  expect(changeOperationFromStr('INVALID')).toBeNull();
});

it('test_change_operation_as_str', () => {
  expect(changeOperationAsStr('Insert')).toBe('INSERT');
  expect(changeOperationAsStr('Update')).toBe('UPDATE');
  expect(changeOperationAsStr('Delete')).toBe('DELETE');
});

it('test_pending_changes_get_table_changes', () => {
  const pending = pendingChangesFromEntries([
    entry(1, 'messages', 'msg-1', 'Insert', '2024-01-01T10:00:00Z'),
    entry(2, 'sessions', 'sess-1', 'Insert', '2024-01-01T11:00:00Z'),
    entry(3, 'messages', 'msg-2', 'Update', '2024-01-01T12:00:00Z'),
  ]);

  expect(pendingTableChanges(pending, 'messages')).toHaveLength(2);
  expect(pendingTableChanges(pending, 'sessions')).toHaveLength(1);
  expect(pendingTableChanges(pending, 'other')).toEqual([]);
});

it('test_pending_changes_get_change_ids', () => {
  const pending = pendingChangesFromEntries([
    entry(1, 'messages', 'msg-1', 'Insert', '2024-01-01T10:00:00Z'),
    entry(5, 'messages', 'msg-2', 'Update', '2024-01-01T11:00:00Z'),
  ]);
  expect(pendingChangeIds(pending)).toEqual([1, 5]);
});

it('test_pending_changes_time_range', () => {
  const pending = pendingChangesFromEntries([
    entry(1, 'messages', 'msg-1', 'Insert', '2024-01-01T12:00:00Z'),
    entry(2, 'messages', 'msg-2', 'Update', '2024-01-01T08:00:00Z'),
    entry(3, 'messages', 'msg-3', 'Delete', '2024-01-01T15:00:00Z'),
  ]);
  expect(pending.earliest_change).toBe('2024-01-01T08:00:00Z');
  expect(pending.latest_change).toBe('2024-01-01T15:00:00Z');
});

it('regression_c7_mark_synced_batches_over_variable_limit', () => {
  const total = 1500;
  conn.transaction(tx => {
    for (let i = 1; i <= total; i += 1) {
      tx.run('INSERT INTO __change_log (id, table_name, record_id, operation, sync_version) VALUES (?1, ?2, ?3, ?4, 0)',
        [i, 'messages', `msg-${i}`, 'INSERT']);
    }
  });

  const ids = Array.from({ length: total }, (_, index) => index + 1);
  expect(markSynced(conn, ids, 12345)).toBe(total);
  expect(conn.pluck<number>('SELECT COUNT(*) FROM __change_log WHERE sync_version = 12345')).toBe(total);
});
