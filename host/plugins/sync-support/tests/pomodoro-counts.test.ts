import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PomodoroCountsSupport, SyncChangeWithData } from '../api.ts';
import { serviceHost } from './service-host.ts';
import { SqliteDatabase } from '../../../platform/storage/database.ts';

type TestDatabase = SqliteDatabase;
function openTestDatabase(): SqliteDatabase {
  return new SqliteDatabase({ name: 'pomodoro-device', path: ':memory:', profile: {} });
}

let host: Awaited<ReturnType<typeof serviceHost>>;
let counts: PomodoroCountsSupport;
const databases: TestDatabase[] = [];
beforeEach(async () => { host = await serviceHost(undefined, true); counts = host.service.pomodoroCounts; });
afterEach(async () => {
  for (const db of databases.splice(0)) db.close();
  await host.dispose();
});
const recompute = (db: TestDatabase) => counts.recompute(db);

const SCHEMA = `
  CREATE TABLE __change_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      table_name TEXT NOT NULL,
      record_id TEXT NOT NULL,
      operation TEXT NOT NULL CHECK(operation IN ('INSERT', 'UPDATE', 'DELETE')),
      changed_at TEXT NOT NULL DEFAULT (datetime('now')),
      sync_version INTEGER DEFAULT 0
  );
  CREATE TABLE todo_items (
      id TEXT PRIMARY KEY,
      title TEXT,
      completed_pomodoros INTEGER DEFAULT 0,
      updated_at TEXT,
      deleted_at TEXT,
      local_version INTEGER DEFAULT 0
  );
  CREATE TABLE pomodoro_records (
      id TEXT PRIMARY KEY,
      todo_item_id TEXT,
      start_time TEXT,
      end_time TEXT,
      duration INTEGER NOT NULL DEFAULT 0,
      actual_duration INTEGER NOT NULL DEFAULT 0,
      type TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT,
      updated_at TEXT,
      deleted_at TEXT,
      local_version INTEGER DEFAULT 0
  );
`;

function createDeviceDb(): TestDatabase {
  const db = openTestDatabase();
  databases.push(db);
  db.exec(SCHEMA);
  return db;
}

function seedTodo(db: TestDatabase, todoId: string, updatedAt: string): void {
  db.run(
    "INSERT INTO todo_items (id, title, completed_pomodoros, updated_at) VALUES (?1, 'focus task', 0, ?2)",
    [todoId, updatedAt],
  );
}

function createLocalWorkRecord(db: TestDatabase, recordId: string, todoId: string, ts: string): void {
  db.run(
    `INSERT INTO pomodoro_records
       (id, todo_item_id, start_time, end_time, duration, actual_duration,
        type, status, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?3, 1500, 1500, 'work', 'completed', ?3, ?3)`,
    [recordId, todoId, ts],
  );
  recompute(db);
}

function completedPomodoros(db: TestDatabase, todoId: string): number {
  return Number(db.pluck<number | bigint>(
    'SELECT COALESCE(completed_pomodoros, -999) FROM todo_items WHERE id = ?1',
    [todoId],
  ));
}

function workRecordChange(
  recordId: string,
  todoId: string,
  createdAt: string,
  updatedAt: string,
  deletedAt: string | null = null,
): SyncChangeWithData {
  return {
    table_name: 'pomodoro_records',
    record_id: recordId,
    operation: 'Update',
    data: {
      id: recordId,
      todo_item_id: todoId,
      start_time: createdAt,
      end_time: createdAt,
      duration: 1500,
      actual_duration: 1500,
      type: 'work',
      status: 'completed',
      created_at: createdAt,
      updated_at: updatedAt,
      deleted_at: deletedAt,
    },
    changed_at: updatedAt,
    change_log_id: null,
    database_name: 'vfs',
    suppress_change_log: true,
    source_device_id: 'device-remote',
    source_seq: 1,
  };
}

function todoChange(todoId: string, cachedCount: number, updatedAt: string): SyncChangeWithData {
  return {
    table_name: 'todo_items',
    record_id: todoId,
    operation: 'Update',
    data: {
      id: todoId,
      title: 'focus task',
      completed_pomodoros: cachedCount,
      updated_at: updatedAt,
      deleted_at: null,
    },
    changed_at: updatedAt,
    change_log_id: null,
    database_name: 'vfs',
    suppress_change_log: true,
    source_device_id: 'device-remote',
    source_seq: 2,
  };
}

describe('pomodoro counts (pomodoro_counts.rs)', () => {
  it('td02_two_devices_2_plus_3_converge_to_5', () => {
    const deviceA = createDeviceDb();
    const deviceB = createDeviceDb();
    for (const db of [deviceA, deviceB]) seedTodo(db, 'todo-1', '2026-07-01T00:00:00Z');

    createLocalWorkRecord(deviceA, 'rec-a1', 'todo-1', '2026-07-01T01:00:00Z');
    createLocalWorkRecord(deviceA, 'rec-a2', 'todo-1', '2026-07-01T02:00:00Z');
    createLocalWorkRecord(deviceB, 'rec-b1', 'todo-1', '2026-07-01T01:10:00Z');
    createLocalWorkRecord(deviceB, 'rec-b2', 'todo-1', '2026-07-01T01:40:00Z');
    createLocalWorkRecord(deviceB, 'rec-b3', 'todo-1', '2026-07-01T02:20:00Z');
    expect(completedPomodoros(deviceA, 'todo-1')).toBe(2);
    expect(completedPomodoros(deviceB, 'todo-1')).toBe(3);

    host.sync!.applyDownloadedChanges(deviceA, [
      workRecordChange('rec-b1', 'todo-1', '2026-07-01T01:10:00Z', '2026-07-01T01:10:00Z'),
      workRecordChange('rec-b2', 'todo-1', '2026-07-01T01:40:00Z', '2026-07-01T01:40:00Z'),
      workRecordChange('rec-b3', 'todo-1', '2026-07-01T02:20:00Z', '2026-07-01T02:20:00Z'),
      todoChange('todo-1', 3, '2026-07-01T03:00:00Z'),
    ], { deviceId: 'device-a' });
    expect(completedPomodoros(deviceA, 'todo-1')).toBe(5);

    host.sync!.applyDownloadedChanges(deviceB, [
      workRecordChange('rec-a1', 'todo-1', '2026-07-01T01:00:00Z', '2026-07-01T01:00:00Z'),
      workRecordChange('rec-a2', 'todo-1', '2026-07-01T02:00:00Z', '2026-07-01T02:00:00Z'),
      todoChange('todo-1', 2, '2026-07-01T02:30:00Z'),
    ], { deviceId: 'device-b' });
    expect(completedPomodoros(deviceB, 'todo-1')).toBe(5);
  });

  it('td02_remote_tombstone_delete_does_not_resurrect_count', () => {
    const deviceA = createDeviceDb();
    seedTodo(deviceA, 'todo-1', '2026-07-01T00:00:00Z');
    createLocalWorkRecord(deviceA, 'rec-1', 'todo-1', '2026-07-01T01:00:00Z');
    createLocalWorkRecord(deviceA, 'rec-2', 'todo-1', '2026-07-01T02:00:00Z');
    expect(completedPomodoros(deviceA, 'todo-1')).toBe(2);

    deviceA.run(
      `INSERT INTO __change_log (table_name, record_id, operation, sync_version)
       VALUES ('todo_items', 'todo-1', 'UPDATE', 0)`,
    );

    const changes = [
      workRecordChange('rec-2', 'todo-1', '2026-07-01T02:00:00Z', '2026-07-02T00:00:00Z', '2026-07-02T00:00:00Z'),
      todoChange('todo-1', 1, '2026-07-02T00:00:00Z'),
    ];
    host.sync!.applyDownloadedChanges(deviceA, changes, { deviceId: 'device-a' });

    const deletedAt = deviceA.pluck<string | null>(
      "SELECT deleted_at FROM pomodoro_records WHERE id = 'rec-2'",
    );
    expect(deletedAt).not.toBeNull();
    expect(completedPomodoros(deviceA, 'todo-1')).toBe(1);

    host.sync!.applyDownloadedChanges(deviceA, changes, { deviceId: 'device-a' });
    expect(completedPomodoros(deviceA, 'todo-1')).toBe(1);
  });

  it('td02_repeated_apply_is_idempotent', () => {
    const deviceA = createDeviceDb();
    seedTodo(deviceA, 'todo-1', '2026-07-01T00:00:00Z');
    createLocalWorkRecord(deviceA, 'rec-a1', 'todo-1', '2026-07-01T01:00:00Z');
    createLocalWorkRecord(deviceA, 'rec-a2', 'todo-1', '2026-07-01T02:00:00Z');

    const batch = [
      workRecordChange('rec-b1', 'todo-1', '2026-07-01T01:10:00Z', '2026-07-01T01:10:00Z'),
      workRecordChange('rec-b2', 'todo-1', '2026-07-01T01:40:00Z', '2026-07-01T01:40:00Z'),
      workRecordChange('rec-b3', 'todo-1', '2026-07-01T02:20:00Z', '2026-07-01T02:20:00Z'),
      todoChange('todo-1', 3, '2026-07-01T03:00:00Z'),
    ];
    host.sync!.applyDownloadedChanges(deviceA, batch, { deviceId: 'device-a' });
    expect(completedPomodoros(deviceA, 'todo-1')).toBe(5);

    host.sync!.applyDownloadedChanges(deviceA, batch, { deviceId: 'device-a' });
    expect(completedPomodoros(deviceA, 'todo-1')).toBe(5);
    expect(Number(deviceA.pluck<number>('SELECT COUNT(*) FROM pomodoro_records'))).toBe(5);
  });

  it('td02_record_moved_to_another_todo_rebalances_and_zeroes_empty_todo', () => {
    const deviceA = createDeviceDb();
    seedTodo(deviceA, 'todo-1', '2026-07-01T00:00:00Z');
    seedTodo(deviceA, 'todo-2', '2026-07-01T00:00:00Z');
    createLocalWorkRecord(deviceA, 'rec-1', 'todo-1', '2026-07-01T01:00:00Z');
    expect(completedPomodoros(deviceA, 'todo-1')).toBe(1);
    expect(completedPomodoros(deviceA, 'todo-2')).toBe(0);

    host.sync!.applyDownloadedChanges(deviceA, [
      workRecordChange('rec-1', 'todo-2', '2026-07-01T01:00:00Z', '2026-07-02T00:00:00Z'),
    ], { deviceId: 'device-a' });
    expect(completedPomodoros(deviceA, 'todo-1')).toBe(0);
    expect(completedPomodoros(deviceA, 'todo-2')).toBe(1);
  });

  it('td02_remote_delete_operation_zeroes_count', () => {
    const deviceA = createDeviceDb();
    seedTodo(deviceA, 'todo-1', '2026-07-01T00:00:00Z');
    createLocalWorkRecord(deviceA, 'rec-1', 'todo-1', '2026-07-01T01:00:00Z');
    expect(completedPomodoros(deviceA, 'todo-1')).toBe(1);

    host.sync!.applyDownloadedChanges(deviceA, [{
      table_name: 'pomodoro_records', record_id: 'rec-1', operation: 'Delete', data: null,
      changed_at: '2026-07-02T00:00:00Z', change_log_id: null, database_name: 'vfs',
      suppress_change_log: true, source_device_id: 'device-remote', source_seq: 9,
    }], { deviceId: 'device-a' });

    expect(deviceA.pluck<string | null>(
      "SELECT deleted_at FROM pomodoro_records WHERE id = 'rec-1'",
    )).not.toBeNull();
    expect(completedPomodoros(deviceA, 'todo-1')).toBe(0);
  });

  it('td02_partial_apply_with_quarantined_change_reflects_committed_rows_only', () => {
    const deviceA = createDeviceDb();
    seedTodo(deviceA, 'todo-1', '2026-07-01T00:00:00Z');

    const broken = workRecordChange('rec-bad', 'todo-1', '2026-07-01T01:00:00Z', '2026-07-01T01:00:00Z');
    broken.data = 'not-an-object';
    const result = host.sync!.applyDownloadedChanges(deviceA, [
      broken, workRecordChange('rec-good', 'todo-1', '2026-07-01T02:00:00Z', '2026-07-01T02:00:00Z'),
    ], { deviceId: 'device-a' });
    expect(result.success_count).toBe(1);
    expect(result.failure_count).toBe(1);

    expect(completedPomodoros(deviceA, 'todo-1')).toBe(1);
  });

  it('td02_recompute_scope_idempotency_and_echo_suppression', () => {
    const db = createDeviceDb();
    seedTodo(db, 'todo-1', '2026-07-01T00:00:00Z');
    seedTodo(db, 'todo-drift', '2026-07-01T00:00:00Z');
    db.run("UPDATE todo_items SET completed_pomodoros = NULL WHERE id = 'todo-1'");
    db.run("UPDATE todo_items SET completed_pomodoros = 99 WHERE id = 'todo-drift'");

    const insertRecord = (
      id: string, todo: string | null, type: string, status: string, deletedAt: string | null,
    ): void => {
      db.run(
        `INSERT INTO pomodoro_records
           (id, todo_item_id, start_time, duration, actual_duration, type, status,
            created_at, updated_at, deleted_at)
         VALUES (?1, ?2, '2026-07-01T01:00:00Z', 1500, 1500, ?3, ?4,
                 '2026-07-01T01:00:00Z', '2026-07-01T01:00:00Z', ?5)`,
        [id, todo, type, status, deletedAt],
      );
    };
    insertRecord('r-count', 'todo-1', 'work', 'completed', null);
    insertRecord('r-interrupted', 'todo-1', 'work', 'interrupted', null);
    insertRecord('r-break', 'todo-1', 'short_break', 'completed', null);
    insertRecord('r-deleted', 'todo-1', 'work', 'completed', '2026-07-01T02:00:00Z');
    insertRecord('r-orphan', null, 'work', 'completed', null);

    db.exec(`
      CREATE TRIGGER trg_todo_items_upd AFTER UPDATE ON todo_items
      BEGIN
          INSERT INTO __change_log (table_name, record_id, operation)
          VALUES ('todo_items', NEW.id, 'UPDATE');
      END;
    `);

    recompute(db);
    expect(completedPomodoros(db, 'todo-1')).toBe(1);
    expect(completedPomodoros(db, 'todo-drift')).toBe(0);

    const total = Number(db.pluck<number>(
      "SELECT COUNT(*) FROM __change_log WHERE table_name = 'todo_items'",
    ));
    const pending = Number(db.pluck<number>(
      `SELECT COALESCE(SUM(CASE WHEN sync_version = 0 THEN 1 ELSE 0 END), 0)
       FROM __change_log WHERE table_name = 'todo_items'`,
    ));
    expect(total).toBeGreaterThanOrEqual(2);
    expect(pending).toBe(0);

    const before = Number(db.pluck<number>('SELECT COUNT(*) FROM __change_log'));
    recompute(db);
    const after = Number(db.pluck<number>('SELECT COUNT(*) FROM __change_log'));
    expect(completedPomodoros(db, 'todo-1')).toBe(1);
    expect(after).toBe(before);
  });

  it('td02_recompute_skips_databases_without_todo_tables', () => {
    const db = openTestDatabase();
    databases.push(db);
    db.exec('CREATE TABLE chat_v2_sessions (id TEXT PRIMARY KEY);');
    expect(() => recompute(db)).not.toThrow();
  });

  it('changes_affect_todo_pomodoro_counts_only_matches_fact_or_cache_tables', () => {
    expect(counts.changesAffectTodoPomodoroCounts([
      workRecordChange('r', 't', 'x', 'x'),
    ])).toBe(true);
    expect(counts.changesAffectTodoPomodoroCounts([todoChange('t', 1, 'x')])).toBe(true);
    expect(counts.changesAffectTodoPomodoroCounts([{
      ...todoChange('t', 1, 'x'), table_name: 'notes',
    }])).toBe(false);
  });
});
