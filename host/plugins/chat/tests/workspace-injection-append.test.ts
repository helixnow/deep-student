import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import plugin from '../index.ts';
import { databaseFixture, vfsStub } from './database-fixture.ts';
import { newSession } from '../src/types.ts';
import type { SqlExecutor } from '../../../platform/storage/api.ts';

// pipeline/tool_loop.rs:2718-2768 `append_block_id_to_message_block_ids`, through the published owner method.
describe('WP-097 appendWorkspaceInjectionBlockIdWithConn', () => {
  let f: ReturnType<typeof databaseFixture>;
  let host: Awaited<ReturnType<typeof createTestHost>>;
  const raw = (db: SqlExecutor, id: string) => db.get<{ block_ids_json: unknown }>(
    'SELECT block_ids_json FROM chat_v2_messages WHERE id = ?1', [id])?.block_ids_json;
  const seed = (id: string, blockIdsJson: string) => {
    host.ctx.chatSession.createMessage({ id, sessionId: 'sess_ws', role: 'assistant', blockIds: [], timestamp: 7 });
    f.db.run('UPDATE chat_v2_messages SET block_ids_json = ?1 WHERE id = ?2', [blockIdsJson, id]);
  };
  const append = (db: SqlExecutor, messageId: string, blockId: string) =>
    host.ctx.chatSession.appendWorkspaceInjectionBlockIdWithConn(db, 'sess_ws', messageId, blockId);
  /** The shipped schema has `block_ids_json TEXT NOT NULL`; rebuild it untyped so NULL/INTEGER/REAL/BLOB survive. */
  const untypedMessages = () => f.db.exec(`DROP TABLE chat_v2_messages;
    CREATE TABLE chat_v2_messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL,
      block_ids_json, timestamp INTEGER NOT NULL)`);

  beforeEach(async () => {
    f = databaseFixture();
    host = await createTestHost({ plugins: [plugin], provide: { storage: f.storage, vfs: vfsStub } });
    host.ctx.chatSession.createSession(newSession('sess_ws', 'chat'));
  });
  afterEach(async () => { await host.dispose(); f.dispose(); });

  it('appends to a valid Vec<String> in order and rewrites the canonical serde_json form', () => {
    seed('msg_ok', '[ "blk_a" ,\n "blk_b" ]');
    f.db.transaction(tx => append(tx, 'msg_ok', 'blk_c'), { behavior: 'immediate' });
    expect(raw(f.db, 'msg_ok')).toBe('["blk_a","blk_b","blk_c"]');
    expect(host.ctx.chatSession.getMessage('msg_ok')?.blockIds).toEqual(['blk_a', 'blk_b', 'blk_c']);
  });

  it('existing id is not appended again and pre-existing duplicates are kept', () => {
    seed('msg_dup', '["blk_a","blk_x","blk_a"]');
    append(f.db, 'msg_dup', 'blk_a');
    expect(raw(f.db, 'msg_dup')).toBe('["blk_a","blk_x","blk_a"]');
    append(f.db, 'msg_dup', 'blk_new');
    expect(raw(f.db, 'msg_dup')).toBe('["blk_a","blk_x","blk_a","blk_new"]');
  });

  it('JSON that is not a Vec<String> falls back to [] as a whole', () => {
    const bad = ['not json', '', '{"a":1}', '"blk_a"', '["blk_a",1]', '["blk_a",null]', '[["blk_a"]]',
      '["blk_a",]', '["blk_a"] x', '["blk_a"', '["\\ud800"]', '["a\u0001"]'];
    bad.forEach((json, i) => seed(`msg_bad_${i}`, json));
    f.db.transaction(tx => bad.forEach((_, i) => append(tx, `msg_bad_${i}`, 'blk_ws')), { behavior: 'immediate' });
    bad.forEach((_, i) => expect(raw(f.db, `msg_bad_${i}`), bad[i]).toBe('["blk_ws"]'));
  });

  it('NULL block_ids_json falls back to []', () => {
    untypedMessages();
    f.db.run("INSERT INTO chat_v2_messages VALUES ('msg_null', 'sess_ws', 'assistant', NULL, 1)");
    append(f.db, 'msg_null', 'blk_ws');
    expect(raw(f.db, 'msg_null')).toBe('["blk_ws"]');
  });

  it('only block_ids_json is read: corrupt sibling columns do not stop the append', () => {
    seed('msg_sibling', '["blk_a"]');
    f.db.run(`UPDATE chat_v2_messages SET meta_json = '{bad', attachments_json = 'x', variants_json = '[1',
      shared_context_json = 'y', timestamp = 'not a number' WHERE id = 'msg_sibling'`);
    append(f.db, 'msg_sibling', 'blk_b');
    expect(raw(f.db, 'msg_sibling')).toBe('["blk_a","blk_b"]');
  });

  it('missing row creates an assistant message with Rust millisecond timestamp in the caller transaction', () => {
    const before = Date.now();
    f.db.transaction(tx => {
      append(tx, 'msg_missing', 'blk_ws');
      expect(raw(tx, 'msg_missing')).toBe('["blk_ws"]');
    }, { behavior: 'immediate' });
    const after = Date.now();
    const row = f.db.get<{ session_id: string; role: string; timestamp: number; parent_id: unknown }>(
      'SELECT session_id, role, timestamp, parent_id FROM chat_v2_messages WHERE id = ?1', ['msg_missing'])!;
    expect(row.session_id).toBe('sess_ws');
    expect(row.role).toBe('assistant');
    expect(row.parent_id).toBeNull();
    expect(Number.isInteger(row.timestamp)).toBe(true);
    expect(row.timestamp).toBeGreaterThanOrEqual(before);
    expect(row.timestamp).toBeLessThanOrEqual(after);
  });

  it('writes stay in the caller transaction and roll back with it', () => {
    seed('msg_tx', '["blk_a"]');
    expect(() => f.db.transaction(tx => {
      append(tx, 'msg_tx', 'blk_b');
      append(tx, 'msg_tx_new', 'blk_c');
      expect(raw(tx, 'msg_tx')).toBe('["blk_a","blk_b"]');
      throw new Error('abort caller transaction');
    }, { behavior: 'immediate' })).toThrow('abort caller transaction');
    expect(raw(f.db, 'msg_tx')).toBe('["blk_a"]');
    expect(raw(f.db, 'msg_tx_new')).toBeUndefined();
  });

  it('non-TEXT block_ids_json is a read error, never the missing-row branch', () => {
    untypedMessages();
    f.db.run("INSERT INTO chat_v2_messages VALUES ('msg_int', 'sess_ws', 'assistant', 5, 1)");
    f.db.run("INSERT INTO chat_v2_messages VALUES ('msg_real', 'sess_ws', 'assistant', 1.0, 1)");
    f.db.run("INSERT INTO chat_v2_messages VALUES ('msg_blob', 'sess_ws', 'assistant', X'5B5D', 1)");
    for (const [id, type] of [['msg_int', 'Integer'], ['msg_real', 'Real'], ['msg_blob', 'Blob']]) {
      expect(() => append(f.db, id!, 'blk_ws')).toThrow(new Error(`Failed to read message: Invalid column type ${type} at index: 0, name: block_ids_json`));
    }
    expect(raw(f.db, 'msg_int')).toBe(5);
    expect(f.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM chat_v2_messages')?.n).toBe(3);
  });

  it('read / update / create failures keep the Rust error prefixes', () => {
    seed('msg_upd', '["blk_a"]');
    f.db.exec(`CREATE TRIGGER fail_upd BEFORE UPDATE OF block_ids_json ON chat_v2_messages
      BEGIN SELECT RAISE(FAIL, 'update blocked'); END`);
    expect(() => append(f.db, 'msg_upd', 'blk_b')).toThrow(new Error('Failed to update message block_ids: update blocked'));
    expect(raw(f.db, 'msg_upd')).toBe('["blk_a"]');
    f.db.exec(`CREATE TRIGGER fail_ins BEFORE INSERT ON chat_v2_messages
      BEGIN SELECT RAISE(FAIL, 'insert blocked'); END`);
    expect(() => append(f.db, 'msg_new', 'blk_b')).toThrow(new Error('Failed to create message: insert blocked'));
    f.db.exec('ALTER TABLE chat_v2_messages RENAME TO chat_v2_messages_gone');
    expect(() => append(f.db, 'msg_upd', 'blk_b')).toThrow(new Error('Failed to read message: no such table: chat_v2_messages'));
  });
});
