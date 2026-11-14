import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import plugin from '../index.ts';
import { databaseFixture, vfsStub } from './database-fixture.ts';
import { createSession, getSession } from '../repository/sessions.ts';
import { createMessage } from '../repository/messages.ts';
import { createBlock, getBlock } from '../repository/blocks.ts';
import { createGroup, getGroup } from '../repository/groups.ts';
import { newSession } from '../src/types.ts';
import type { ChatSessionService } from '../api.ts';

describe('stale anki block reaper slot (manage_session.rs:242-314)', () => {
  let f: ReturnType<typeof databaseFixture>;
  let host: Awaited<ReturnType<typeof createTestHost>>;
  let logs: string[];
  beforeEach(async () => {
    f = databaseFixture();
    host = await createTestHost({ plugins: [plugin], provide: { storage: f.storage, vfs: vfsStub,
      agentApproval: { clearSessionRemembered() {} } } });
    logs = [];
    host.ctx.logger.exporter({ levels: { default: 3 }, export(message) {
      if (message.type === 'warn' || message.type === 'info') logs.push(`${message.type}:${String(message.args[0])}`);
    } });
  });
  afterEach(async () => { await host.dispose(); f.dispose(); });

  const sessions = (): ChatSessionService => host.ctx.get('chatSession') as ChatSessionService;

  function seedRunningAnkiBlock(sessionId: string, groupId?: string): void {
    createSession(f.db, { ...newSession(sessionId, 'chat'), groupId });
    createMessage(f.db, { id: `msg_${sessionId}`, sessionId, role: 'assistant', blockIds: [`blk_${sessionId}`], timestamp: 1 });
    createBlock(f.db, { id: `blk_${sessionId}`, messageId: `msg_${sessionId}`, type: 'anki_cards', status: 'running', blockIndex: 0 });
  }

  function markFailed(blockId: string): void {
    f.db.run(`UPDATE chat_v2_blocks SET status = 'error' WHERE id = ?1`, [blockId]);
  }

  it('soft and hard delete reap stale blocks through the registered reaper before the running check', async () => {
    const reaped: string[] = [];
    sessions().registerStaleAnkiBlockReaper({
      reapStaleRunningAnkiBlocks(sessionId) { reaped.push(sessionId); markFailed(`blk_${sessionId}`); return [`blk_${sessionId}`]; },
    });
    seedRunningAnkiBlock('sess_reap_soft');
    await expect(host.invoke('chat_v2_soft_delete_session', { sessionId: 'sess_reap_soft' })).resolves.toBeNull();
    expect(getSession(f.db, 'sess_reap_soft')!.persistStatus).toBe('deleted');
    expect(getBlock(f.db, 'blk_sess_reap_soft')!.status).toBe('error');

    seedRunningAnkiBlock('sess_reap_hard');
    await expect(host.invoke('chat_v2_delete_session', { sessionId: 'sess_reap_hard' })).resolves.toBeNull();
    expect(getSession(f.db, 'sess_reap_hard')).toBeNull();
    expect(reaped).toEqual(['sess_reap_soft', 'sess_reap_hard']);
    expect(logs).toContain('info:[ChatV2::handlers] Marked 1 stale running anki block(s) as failed before delete check (session sess_reap_soft)');
  });

  it('delete_group reaps every owned session before checking for running generations', async () => {
    const now = '2026-11-07T00:00:00Z';
    createGroup(f.db, { id: 'group_reap', name: 'G', defaultSkillIds: [], pinnedResourceIds: [],
      sortOrder: 1, persistStatus: 'archived', createdAt: now, updatedAt: now });
    seedRunningAnkiBlock('sess_in_group', 'group_reap');
    sessions().registerStaleAnkiBlockReaper({
      reapStaleRunningAnkiBlocks(sessionId) { markFailed(`blk_${sessionId}`); return [`blk_${sessionId}`]; },
    });
    await expect(host.invoke('chat_v2_delete_group', { groupId: 'group_reap' })).resolves.toBeNull();
    expect(getGroup(f.db, 'group_reap')).toBeNull();
    expect(getSession(f.db, 'sess_in_group')).toBeNull();
  });

  it('a failing reaper only warns and the conservative running count still blocks deletion', async () => {
    sessions().registerStaleAnkiBlockReaper({ reapStaleRunningAnkiBlocks() { throw new Error('reap exploded'); } });
    seedRunningAnkiBlock('sess_reap_fail');
    await expect(host.invoke('chat_v2_soft_delete_session', { sessionId: 'sess_reap_fail' }))
      .rejects.toContain('Cannot delete session while ChatAnki generation is still running.');
    expect(logs).toContain('warn:[ChatV2::handlers] Failed to reap stale running anki blocks for sess_reap_fail: reap exploded');
  });

  it('the slot keeps the first reaper until it is disposed', () => {
    const first = sessions().registerStaleAnkiBlockReaper({ reapStaleRunningAnkiBlocks: () => [] });
    expect(() => sessions().registerStaleAnkiBlockReaper({ reapStaleRunningAnkiBlocks: () => [] })).toThrow('service slot already occupied');
    first.dispose();
    expect(() => sessions().registerStaleAnkiBlockReaper({ reapStaleRunningAnkiBlocks: () => [] })).not.toThrow();
  });
});
