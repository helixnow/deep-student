/**
 * S04/TD-02：`todo_items.completed_pomodoros` 派生计数重算（表所有者入口）。
 *
 * Rust 对照：`src-tauri/crates/dstu-sync/src/data_governance/sync/pomodoro_counts.rs:72-145`
 * 及其单元测试 `td02_recompute_scope_idempotency_and_echo_suppression`。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { createTestHost } from '../../../kernel/testing.ts';
import { notesServiceDouble } from './support/notes-service.ts';
import { pathsServiceDouble } from './support/paths-service.ts';
import { createVfsTestStorage } from './support/vfs-test-storage.ts';
import type { createStorageService } from '../../../platform/storage/service.ts';
import type { DatabaseHandle, SqlExecutor } from '../../../platform/storage/api.ts';
import type { TodoItem } from '../api.ts';
import plugin from '../index.ts';

const HIGH_LOG_ID = '9007199254740993'; // 2^53 + 1：Number 会丢精度

let root: string;
let storage: ReturnType<typeof createStorageService>;
let host: Awaited<ReturnType<typeof createTestHost>>;
let db: DatabaseHandle;

beforeEach(async () => {
  ({ root, storage } = await createVfsTestStorage('l11-sync-pomodoro-'));
  host = await createTestHost({
    plugins: [plugin],
    provide: {
      storage,
      paths: pathsServiceDouble(),
      notes: notesServiceDouble(() => storage.database('vfs')),
    },
  });
  db = storage.database('vfs');
}, 120_000);

afterEach(async () => {
  await host?.dispose();
  storage?.dispose();
  if (root) rmSync(root, { recursive: true, force: true });
}, 120_000);

const pomodoros = () => host.ctx.vfsRepo.pomodoros;
const todos = () => host.ctx.vfsRepo.todos;

function createItem(title: string): TodoItem {
  const list = todos().createTodoList(db, { title: `sync list ${title}` });
  return todos().createTodoItem(db, { todoListId: list.id, title });
}

function insertFact(id: string, todoItemId: string | null, type: string, status: string,
  deletedAt: string | null = null): void {
  db.run(`INSERT INTO pomodoro_records
      (id, todo_item_id, start_time, end_time, duration, actual_duration,
       type, status, created_at, updated_at, deleted_at)
    VALUES (?1, ?2, '2026-07-01T01:00:00Z', '2026-07-01T01:25:00Z', 1500, 1500,
            ?3, ?4, '2026-07-01T01:00:00Z', '2026-07-01T01:00:00Z', ?5)`,
  [id, todoItemId, type, status, deletedAt]);
}

function countOf(todoItemId: string): number {
  return Number(db.pluck<number>(
    'SELECT completed_pomodoros FROM todo_items WHERE id = ?1', [todoItemId]) ?? -999);
}

function logMax(): string {
  return String(db.pluck<string>(
    'SELECT CAST(COALESCE(MAX(id), 0) AS TEXT) FROM __change_log') ?? '0');
}

function executorFailingShapeProbe(): SqlExecutor {
  return new Proxy(db as object, {
    get(target, property, receiver) {
      if (property === 'all') return () => { throw new Error('schema probe failure'); };
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as unknown as SqlExecutor;
}

function executorFailingUpdate(sqlFragment: string): SqlExecutor {
  return new Proxy(db as object, {
    get(target, property, receiver) {
      if (property === 'run') {
        const run = Reflect.get(target, 'run', receiver) as (...args: unknown[]) => unknown;
        return (sql: string, params?: unknown) => {
          if (sql.includes(sqlFragment)) throw new Error('update failure');
          return run.call(target, sql, params);
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as unknown as SqlExecutor;
}

describe('pomodoro_counts.rs S04 owner entry', { timeout: 120_000 }, () => {
  it('recompute_scope_normalizes_null_and_drift_without_touching_business_columns', () => {
    const counted = createItem('counted');
    const drift = createItem('drift');
    const empty = createItem('empty');
    const deletedTodo = createItem('deleted todo');

    insertFact('r-work', counted.id, 'work', 'completed');
    insertFact('r-interrupted', counted.id, 'work', 'interrupted');
    insertFact('r-break', counted.id, 'short_break', 'completed');
    insertFact('r-soft-deleted', counted.id, 'work', 'completed', '2026-07-02T00:00:00Z');
    insertFact('r-orphan', null, 'work', 'completed');
    insertFact('r-deleted-todo', deletedTodo.id, 'work', 'completed');

    db.run('UPDATE todo_items SET completed_pomodoros = 99 WHERE id = ?1', [drift.id]);
    db.run('UPDATE todo_items SET completed_pomodoros = NULL WHERE id = ?1', [empty.id]);
    db.run("UPDATE todo_items SET deleted_at = '2026-07-03T00:00:00Z' WHERE id = ?1", [deletedTodo.id]);

    const before = db.get<{ updated_at: string | null; local_version: number }>(
      'SELECT updated_at, COALESCE(local_version, 0) AS local_version FROM todo_items WHERE id = ?1',
      [counted.id])!;

    pomodoros().recomputeCompletedPomodorosForSyncBatch(db, ['pomodoro_records']);

    expect(countOf(counted.id)).toBe(1);
    expect(countOf(drift.id)).toBe(0);
    expect(countOf(empty.id)).toBe(0);
    expect(countOf(deletedTodo.id)).toBe(1); // 软删 todo 的缓存同样对齐事实表
    const after = db.get<{ updated_at: string | null; local_version: number }>(
      'SELECT updated_at, COALESCE(local_version, 0) AS local_version FROM todo_items WHERE id = ?1',
      [counted.id])!;
    expect(after.updated_at).toBe(before.updated_at);
    expect(after.local_version).toBe(before.local_version);
  });

  it('only_relevant_batches_recompute', () => {
    const item = createItem('irrelevant');
    db.run('UPDATE todo_items SET completed_pomodoros = 7 WHERE id = ?1', [item.id]);
    const beforeLog = logMax();

    pomodoros().recomputeCompletedPomodorosForSyncBatch(db, ['notes', 'resources']);
    expect(countOf(item.id)).toBe(7);
    expect(logMax()).toBe(beforeLog);

    pomodoros().recomputeCompletedPomodorosForSyncBatch(db, ['todo_items']);
    expect(countOf(item.id)).toBe(0);
  });

  it('echo_suppression_preserves_i64_pre_log_max_and_is_idempotent', () => {
    const first = createItem('echo first');
    const second = createItem('echo second');
    insertFact('r-first', first.id, 'work', 'completed');
    insertFact('r-second', second.id, 'work', 'completed');
    db.run('UPDATE todo_items SET completed_pomodoros = NULL WHERE id IN (?1, ?2)', [first.id, second.id]);

    // 既有未同步日志：id = 2^53 + 1，必须原样保留（若 pre_log_max 用 Number 会误标）。
    db.run(`INSERT INTO __change_log (id, table_name, record_id, operation, sync_version)
      VALUES (?1, 'todo_items', 'pre-existing', 'UPDATE', 0)`, [9007199254740993n]);

    pomodoros().recomputeCompletedPomodorosForSyncBatch(db, ['pomodoro_records']);

    expect(countOf(first.id)).toBe(1);
    expect(countOf(second.id)).toBe(1);
    expect(db.pluck<number>(
      `SELECT sync_version FROM __change_log WHERE id = ${HIGH_LOG_ID}`)).toBe(0);

    const echoes = db.all<{ table_name: string; sync_version: number }>(
      `SELECT table_name, sync_version FROM __change_log WHERE id > ${HIGH_LOG_ID}`);
    const todoEchoes = echoes.filter(row => row.table_name === 'todo_items');
    expect(todoEchoes.length).toBeGreaterThan(0);
    expect(todoEchoes.every(row => row.sync_version !== 0)).toBe(true);
    expect(echoes.filter(row => row.table_name !== 'todo_items').every(row => row.sync_version === 0))
      .toBe(true);

    // 第二次重算是纯 no-op：计数不变且不再产生任何日志（churn guard）。
    const afterFirst = logMax();
    pomodoros().recomputeCompletedPomodorosForSyncBatch(db, ['pomodoro_records']);
    expect(countOf(first.id)).toBe(1);
    expect(logMax()).toBe(afterFirst);
  });

  it('skips_databases_without_todo_pomodoro_tables', () => {
    const other = storage.openFile(':memory:', { label: 'no-todo-tables', profile: 'plain' });
    try {
      other.exec('CREATE TABLE chat_v2_sessions (id TEXT PRIMARY KEY)');
      expect(() => pomodoros().recomputeCompletedPomodorosForSyncBatch(other, ['pomodoro_records']))
        .not.toThrow();
    } finally {
      storage.close(other);
    }
  });

  it('shape_probe_query_failure_is_treated_as_missing_column', () => {
    const item = createItem('shape probe failure');
    db.run('UPDATE todo_items SET completed_pomodoros = 7 WHERE id = ?1', [item.id]);

    expect(() => pomodoros().recomputeCompletedPomodorosForSyncBatch(
      executorFailingShapeProbe(), ['pomodoro_records'])).not.toThrow();
    expect(countOf(item.id)).toBe(7);
  });

  it('recompute_and_zero_update_failures_still_propagate', () => {
    const item = createItem('update failure');
    insertFact('r-update-failure', item.id, 'work', 'completed');

    for (const [sqlFragment, action] of [
      ['SET completed_pomodoros = rc.cnt', '重算 todo_items.completed_pomodoros'],
      ['SET completed_pomodoros = 0', '清零 todo_items.completed_pomodoros'],
    ] as const) {
      let thrown: unknown;
      try {
        pomodoros().recomputeCompletedPomodorosForSyncBatch(
          executorFailingUpdate(sqlFragment), ['pomodoro_records']);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toMatchObject({ code: 'VFS_STORAGE' });
      expect((thrown as Error).message).toContain(`${action} 失败: update failure`);
    }
  });
});
