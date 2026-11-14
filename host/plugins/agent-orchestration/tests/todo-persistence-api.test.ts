import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import { createSettingsStore } from '../../../platform/settings/index.ts';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import {
  getTodoList, loadPersistedTodoListWithConn, restoreTodoListFromDbWithConn,
  type AgentTodoService, type TodoList,
} from '../api.ts';
import plugin from '../index.ts';

describe('L04 continue_message public todo persistence and shared store (todo_executor.rs:265–349)', () => {
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

  function persisted(stepsJson = '[{"id":"step_1","description":"Review","status":"pending","createdAt":10}]') {
    const sessionId = `sess_${randomUUID()}`;
    const messageId = `msg_${randomUUID()}`;
    db.run(`INSERT INTO chat_v2_sessions (id, mode, created_at, updated_at)
      VALUES (?1, 'general_chat', '2026-01-01', '2026-01-01')`, [sessionId]);
    db.run(`INSERT INTO chat_v2_messages (id, session_id, role, timestamp)
      VALUES (?1, ?2, 'assistant', 10)`, [messageId, sessionId]);
    db.run(`INSERT INTO chat_v2_todo_lists
      (session_id, message_id, variant_id, todo_list_id, title, steps_json, is_all_done, created_at, updated_at)
      VALUES (?1, ?2, NULL, 'todo_resume', 'Resume task', ?3, 0, 10, 20)`, [sessionId, messageId, stepsJson]);
    const list: TodoList = {
      id: 'todo_resume', title: 'Resume task', steps: [{ id: 'step_1', description: 'Review',
        status: 'pending', result: null, createdAt: 10, updatedAt: null }], createdAt: 10, updatedAt: 20,
    };
    return { sessionId, messageId, list };
  }

  it('loads only unfinished rows and preserves message/variant IDs, without touching executor memory', () => {
    const { sessionId, messageId, list } = persisted();
    expect(service.loadPersistedTodoList(sessionId)).toStrictEqual({ list, messageId, variantId: null });
    expect(getTodoList(sessionId)).toBeNull();
    db.run('UPDATE chat_v2_todo_lists SET variant_id = ?1 WHERE session_id = ?2', ['variant_original', sessionId]);
    expect(loadPersistedTodoListWithConn(db, sessionId)?.variantId).toBe('variant_original');
    db.run('UPDATE chat_v2_todo_lists SET is_all_done = 1 WHERE session_id = ?1', [sessionId]);
    expect(service.loadPersistedTodoList(sessionId)).toBeNull();
    expect(service.loadPersistedTodoList('absent')).toBeNull();
  });

  it('restores into the single session-isolated store, with Rust clone ownership on reads and return', () => {
    const a = persisted();
    const b = persisted();
    const restored = service.restoreTodoListFromDb(a.sessionId);
    expect(restored).toStrictEqual(a.list);
    expect(getTodoList(a.sessionId)).toStrictEqual(a.list);
    expect(service.getTodoList(a.sessionId)).toStrictEqual(a.list);
    expect(service.getTodoList(b.sessionId)).toBeNull();
    restored!.steps[0]!.description = 'caller changed';
    const read = getTodoList(a.sessionId)!;
    read.title = 'reader changed';
    expect(getTodoList(a.sessionId)).toStrictEqual(a.list);
    expect(service.restoreTodoListFromDb(b.sessionId)).toStrictEqual(b.list);
  });

  it('restores from a fresh DB read; missing rows and errors leave the prior memory intact', () => {
    const { sessionId, list } = persisted();
    service.restoreTodoListFromDb(sessionId);
    db.run("UPDATE chat_v2_todo_lists SET title = 'new persisted title' WHERE session_id = ?1", [sessionId]);
    expect(service.restoreTodoListFromDb(sessionId)?.title).toBe('new persisted title');
    const before = { ...list, title: 'new persisted title' };
    db.run("UPDATE chat_v2_todo_lists SET steps_json = '[{}]' WHERE session_id = ?1", [sessionId]);
    expect(() => service.restoreTodoListFromDb(sessionId))
      .toThrow('Failed to deserialize steps: missing field `id` at line 1 column 3');
    expect(getTodoList(sessionId)).toStrictEqual(before);
    db.run('UPDATE chat_v2_todo_lists SET is_all_done = 1 WHERE session_id = ?1', [sessionId]);
    expect(service.restoreTodoListFromDb(sessionId)).toBeNull();
    expect(getTodoList(sessionId)).toStrictEqual(before);
  });

  it('uses the supplied transaction connection without opening another connection or committing it', () => {
    const { sessionId, list } = persisted();
    const abort = new Error('test rollback');
    expect(() => db.transaction((tx) => {
      tx.run("UPDATE chat_v2_todo_lists SET title = 'uncommitted' WHERE session_id = ?1", [sessionId]);
      expect(loadPersistedTodoListWithConn(tx, sessionId)?.list.title).toBe('uncommitted');
      expect(restoreTodoListFromDbWithConn(tx, sessionId)?.title).toBe('uncommitted');
      throw abort;
    })).toThrow(abort);
    expect(service.loadPersistedTodoList(sessionId)?.list).toStrictEqual(list);
    // restore sets the in-memory store immediately, as Rust does; it is not a DB transaction participant.
    expect(getTodoList(sessionId)?.title).toBe('uncommitted');
  });

  it('keeps i64 DB columns and JSON timestamps exact, including values above 2^53', () => {
    const { sessionId } = persisted('[{"id":"s","description":"x","status":"running",'
      + '"createdAt":9223372036854775807,"updatedAt":-9223372036854775808}]');
    db.run('UPDATE chat_v2_todo_lists SET created_at = ?1, updated_at = ?2 WHERE session_id = ?3',
      [9223372036854775807n, -9223372036854775808n, sessionId]);
    expect(service.restoreTodoListFromDb(sessionId)).toMatchObject({
      createdAt: 9223372036854775807n, updatedAt: -9223372036854775808n,
      steps: [{ createdAt: 9223372036854775807n, updatedAt: -9223372036854775808n }],
    });
  });

  it('accepts unknown fields and serde positional TodoStep / externally tagged status forms', () => {
    const { sessionId } = persisted('[{"id":"s","description":"x","status":{"pending":null},'
      + '"createdAt":1,"extra":{"anything":[1,true,null]}}]');
    const step = { id: 's', description: 'x', status: 'pending', result: null, createdAt: 1, updatedAt: null };
    expect(service.loadPersistedTodoList(sessionId)?.list.steps).toStrictEqual([step]);
    db.run('UPDATE chat_v2_todo_lists SET steps_json = ?1 WHERE session_id = ?2',
      ['[["s","x","pending",null,1,null]]', sessionId]);
    expect(service.loadPersistedTodoList(sessionId)?.list.steps).toStrictEqual([step]);
  });

  it.each([
    ['null', 'invalid type: null, expected a sequence at line 1 column 4'],
    ['[{}]', 'missing field `id` at line 1 column 3'],
    ['[{"id":1,"later":]', 'invalid type: integer `1`, expected a string at line 1 column 8'],
    ['[{"id":"a","id":', 'duplicate field `id` at line 1 column 15'],
    ['[\n{"id":"步骤","description":false}]', 'invalid type: boolean `false`, expected a string at line 2 column 34'],
    ['[] trailing', 'trailing characters at line 1 column 4'],
    ['[', 'EOF while parsing a list at line 1 column 1'],
  ])('preserves the deserialize context and serde error order/position for %s', (raw, reason) => {
    const { sessionId } = persisted(raw);
    expect(() => service.loadPersistedTodoList(sessionId)).toThrow(`Failed to deserialize steps: ${reason}`);
    expect(service.getTodoList(sessionId)).toBeNull();
  });

  it('does not default a missing TodoStatus; rejects float/overflow i64 literals and unknown variants', () => {
    const cases = [
      ['[{"id":"s","description":"x","createdAt":1}]', 'missing field `status`'],
      ['[{"id":"s","description":"x","status":"bogus","createdAt":1}]',
        'unknown variant `bogus`, expected one of `pending`, `running`, `completed`, `failed`, `skipped`'],
      ['[{"id":"s","description":"x","status":"pending","createdAt":1.0}]',
        'invalid type: floating point `1.0`, expected i64'],
      ['[{"id":"s","description":"x","status":"pending","createdAt":9223372036854775808}]',
        'invalid value: integer `9223372036854775808`, expected i64'],
    ];
    for (const [raw, message] of cases) {
      const { sessionId } = persisted(raw);
      expect(() => service.loadPersistedTodoList(sessionId)).toThrow(`Failed to deserialize steps: ${message}`);
    }
  });

  it('reports SQL/column errors before JSON decoding with the distinct load context', () => {
    const { sessionId } = persisted('[{}]');
    db.run("UPDATE chat_v2_todo_lists SET created_at = 'bad timestamp' WHERE session_id = ?1", [sessionId]);
    expect(() => service.loadPersistedTodoList(sessionId))
      .toThrow('Failed to load TodoList: Invalid column type Text at index: 3, name: created_at');
    const empty = storage.openFile(`${host.app.dataDir}/no-todo-table.db`);
    try {
      expect(() => loadPersistedTodoListWithConn(empty, sessionId))
        .toThrow('Failed to load TodoList: no such table: chat_v2_todo_lists');
    } finally { storage.close(empty); }
  });
});
