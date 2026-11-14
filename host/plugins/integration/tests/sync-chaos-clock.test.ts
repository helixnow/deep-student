import { describe, expect, it } from 'vitest';
// boundary-allow cross-plugin-impl: L22 集成测试直接验证 L20 发布的生产冲突守卫/LWW 实现
import { applyDownloadedChangesWithConflictGuard, type ApplyChangesResult } from '../../sync/repository/apply.ts';
// boundary-allow cross-plugin-impl: L20 tombstone 校验子是被测生产实现
import { validateTombstoneTimestamp } from '../../sync/repository/tombstone.ts';
// boundary-allow cross-plugin-impl: L20 错误类型用于断言时钟漂移分类
import { ClockDriftSuspectedError } from '../../sync/src/errors.ts';
import { openTestDatabase, type TestDatabase } from './sync-fixture.ts';

/**
 * `sync_r10_chaos_clock.rs` 的 TS 行为级移植。
 *
 * 直接调用 L20 生产 `applyDownloadedChangesWithConflictGuard`（LWW 门、冲突表、
 * 隔离区）与 `validateTombstoneTimestamp`，用内存 SQLite 构造慢钟/回拨/快钟场景。
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
  `);
  return db;
}

function upsertChange(
  recordId: string,
  content: string,
  updatedAt: string,
  sourceDeviceId: string,
  sourceSeq: number,
): never {
  return {
    table_name: 'resources',
    record_id: recordId,
    operation: 'Update',
    data: { id: recordId, content, updated_at: updatedAt },
    changed_at: updatedAt,
    change_log_id: null,
    database_name: 'vfs',
    suppress_change_log: true,
    source_device_id: sourceDeviceId,
    source_seq: sourceSeq,
  } as never;
}

function deleteChange(
  recordId: string,
  changedAt: string,
  sourceDeviceId: string,
  sourceSeq: number,
): never {
  return {
    table_name: 'resources',
    record_id: recordId,
    operation: 'Delete',
    data: null,
    changed_at: changedAt,
    change_log_id: null,
    database_name: 'vfs',
    suppress_change_log: true,
    source_device_id: sourceDeviceId,
    source_seq: sourceSeq,
  } as never;
}

function applyGuarded(
  db: TestDatabase,
  changes: readonly never[],
  cloudDevice: string,
): ApplyChangesResult {
  return applyDownloadedChangesWithConflictGuard(
    db,
    changes,
    { deviceId: 'device-local' },
    { policy: 'KeepLatest', cloudDeviceId: cloudDevice, localDeviceId: 'device-local' },
  ).apply;
}

function itemRow(db: TestDatabase, recordId: string): { content: string; updated_at: string } | null {
  return db.get<{ content: string; updated_at: string }>(
    'SELECT content, updated_at FROM resources WHERE id = ?1',
    [recordId],
  ) ?? null;
}

function conflictRows(db: TestDatabase, recordId: string): Array<{
  side: string;
  data_json: string;
  losing_device_id: string | null;
}> {
  return db.all<{ side: string; data_json: string; losing_device_id: string | null }>(
    `SELECT side, data_json, losing_device_id FROM __sync_conflicts
     WHERE table_name = 'resources' AND record_id = ?1 ORDER BY id`,
    [recordId],
  );
}

describe('sync_r10_chaos_clock.rs', () => {
  suite('r10_chaos_slow_clock_update_loses_lww_and_lands_in_conflicts', () => {
    const db = newDb();
    db.run("INSERT INTO resources (id, content, updated_at) VALUES ('rec-slow', 'newer-local', '2026-07-10T13:00:00Z')");
    const stale = upsertChange('rec-slow', 'slow-clock-overwrite', '2026-07-10T12:00:00Z', 'device-slow', 1);

    for (let round = 0; round < 3; round += 1) {
      const result = applyGuarded(db, [stale], 'device-slow');
      expect(result.success_count).toBe(0);
      expect(result.failure_count).toBe(0);
      expect(result.skipped_count).toBe(1);
    }

    expect(itemRow(db, 'rec-slow')).toEqual({
      content: 'newer-local',
      updated_at: '2026-07-10T13:00:00Z',
    });
    const conflicts = conflictRows(db, 'rec-slow');
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.side).toBe('cloud');
    expect(conflicts[0]!.data_json).toContain('slow-clock-overwrite');
    expect(conflicts[0]!.losing_device_id).toBe('device-slow');
  });

  suite('r10_chaos_clock_rollback_same_device_cannot_overwrite_newer_state', () => {
    const db = newDb();
    const v1 = upsertChange('rec-rollback', 'v1-before-rollback', '2026-07-10T13:00:00Z', 'device-rollback', 1);
    expect(applyGuarded(db, [v1], 'device-rollback').success_count).toBe(1);

    const v2 = upsertChange('rec-rollback', 'v2-after-rollback', '2026-07-10T12:00:00Z', 'device-rollback', 2);
    const result = applyGuarded(db, [v2], 'device-rollback');
    expect(result.success_count).toBe(0);
    expect(result.skipped_count).toBe(1);
    expect(itemRow(db, 'rec-rollback')).toEqual({
      content: 'v1-before-rollback',
      updated_at: '2026-07-10T13:00:00Z',
    });
    const conflicts = conflictRows(db, 'rec-rollback');
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.data_json).toContain('v2-after-rollback');
  });

  suite('r10_chaos_fast_clock_far_future_update_quarantined_not_applied', () => {
    const db = newDb();
    db.run("INSERT INTO resources (id, content, updated_at) VALUES ('rec-fast', 'must-survive', '2026-07-10T13:00:00Z')");
    const farFuture = new Date(Date.now() + 2 * 3_600_000).toISOString();
    const fast = upsertChange('rec-fast', 'from-the-future', farFuture, 'device-fast', 1);

    for (let round = 0; round < 2; round += 1) {
      const result = applyGuarded(db, [fast], 'device-fast');
      expect(result.success_count).toBe(0);
      expect(result.failure_count).toBe(1);
    }

    expect(itemRow(db, 'rec-fast')).toEqual({
      content: 'must-survive',
      updated_at: '2026-07-10T13:00:00Z',
    });
    const quarantine = db.get<{ count: number; error: string; attempts: number }>(
      `SELECT COUNT(*) AS count, error, attempts FROM __sync_quarantine
       WHERE table_name = 'resources' AND record_id = 'rec-fast'`,
    );
    expect(quarantine?.count).toBe(1);
    expect(quarantine!.error.toLowerCase()).toContain('drift');
    expect(quarantine!.attempts).toBe(2);
  });

  suite('r10_chaos_rollback_delete_loses_lww_and_tombstone_timestamp_validation', () => {
    const db = newDb();
    db.run("INSERT INTO resources (id, content, updated_at) VALUES ('rec-del', 'survives-delete', '2026-07-10T13:00:00Z')");
    const staleDelete = deleteChange('rec-del', '2026-07-10T12:30:00Z', 'device-del-rollback', 1);
    const result = applyGuarded(db, [staleDelete], 'device-del-rollback');
    expect(result.success_count).toBe(0);
    expect(result.skipped_count).toBe(1);
    expect(itemRow(db, 'rec-del')).not.toBeNull();
    const conflicts = conflictRows(db, 'rec-del');
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.data_json).toBe('null');

    const garbage = capture(() => validateTombstoneTimestamp('definitely-not-a-timestamp', 'blob'));
    expect(garbage.message).toContain('时间戳无效');

    const farFuture = new Date(Date.now() + 3 * 3_600_000).toISOString();
    const drift = capture(() => validateTombstoneTimestamp(farFuture, 'blob'));
    expect(drift).toBeInstanceOf(ClockDriftSuspectedError);

    expect(() => validateTombstoneTimestamp('2026-07-10T12:00:00Z', 'blob')).not.toThrow();
    const slightFuture = new Date(Date.now() + 30_000).toISOString();
    expect(() => validateTombstoneTimestamp(slightFuture, 'blob')).not.toThrow();
  });
});

function capture(action: () => void): Error {
  try {
    action();
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected the action to throw');
}
