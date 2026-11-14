import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import plugin from '../index.ts';
import { databaseFixture, vfsStub } from './database-fixture.ts';
import { newSession } from '../src/types.ts';
import type { ChatSessionService, CompactionRecord } from '../api.ts';

describe('chatSession compaction transaction API', () => {
  let f: ReturnType<typeof databaseFixture>;
  let host: Awaited<ReturnType<typeof createTestHost>>;
  let service: ChatSessionService;
  beforeEach(async () => {
    f = databaseFixture(); host = await createTestHost({ plugins: [plugin], provide: { storage: f.storage, vfs: vfsStub } });
    service = host.ctx.chatSession; service.createSession(newSession('sess_cmp', 'chat'));
    for (const [id, timestamp] of [['msg_a', 1], ['msg_b', 2], ['msg_summary', 3]] as const) {
      service.createMessage({ id, sessionId: 'sess_cmp', role: 'assistant', timestamp, blockIds: [] });
    }
    service.createBlock({ id: 'blk_summary', messageId: 'msg_summary', type: 'compaction_summary', status: 'success', toolOutput: {} });
  });
  afterEach(async () => { await host.dispose(); f.dispose(); });
  function record(id = 'cmp_1'): CompactionRecord {
    return { id, sessionId: 'sess_cmp', summaryMessageId: 'msg_summary', tailStartMessageId: 'msg_b',
      tailStartTimeCreated: 2, reason: 'manual', isAuto: false, isOverflow: false,
      tokensBefore: 100, tokensAfter: 30, modelId: null, modelConfigId: null, previousCompactionId: null,
      rangeStartMessageId: 'msg_a', rangeEndMessageId: 'msg_b', compactedMessageCount: 1, createdAt: 3 };
  }
  it('create, pointer and summary activation commit together through one caller transaction', () => {
    f.db.transaction(tx => {
      service.createCompactionWithConn(tx, record());
      expect(service.getActiveCompactionWithConn(tx, 'sess_cmp')).toBeNull();
      service.setSessionLastCompactionWithConn(tx, 'sess_cmp', 'cmp_1');
    }, { behavior: 'immediate' });
    expect(service.getActiveCompactionWithConn(f.db, 'sess_cmp')).toEqual(record());
    expect(service.getCompactionByIdWithConn(f.db, 'cmp_1')).toEqual(record());
    expect(service.listCompactionsWithConn(f.db, 'sess_cmp')).toEqual([record()]);
    expect(service.getBlock('blk_summary')?.toolOutput).toEqual({ isActive: true });
    const timestamp = f.db.pluck<string>('SELECT updated_at FROM chat_v2_compactions WHERE id = ?', ['cmp_1'])!;
    expect(timestamp).toMatch(/\+00:00$/);
    expect(() => service.createCompactionWithConn(f.db, { ...record(), tailStartMessageId: 'msg_a' })).toThrow();
    expect(service.getCompactionByIdWithConn(f.db, 'cmp_1')?.tailStartMessageId).toBe('msg_b');
  });
  it('a caller rollback removes the record and restores the summary and session pointer', () => {
    expect(() => f.db.transaction(tx => {
      service.createCompactionWithConn(tx, record());
      service.setSessionLastCompactionWithConn(tx, 'sess_cmp', 'cmp_1');
      throw new Error('cancel commit');
    }, { behavior: 'immediate' })).toThrow('cancel commit');
    expect(service.getCompactionByIdWithConn(f.db, 'cmp_1')).toBeNull();
    expect(service.getActiveCompactionWithConn(f.db, 'sess_cmp')).toBeNull();
    expect(service.getBlock('blk_summary')?.toolOutput).toEqual({});
  });
  it('dangling and cross-session pointers retain the Rust diagnostics', () => {
    const messages: string[] = [];
    host.ctx.logger.exporter({ levels: { default: 4 }, export(message) {
      if (message.type === 'warn' || message.type === 'error') messages.push(String(message.args[0]));
    } });
    service.createCompactionWithConn(f.db, record());
    service.createSession(newSession('sess_other', 'chat'));
    service.setSessionLastCompactionWithConn(f.db, 'sess_other', 'cmp_1');
    expect(service.getActiveCompactionWithConn(f.db, 'sess_other')).toBeNull();
    service.setSessionLastCompactionWithConn(f.db, 'sess_cmp', 'cmp_missing');
    expect(service.getActiveCompactionWithConn(f.db, 'sess_cmp')).toBeNull();
    expect(messages).toEqual([
      '[chat_v2::repo] session sess_other points to compaction cmp_1 owned by sess_cmp; using raw history',
      '[chat_v2::repo] session sess_cmp points to missing compaction cmp_missing; using raw history',
    ]);
  });
  it('invalidation updates summary flags, pointer and the post-write info log', () => {
    service.createCompactionWithConn(f.db, record()); service.setSessionLastCompactionWithConn(f.db, 'sess_cmp', 'cmp_1');
    const logs: string[] = [];
    host.ctx.logger.exporter({ levels: { default: 4 }, export(message) { if (message.type === 'info') logs.push(String(message.args[0])); } });
    expect(service.invalidateCompactionForMessageWithConn(f.db, 'sess_cmp', 'msg_a')).toBe(true);
    expect(service.getActiveCompactionWithConn(f.db, 'sess_cmp')).toBeNull();
    expect(service.getBlock('blk_summary')?.toolOutput).toEqual({ isActive: false });
    expect(logs).toEqual(['[chat_v2::repo] invalidated compaction cmp_1 after message msg_a changed in session sess_cmp']);
  });
});
