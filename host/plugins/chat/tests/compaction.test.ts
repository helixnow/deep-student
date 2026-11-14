import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import plugin from '../index.ts';
import { databaseFixture, vfsStub } from './database-fixture.ts';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import { ChatV2Error, ChatV2State } from '../api.ts';
import type { UndoCompactionResponse } from '../api.ts';
import { newSession } from '../src/types.ts';
import { createSession } from '../repository/sessions.ts';
import { createMessage } from '../repository/messages.ts';
import { createBlock, getBlock } from '../repository/blocks.ts';
import {
  createCompaction, getActiveCompaction, setSessionLastCompaction, type CompactionRecord,
} from '../repository/compactions.ts';
import { undoCompactionAction } from '../src/compaction-actions.ts';

function compaction(
  id: string, sessionId: string, summaryMessageId: string, previousId: string | null = null,
): CompactionRecord {
  return {
    id, sessionId, summaryMessageId, tailStartMessageId: summaryMessageId,
    tailStartTimeCreated: 1, reason: 'manual', isAuto: false, isOverflow: false,
    tokensBefore: 100, tokensAfter: 10, modelId: 'deepseek-chat', modelConfigId: 'cfg',
    previousCompactionId: previousId, rangeStartMessageId: null, rangeEndMessageId: null,
    compactedMessageCount: 3, createdAt: 1000,
  };
}

function commandError(kind: string, data?: unknown): string {
  const ErrorClass = ChatV2Error as unknown as new (kind: string, data?: unknown) => ChatV2Error;
  return new ErrorClass(kind, data).toCommandError();
}

describe('chat_v2 undo compaction', () => {
  let f: ReturnType<typeof databaseFixture>;
  let host: Awaited<ReturnType<typeof createTestHost>>;
  let db: DatabaseHandle;

  /** Creates a session with one compaction summary message + block per record. */
  function seed(records: CompactionRecord[]): void {
    const sessionId = records[0]!.sessionId;
    const session = newSession(sessionId, 'chat');
    createSession(db, session);
    for (const record of records) {
      createMessage(db, {
        id: record.summaryMessageId, sessionId, role: 'assistant', timestamp: 1,
        blockIds: [`blk_${record.id}`],
      });
      createBlock(db, {
        id: `blk_${record.id}`, messageId: record.summaryMessageId, type: 'compaction_summary',
        status: 'success', blockIndex: 0, toolOutput: { isActive: true, compactionId: record.id },
      });
      createCompaction(db, record);
    }
    setSessionLastCompaction(db, sessionId, records.at(-1)!.id);
  }

  beforeEach(async () => {
    f = databaseFixture();
    db = f.db;
    host = await createTestHost({ plugins: [plugin], provide: { storage: f.storage, vfs: vfsStub } });
  });
  afterEach(async () => { await host.dispose(); f.dispose(); });

  it('undoes the active compaction and reactivates the previous one', async () => {
    seed([
      compaction('cmp_1', 'sess_compact', 'msg_summary_1'),
      compaction('cmp_2', 'sess_compact', 'msg_summary_2', 'cmp_1'),
    ]);

    const result = await host.invoke<UndoCompactionResponse>('chat_v2_undo_compaction', {
      sessionId: 'sess_compact', compactionId: 'cmp_2',
    });
    expect(result).toEqual({ activeCompactionId: 'cmp_1' });
    expect(getActiveCompaction(db, 'sess_compact')!.id).toBe('cmp_1');
    expect((getBlock(db, 'blk_cmp_2')!.toolOutput as Record<string, unknown>).isActive).toBe(false);
    expect((getBlock(db, 'blk_cmp_1')!.toolOutput as Record<string, unknown>).isActive).toBe(true);
    const pointer = db.get<{ last_compaction_id: string }>(
      'SELECT last_compaction_id FROM chat_v2_sessions WHERE id = ?1', ['sess_compact'])!;
    expect(pointer.last_compaction_id).toBe('cmp_1');

    await expect(host.invoke<UndoCompactionResponse>('chat_v2_undo_compaction', {
      sessionId: 'sess_compact', compactionId: 'cmp_1',
    })).resolves.toEqual({ activeCompactionId: null });
    expect(getActiveCompaction(db, 'sess_compact')).toBeNull();
    expect((getBlock(db, 'blk_cmp_1')!.toolOutput as Record<string, unknown>).isActive).toBe(false);
    const cleared = db.get<{ last_compaction_id: string | null }>(
      'SELECT last_compaction_id FROM chat_v2_sessions WHERE id = ?1', ['sess_compact'])!;
    expect(cleared.last_compaction_id).toBeNull();
  });

  it('rejects a stale compaction id and a session without an active compaction', async () => {
    seed([compaction('cmp_1', 'sess_compact', 'msg_summary_1')]);
    await expect(host.invoke('chat_v2_undo_compaction', {
      sessionId: 'sess_compact', compactionId: 'cmp_other',
    })).rejects.toBe(commandError('Validation', 'Only the active compaction can be undone'));

    createSession(db, newSession('sess_empty', 'chat'));
    await expect(host.invoke('chat_v2_undo_compaction', {
      sessionId: 'sess_empty', compactionId: 'cmp_1',
    })).rejects.toBe(commandError('Validation', 'No active context compaction'));
  });

  it('fails while the session is streaming and leaves the pointer untouched', async () => {
    seed([compaction('cmp_1', 'sess_compact', 'msg_summary_1')]);
    const state = host.ctx.get('chatState') as ChatV2State;
    const token = state.registerStream('sess_compact');
    await expect(host.invoke('chat_v2_undo_compaction', {
      sessionId: 'sess_compact', compactionId: 'cmp_1',
    })).rejects.toBe(commandError('Other', 'Cannot undo compaction while the session is streaming.'));
    expect(getActiveCompaction(db, 'sess_compact')!.id).toBe('cmp_1');
    token.abort();
    state.removeStream('sess_compact');
  });

  it('releases the stream registration after success and failure', async () => {
    seed([compaction('cmp_1', 'sess_compact', 'msg_summary_1')]);
    const state = host.ctx.get('chatState') as ChatV2State;

    await host.invoke('chat_v2_undo_compaction', { sessionId: 'sess_compact', compactionId: 'cmp_1' });
    expect(state.hasActiveStream('sess_compact')).toBe(false);

    await expect(host.invoke('chat_v2_undo_compaction', {
      sessionId: 'sess_compact', compactionId: 'cmp_1',
    })).rejects.toBe(commandError('Validation', 'No active context compaction'));
    expect(state.hasActiveStream('sess_compact')).toBe(false);
  });

  it('treats a previous compaction owned by another session as absent', () => {
    createSession(db, newSession('sess_compact', 'chat'));
    createSession(db, newSession('sess_other', 'chat'));
    createMessage(db, { id: 'msg_summary_1', sessionId: 'sess_compact', role: 'assistant', timestamp: 1, blockIds: [] });
    createMessage(db, { id: 'msg_summary_other', sessionId: 'sess_other', role: 'assistant', timestamp: 1, blockIds: [] });
    createCompaction(db, compaction('cmp_other', 'sess_other', 'msg_summary_other'));
    createCompaction(db, compaction('cmp_1', 'sess_compact', 'msg_summary_1', 'cmp_other'));
    setSessionLastCompaction(db, 'sess_compact', 'cmp_1');

    const state = new ChatV2State();
    const result = undoCompactionAction(db, state, 'sess_compact', 'cmp_1');
    expect(result).toEqual({ activeCompactionId: null });
    expect(getActiveCompaction(db, 'sess_compact')).toBeNull();
  });

  it('treats a dangling session pointer as no active compaction', async () => {
    createSession(db, newSession('sess_compact', 'chat'));
    db.run('UPDATE chat_v2_sessions SET last_compaction_id = ?2 WHERE id = ?1',
      ['sess_compact', 'cmp_missing']);
    await expect(host.invoke('chat_v2_undo_compaction', {
      sessionId: 'sess_compact', compactionId: 'cmp_missing',
    })).rejects.toBe(commandError('Validation', 'No active context compaction'));
  });
});
