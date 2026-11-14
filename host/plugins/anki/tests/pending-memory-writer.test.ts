/**
 * `pendingMemoryCandidates` 服务：memory `knowledge_extract` 的落库写入器（knowledge_executor.rs:104-166）。
 * Rust 当前版本不建这张表（v0.9.2 的 DDL 被移除且没有 DROP），三种库形态都要覆盖。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PendingMemoryCandidateRow, PendingMemoryCandidateWriter } from '../../memory/api.ts';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import { createAnkiTestEnv, type AnkiTestEnv } from './env.ts';

const row = (content: string, category = 'fact'): PendingMemoryCandidateRow => ({
  conversationId: 'c1', subject: '通用', content, category, origin: 'tool_extract', userEdited: false,
});

describe('pendingMemoryCandidates writer (knowledge_executor.rs:104-166)', () => {
  let env: AnkiTestEnv;
  let db: DatabaseHandle;
  const writer = () => env.host.ctx.get('pendingMemoryCandidates') as PendingMemoryCandidateWriter | undefined;
  const contents = () => db.all<{ content: string; status: string; origin: string; user_edited: number }>(
    'SELECT content, status, origin, user_edited FROM pending_memory_candidates ORDER BY id');

  beforeAll(async () => {
    env = await createAnkiTestEnv({ migrationScope: ['mistakes'] });
    db = env.storage.database('mistakes');
  });
  afterAll(async () => { await env?.dispose(); });
  beforeEach(() => { db.run('DROP TABLE IF EXISTS pending_memory_candidates'); });

  it('is published by anki and propagates the missing-table error (fresh Rust databases have no table)', () => {
    expect(writer()).toBeDefined();
    expect(() => writer()!.replacePendingCandidates('c1', [row('a')])).toThrow('no such table: pending_memory_candidates');
  });

  it('replaces only the conversation\'s pending rows, in order, inside one transaction', async () => {
    db.exec(`CREATE TABLE pending_memory_candidates (
      id INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id TEXT NOT NULL, subject TEXT NOT NULL DEFAULT '通用',
      content TEXT NOT NULL, category TEXT NOT NULL, origin TEXT DEFAULT 'auto_extract', user_edited INTEGER DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      expires_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+7 days')))`);
    db.run(`INSERT INTO pending_memory_candidates (conversation_id, content, category, status) VALUES
      ('c1', 'old pending', 'fact', 'pending'), ('c1', 'old saved', 'fact', 'saved'), ('c2', 'other', 'fact', 'pending')`);

    expect(writer()!.replacePendingCandidates('c1', [row('new 1', 'preference'), row('new 2')])).toBe(2);
    expect(contents()).toEqual([
      { content: 'old saved', status: 'saved', origin: 'auto_extract', user_edited: 0 },
      { content: 'other', status: 'pending', origin: 'auto_extract', user_edited: 0 },
      { content: 'new 1', status: 'pending', origin: 'tool_extract', user_edited: 0 },
      { content: 'new 2', status: 'pending', origin: 'tool_extract', user_edited: 0 },
    ]);
    expect(await env.host.invoke('get_pending_memory_candidates', { conversationId: 'chat-c1' })).toMatchObject({
      conversation_id: 'c1', subject: '通用',
      candidates: [{ content: 'new 1', category: 'preference' }, { content: 'new 2', category: 'fact' }],
    });
  });

  it('rolls the DELETE back when an INSERT fails (v0.9.2 table has no subject column)', () => {
    db.exec(`CREATE TABLE pending_memory_candidates (
      id INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id TEXT NOT NULL, content TEXT NOT NULL,
      category TEXT NOT NULL, origin TEXT DEFAULT 'auto_extract', user_edited INTEGER DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      expires_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+7 days')))`);
    db.run("INSERT INTO pending_memory_candidates (conversation_id, content, category) VALUES ('c1', 'kept', 'fact')");
    expect(() => writer()!.replacePendingCandidates('c1', [row('new')])).toThrow('no column named subject');
    expect(contents().map(entry => entry.content)).toEqual(['kept']);
    expect(db.inTransaction ?? false).toBe(false);
  });
});
