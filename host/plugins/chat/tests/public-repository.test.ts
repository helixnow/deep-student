import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import plugin from '../index.ts';
import { databaseFixture, vfsStub } from './database-fixture.ts';
import { newSession } from '../src/types.ts';
import { registerAskUserCallback, createSessionWithConn, createMessageWithConn, createBlocksBatchWithConn,
  loadSessionMessagesPageWithConn, goalInsertWithConn, goalGetWithConn, goalUpdateStatusWithConn } from '../api.ts';

describe('L05/L06 published chat repository and callback surface', () => {
  let f: ReturnType<typeof databaseFixture>;
  let host: Awaited<ReturnType<typeof createTestHost>>;
  beforeEach(async () => { f = databaseFixture(); host = await createTestHost({ plugins: [plugin], provide: { storage: f.storage, vfs: vfsStub } }); });
  afterEach(async () => { await host.dispose(); f.dispose(); });
  it('public import primitives share caller transactions and page semantics', () => {
    f.db.transaction(tx => {
      createSessionWithConn(tx, newSession('sess_public', 'chat'));
      for (let i = 0; i < 3; i++) createMessageWithConn(tx, { id: `msg_${i}`, sessionId: 'sess_public', role: 'user', blockIds: [`blk_${i}`], timestamp: i });
      createBlocksBatchWithConn(tx, [0, 1, 2].map(i => ({ id: `blk_${i}`, messageId: `msg_${i}`, type: 'content', status: 'success', content: `${i}` })));
    }, { behavior: 'immediate' });
    const [messages, blocks, total] = loadSessionMessagesPageWithConn(f.db, 'sess_public', 2, 1, 'user');
    expect(messages.map(message => message.id)).toEqual(['msg_1']); expect(blocks.map(block => block.id)).toEqual(['blk_1']); expect(total).toBe(3);
    expect(loadSessionMessagesPageWithConn(f.db, 'sess_public', 0, 1, 'user')[0][0]?.id).toBe('msg_0');
    expect(loadSessionMessagesPageWithConn(f.db, 'sess_public', 1, 1, 'user')[0][0]?.id).toBe('msg_0');
  });
  it('goal writes and optimistic updates stay within the caller connection', () => {
    createSessionWithConn(f.db, newSession('sess_goal_public', 'chat'));
    f.db.transaction(tx => {
      goalInsertWithConn(tx, { sessionId: 'sess_goal_public', goalId: 'goal_1', objective: 'learn', status: 'active', tokenBudget: null,
        tokensUsed: 0, timeUsedSeconds: 0, continuationCount: 0, createdAtMs: 1, updatedAtMs: 1 });
      expect(goalUpdateStatusWithConn(tx, 'sess_goal_public', 'stale', 'paused')).toBeNull();
      expect(goalUpdateStatusWithConn(tx, 'sess_goal_public', 'goal_1', 'paused')?.status).toBe('paused');
    });
    expect(goalGetWithConn(f.db, 'sess_goal_public')?.status).toBe('paused');
  });
  it('public callback registration is consumed by the existing ask-user IPC command', async () => {
    const responses: unknown[] = [];
    const unregister = registerAskUserCallback('public_callback', response => responses.push(response));
    try {
      await host.invoke('chat_v2_ask_user_respond', { toolCallId: 'public_callback', selectedTexts: ['yes'], selectedIndices: [0], source: 'user_click' });
      expect(responses).toEqual([{ toolCallId: 'public_callback', selectedTexts: ['yes'], selectedIndices: [0], customText: null, source: 'user_click' }]);
    } finally { unregister(); }
  });
  it('atomic message block-id append deduplicates and deleteSessionV2 cascades after commit', () => {
    createSessionWithConn(f.db, newSession('sess_delete_public', 'chat'));
    createMessageWithConn(f.db, { id: 'msg_public', sessionId: 'sess_delete_public', role: 'assistant', blockIds: [], timestamp: 1 });
    host.ctx.chatSession.createBlock({ id: 'blk_public', messageId: 'msg_public', type: 'content', status: 'success' });
    host.ctx.chatSession.appendBlockIdToMessageWithConn(f.db, 'msg_public', 'blk_public');
    host.ctx.chatSession.appendBlockIdToMessageWithConn(f.db, 'msg_public', 'blk_public');
    expect(host.ctx.chatSession.getMessage('msg_public')?.blockIds).toEqual(['blk_public']);
    host.ctx.chatSession.deleteSessionV2('sess_delete_public');
    expect(host.ctx.chatSession.getMessage('msg_public')).toBeNull(); expect(host.ctx.chatSession.getBlock('blk_public')).toBeNull();
    expect(() => host.ctx.chatSession.deleteSessionV2('sess_delete_public')).toThrow('Session not found');
  });
  it('X5-01 history/final methods keep message writes and the skill-generation marker in the caller transaction', () => {
    const service = host.ctx.chatSession;
    service.createSession({ ...newSession('sess_tx_public', 'chat'), metadata: { availableSkillsSnapshot: 'frozen' } });
    service.createMessage({ id: 'msg_existing', sessionId: 'sess_tx_public', role: 'assistant', blockIds: [], timestamp: 0 });
    expect(() => f.db.transaction(tx => {
      service.createMessageWithConn(tx, { id: 'msg_new', sessionId: 'sess_tx_public', role: 'user', blockIds: [], timestamp: 1 });
      expect(service.getMessageWithConn(tx, 'msg_new')?.role).toBe('user');
      const existing = service.getMessageWithConn(tx, 'msg_existing')!;
      service.updateMessageWithConn(tx, { ...existing, blockIds: ['blk_uncommitted'] });
      expect(service.getMessageWithConn(tx, 'msg_existing')?.blockIds).toEqual(['blk_uncommitted']);
      expect(service.markAvailableSkillsSnapshotStaleWithConn(tx, 'sess_tx_public')).toBe(1);
      throw new Error('abort caller transaction');
    }, { behavior: 'immediate' })).toThrow('abort caller transaction');
    expect(service.getMessage('msg_new')).toBeNull();
    expect(service.getMessage('msg_existing')?.blockIds).toEqual([]);
    expect(service.getSession('sess_tx_public')?.metadata).toEqual({ availableSkillsSnapshot: 'frozen' });
    expect(() => service.updateMessageWithConn(f.db, { id: 'missing', sessionId: 'sess_tx_public', role: 'user', blockIds: [], timestamp: 0 }))
      .toThrow('Message not found: missing');
  });
  it('X5-01 summary artifact IDs come from distinct blocks, scoped to a session without hydrating payloads', () => {
    const service = host.ctx.chatSession;
    for (const sessionId of ['sess_summaries', 'sess_other']) {
      service.createSession(newSession(sessionId, 'chat'));
      service.createMessage({ id: `msg_${sessionId}`, sessionId, role: 'assistant', blockIds: [], timestamp: 0 });
      for (let i = 0; i < 2; i++) service.createBlock({ id: `blk_${sessionId}_${i}`, messageId: `msg_${sessionId}`, type: 'compaction_summary', status: 'success' });
    }
    f.db.run("UPDATE chat_v2_blocks SET tool_output_json = 'invalid json'");
    expect(service.getCompactionSummaryMessageIdsWithConn(f.db, 'sess_summaries')).toEqual(['msg_sess_summaries']);
    expect(service.getCompactionSummaryMessageIdsWithConn(f.db, 'missing')).toEqual([]);
    f.db.exec('DROP TABLE chat_v2_blocks');
    expect(() => service.getCompactionSummaryMessageIdsWithConn(f.db, 'sess_summaries')).toThrow('no such table: chat_v2_blocks');
  });
});
