import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import { createSettingsStore } from '../../../platform/settings/index.ts';
import { defineQuery, type DatabaseHandle, type Row } from '../../../platform/storage/api.ts';
import {
  getTodoList, persistTodoListWithConn, type AgentTodoService, type TodoList, type TodoStatus,
} from '../api.ts';
import plugin from '../index.ts';

describe('L03 tool-round public TodoList persistence (todo_executor.rs:213–261)', () => {
  let host: Awaited<ReturnType<typeof createTestHost>>;
  let storage: ReturnType<typeof createStorageService>;
  let db: DatabaseHandle;
  let service: AgentTodoService;

  beforeAll(async () => {
    host = await createTestHost();
    storage = createStorageService({ baseDir: host.app.dataDir, dataLocalDir: host.app.dataDir });
    const report = await storage.migrations.runAll();
    if (!report.success) throw new Error(`schema migration failed: ${JSON.stringify(report)}`);
    db = storage.database('chat_v2');
    host.ctx.provide('storage', storage);
    host.ctx.provide('settings', createSettingsStore({ db: () => storage.database('mistakes'),
      secureStore: () => null, isSensitiveKey: () => false }));
    await host.install(plugin);
    service = host.ctx.agentTodo;
  }, 120_000);

  afterAll(async () => { await host?.dispose(); storage?.dispose(); });

  function chat() {
    const sessionId = `sess_${randomUUID()}`;
    const messageId = `msg_${randomUUID()}`;
    db.run(`INSERT INTO chat_v2_sessions (id, mode, created_at, updated_at)
      VALUES (?1, 'general_chat', '2026-01-01', '2026-01-01')`, [sessionId]);
    db.run(`INSERT INTO chat_v2_messages (id, session_id, role, timestamp)
      VALUES (?1, ?2, 'assistant', 10)`, [messageId, sessionId]);
    return { sessionId, messageId };
  }

  function addMessage(sessionId: string): string {
    const messageId = `msg_${randomUUID()}`;
    db.run(`INSERT INTO chat_v2_messages (id, session_id, role, timestamp)
      VALUES (?1, ?2, 'assistant', 11)`, [messageId, sessionId]);
    return messageId;
  }

  function list(status: TodoStatus = 'pending', title = 'Plan "A"\n'): TodoList {
    return {
      id: 'todo_1a2b3c4d', title, createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_123,
      steps: [
        { id: 'step_1', description: 'Review\t"x"/é\u0001', status, result: null, createdAt: 10, updatedAt: null },
        { id: 'step_2', description: 'Ship', status: 'completed', result: 'ok', createdAt: 11, updatedAt: 12 },
      ],
    };
  }

  const rowQuery = defineQuery<readonly [string]>(`SELECT session_id, message_id, variant_id, todo_list_id, title, steps_json, is_all_done,
        created_at, updated_at, typeof(created_at) AS created_type, typeof(updated_at) AS updated_type,
        typeof(is_all_done) AS done_type
      FROM chat_v2_todo_lists WHERE session_id = ?1`, { options: { safeIntegers: true } });
  function row(sessionId: string): Row | undefined {
    return db.get(rowQuery, [sessionId]);
  }

  it('writes the nine Rust columns with serde steps shape and exact integers, logs debug, leaves memory unchanged', () => {
    const { sessionId, messageId } = chat();
    const debug = vi.spyOn(host.ctx.logger, 'debug');
    const value = list();
    service.persistTodoList(sessionId, messageId, null, value);
    expect(row(sessionId)).toStrictEqual({
      session_id: sessionId, message_id: messageId, variant_id: null, todo_list_id: 'todo_1a2b3c4d',
      title: 'Plan "A"\n',
      steps_json: '[{"id":"step_1","description":"Review\\t\\"x\\"/é\\u0001","status":"pending","createdAt":10},'
        + '{"id":"step_2","description":"Ship","status":"completed","result":"ok","createdAt":11,"updatedAt":12}]',
      is_all_done: 0n, created_at: 1_700_000_000_000n, updated_at: 1_700_000_000_123n,
      created_type: 'integer', updated_type: 'integer', done_type: 'integer',
    });
    expect(debug.mock.calls.map(([line]) => String(line))).toContain(
      `[TodoListExecutor] Persisted TodoList todo_1a2b3c4d for session ${sessionId} (message: ${messageId})`);
    debug.mockRestore();
    expect(getTodoList(sessionId)).toBeNull();
    expect(service.loadPersistedTodoList(sessionId)).toStrictEqual({ list: value, messageId, variantId: null });
  });

  it('INSERT OR REPLACE keeps one row per session; variant and is_all_done follow the latest list', () => {
    const { sessionId, messageId } = chat();
    service.persistTodoList(sessionId, messageId, null, list());
    const second = addMessage(sessionId);
    service.persistTodoList(sessionId, second, 'variant_b', list('skipped', 'Done'));
    expect(db.pluck('SELECT COUNT(*) FROM chat_v2_todo_lists WHERE session_id = ?1', [sessionId])).toBe(1);
    expect(row(sessionId)).toMatchObject({ message_id: second, variant_id: 'variant_b', title: 'Done', is_all_done: 1n });
    // Only unfinished rows are readable through the original load interface.
    expect(service.loadPersistedTodoList(sessionId)).toBeNull();
    service.persistTodoList(sessionId, second, 'variant_b', list('running'));
    expect(service.loadPersistedTodoList(sessionId)).toMatchObject({ messageId: second, variantId: 'variant_b' });
    // Rust Iterator::all on no steps is true.
    service.persistTodoList(sessionId, second, null, { ...list(), steps: [] });
    expect(row(sessionId)).toMatchObject({ steps_json: '[]', is_all_done: 1n, variant_id: null });
  });

  it('keeps i64 timestamps exact beyond 2^53 in columns and steps JSON, and reads them back', () => {
    const { sessionId, messageId } = chat();
    const value: TodoList = {
      id: 'todo_big', title: 't', createdAt: 9223372036854775807n, updatedAt: -9223372036854775808n,
      steps: [{ id: 's', description: 'x', status: 'failed', result: null,
        createdAt: Number.MAX_SAFE_INTEGER, updatedAt: -9223372036854775808n }],
    };
    service.persistTodoList(sessionId, messageId, null, value);
    expect(row(sessionId)).toMatchObject({
      created_at: 9223372036854775807n, updated_at: -9223372036854775808n,
      created_type: 'integer', updated_type: 'integer', is_all_done: 1n,
      steps_json: '[{"id":"s","description":"x","status":"failed","createdAt":9007199254740991,'
        + '"updatedAt":-9223372036854775808}]',
    });
    db.run('UPDATE chat_v2_todo_lists SET is_all_done = 0 WHERE session_id = ?1', [sessionId]);
    expect(service.loadPersistedTodoList(sessionId)?.list).toStrictEqual(value);
  });

  it('WithConn uses the caller transaction only: no new connection, nothing lands after rollback', () => {
    const { sessionId, messageId } = chat();
    service.persistTodoList(sessionId, messageId, null, list());
    const open = vi.spyOn(storage, 'database');
    const abort = new Error('caller rollback');
    expect(() => db.transaction((tx) => {
      persistTodoListWithConn(tx, sessionId, messageId, 'variant_tx', list('running', 'uncommitted'));
      expect(tx.get('SELECT title, variant_id FROM chat_v2_todo_lists WHERE session_id = ?1', [sessionId]))
        .toStrictEqual({ title: 'uncommitted', variant_id: 'variant_tx' });
      throw abort;
    })).toThrow(abort);
    expect(open).not.toHaveBeenCalled();
    open.mockRestore();
    expect(row(sessionId)).toMatchObject({ title: 'Plan "A"\n', variant_id: null });
    expect(getTodoList(sessionId)).toBeNull();
    db.transaction((tx) => persistTodoListWithConn(tx, sessionId, messageId, null, list('running', 'committed')));
    expect(service.loadPersistedTodoList(sessionId)?.list.title).toBe('committed');
  });

  it('does not change the shared executor store when persisting a different list', () => {
    const { sessionId, messageId } = chat();
    service.persistTodoList(sessionId, messageId, null, list('pending', 'in memory'));
    expect(service.restoreTodoListFromDb(sessionId)?.title).toBe('in memory');
    service.persistTodoList(sessionId, messageId, null, list('running', 'persisted later'));
    expect(getTodoList(sessionId)?.title).toBe('in memory');
    expect(service.loadPersistedTodoList(sessionId)?.list.title).toBe('persisted later');
  });

  it('serialize failures keep the Failed to serialize steps prefix and write nothing', () => {
    const { sessionId, messageId } = chat();
    service.persistTodoList(sessionId, messageId, null, list());
    const debug = vi.spyOn(host.ctx.logger, 'debug');
    const bogus = { ...list(), steps: [{ ...list().steps[0]!, status: 'bogus' as TodoStatus }] };
    expect(() => service.persistTodoList(sessionId, messageId, null, bogus))
      .toThrow('Failed to serialize steps: unknown variant `bogus`');
    const fraction = { ...list(), steps: [{ ...list().steps[0]!, createdAt: 1.5 }] };
    expect(() => service.persistTodoList(sessionId, messageId, null, fraction))
      .toThrow('Failed to serialize steps: invalid value: `1.5`, expected i64');
    const overflow = { ...list(), steps: [{ ...list().steps[0]!, updatedAt: 9223372036854775808n }] };
    expect(() => service.persistTodoList(sessionId, messageId, null, overflow))
      .toThrow('Failed to serialize steps: invalid value: `9223372036854775808`, expected i64');
    const column = { ...list('running', 'bad column'), createdAt: 9223372036854775808n };
    expect(() => service.persistTodoList(sessionId, messageId, null, column))
      .toThrow('Failed to persist TodoList: invalid value: `9223372036854775808`, expected i64');
    expect(debug).not.toHaveBeenCalled();
    debug.mockRestore();
    expect(row(sessionId)).toMatchObject({ title: 'Plan "A"\n', is_all_done: 0n });
  });

  it('real SQL failures keep the Failed to persist TodoList prefix and no debug log', () => {
    const { sessionId } = chat();
    const debug = vi.spyOn(host.ctx.logger, 'debug');
    expect(() => service.persistTodoList(sessionId, 'msg_absent', null, list()))
      .toThrow('Failed to persist TodoList: FOREIGN KEY constraint failed');
    expect(row(sessionId)).toBeUndefined();
    const empty = storage.openFile(`${host.app.dataDir}/no-todo-persist-table.db`);
    try {
      expect(() => persistTodoListWithConn(empty, sessionId, 'm', null, list(), host.ctx.logger))
        .toThrow('Failed to persist TodoList: no such table: chat_v2_todo_lists');
    } finally { storage.close(empty); }
    expect(debug).not.toHaveBeenCalled();
    debug.mockRestore();
  });
});
