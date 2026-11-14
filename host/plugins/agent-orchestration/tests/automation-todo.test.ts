import { afterEach, describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import type { DatabaseHandle, SqlExecutor } from '../../../platform/storage/api.ts';
import {
  deliverAutomationTodo, type AutomationTodoRepository,
} from '../repository/automation-todo.ts';

let cleanup: (() => Promise<void>) | null = null;

async function fixture(): Promise<{ db: DatabaseHandle; log: string[]; events: string[] }> {
  const host = await createTestHost();
  const storage = createStorageService({ baseDir: host.app.dataDir, dataLocalDir: host.app.dataDir });
  const db = storage.database('vfs');
  db.exec('CREATE TABLE todo_lists (id TEXT PRIMARY KEY, title TEXT NOT NULL)');
  db.exec(`CREATE TABLE todo_items (
    id TEXT PRIMARY KEY, todo_list_id TEXT NOT NULL, title TEXT NOT NULL,
    description TEXT, priority TEXT NOT NULL DEFAULT 'none', reminder TEXT)`);
  db.exec(`CREATE TABLE automation_todo_deliveries (
    run_id TEXT PRIMARY KEY NOT NULL, todo_item_id TEXT NOT NULL, created_at TEXT NOT NULL)`);
  cleanup = async () => { storage.dispose(); await host.dispose(); };
  return { db, log: [], events: [] };
}

function todoRepo(db: DatabaseHandle, failCreate = false): AutomationTodoRepository {
  let nextItem = 0;
  return {
    ensureDefaultInbox(_conn: SqlExecutor) {
      const existing = db.get<{ id: string }>('SELECT id FROM todo_lists LIMIT 1');
      if (existing !== undefined) return existing;
      db.run("INSERT INTO todo_lists (id, title) VALUES ('inbox', '收件箱')");
      return { id: 'inbox' };
    },
    createTodoItem(conn: SqlExecutor, params) {
      if (failCreate) throw new Error('disk full');
      const id = `ti_${++nextItem}`;
      conn.run('INSERT INTO todo_items (id, todo_list_id, title, description, priority, reminder) VALUES (?1, ?2, ?3, ?4, ?5, ?6)',
        [id, params.todoListId, params.title, params.description ?? null, params.priority ?? 'none', params.reminder ?? null]);
      return { id };
    },
  };
}

afterEach(async () => { await cleanup?.(); cleanup = null; });

describe('automations.rs notify todo delivery', () => {
  it('creates one inbox todo and records an idempotent delivery receipt', async () => {
    const { db, log, events } = await fixture();
    const deps = {
      vfs: db,
      todos: todoRepo(db),
      log: { warn: (message: string) => log.push(message) },
      emit: (event: string, payload: { source: string; action: string }) => {
        events.push(`${event}:${payload.source}:${payload.action}`);
      },
    };
    // 2026-11-04T09:05 local（reminder 使用本地分钟精度）
    const nowMs = new Date(2026, 10, 4, 9, 5, 0).getTime();

    expect(deliverAutomationTodo(deps, 'run_1', 'Daily review', 'Summarize mistakes', nowMs)).toBe(true);
    const item = db.get<{ title: string; description: string; reminder: string }>(
      'SELECT title, description, reminder FROM todo_items');
    expect(item).toEqual({ title: 'Daily review', description: 'Summarize mistakes', reminder: '2026-11-04T09:05' });
    expect(db.all('SELECT run_id, todo_item_id FROM automation_todo_deliveries')).toHaveLength(1);
    expect(events).toEqual(['todo://changed:automation:create_item']);

    expect(deliverAutomationTodo(deps, 'run_1', 'Daily review', 'Summarize mistakes', nowMs)).toBe(true);
    expect(db.all('SELECT id FROM todo_items')).toHaveLength(1);
    expect(db.all('SELECT run_id FROM automation_todo_deliveries')).toHaveLength(1);
    expect(events).toHaveLength(1);
    expect(log).toEqual([]);
  });

  it('returns false and logs when the todo repository is unavailable', async () => {
    const { db, log } = await fixture();
    expect(deliverAutomationTodo({
      vfs: db, todos: undefined, log: { warn: (message: string) => log.push(message) },
    }, 'run_2', 'Daily review', 'Summarize mistakes', Date.now())).toBe(false);
    expect(db.all('SELECT id FROM todo_items')).toHaveLength(0);
    expect(log[0]).toContain('VFS todo repository is not available');
  });

  it('returns false and logs when create_todo_item fails', async () => {
    const { db, log } = await fixture();
    expect(deliverAutomationTodo({
      vfs: db, todos: todoRepo(db, true), log: { warn: (message: string) => log.push(message) },
    }, 'run_3', 'Daily review', 'Summarize mistakes', Date.now())).toBe(false);
    expect(db.all('SELECT run_id FROM automation_todo_deliveries')).toHaveLength(0);
    expect(log.some((entry) => entry.includes('create_todo_item failed: disk full'))).toBe(true);
  });
});
