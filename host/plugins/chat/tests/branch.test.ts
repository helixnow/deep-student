import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import plugin from '../index.ts';
import { databaseFixture, vfsStub } from './database-fixture.ts';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import { parseRfc3339 } from '../../../platform/time/index.ts';
import { ChatV2Error, type ChatMessage, type ChatSession } from '../api.ts';
import { newSession } from '../src/types.ts';
import { createSession, getSession } from '../repository/sessions.ts';
import { createMessage, getSessionMessages } from '../repository/messages.ts';
import {
  createBlock, getBlock, getMessageBlocks,
} from '../repository/blocks.ts';
import {
  createCompaction, getActiveCompaction, historyBoundaryId, setSessionLastCompaction,
  type CompactionRecord,
} from '../repository/compactions.ts';
import { loadSessionState, saveSessionState } from '../repository/session-state.ts';

function commandError(kind: string, data?: unknown): string {
  const ErrorClass = ChatV2Error as unknown as new (kind: string, data?: unknown) => ChatV2Error;
  return new ErrorClass(kind, data).toCommandError();
}

describe('chat_v2_branch_session', () => {
  let f: ReturnType<typeof databaseFixture>;
  let host: Awaited<ReturnType<typeof createTestHost>>;
  let db: DatabaseHandle;

  beforeEach(async () => {
    f = databaseFixture();
    db = f.db;
    host = await createTestHost({ plugins: [plugin], provide: { storage: f.storage, vfs: vfsStub } });
  });
  afterEach(async () => { await host.dispose(); f.dispose(); });

  it('branch_preserves_summary_only_compaction_boundaries', async () => {
    const session = newSession('sess_summary_only_branch', 'chat');
    createSession(db, session);
    const original: ChatMessage = {
      id: 'msg_original', sessionId: session.id, role: 'user', blockIds: [], timestamp: 1_000,
    };
    createMessage(db, original);
    const summary: ChatMessage = {
      id: 'msg_summary_src', sessionId: session.id, role: 'assistant',
      blockIds: ['blk_summary_src'], timestamp: 2_000,
    };
    createMessage(db, summary);
    createBlock(db, {
      id: 'blk_summary_src', messageId: summary.id, type: 'compaction_summary',
      status: 'success', blockIndex: 0, content: 'Saved task state',
    });
    const record: CompactionRecord = {
      id: 'cmp_src', sessionId: session.id, summaryMessageId: summary.id,
      tailStartMessageId: summary.id, tailStartTimeCreated: 1_000, reason: 'overflow',
      isAuto: false, isOverflow: true, tokensBefore: null, tokensAfter: null,
      modelId: null, modelConfigId: null, previousCompactionId: null,
      rangeStartMessageId: original.id, rangeEndMessageId: original.id,
      compactedMessageCount: 1, createdAt: 2_000,
    };
    createCompaction(db, record);
    setSessionLastCompaction(db, session.id, record.id);
    saveSessionState(db, session.id, { sessionId: session.id, updatedAt: '2026-01-01T00:00:00+00:00' });

    // Branch before the summary artifact: it must be copied explicitly and remapped.
    const branched = await host.invoke<ChatSession>('chat_v2_branch_session', {
      sourceSessionId: session.id, upToMessageId: original.id,
    });
    const copied = getActiveCompaction(db, branched.id)!;
    const lineage = (branched.metadata as { branchedFrom: { branchedAt: string } }).branchedFrom;
    const branchInstant = parseRfc3339(branched.createdAt)!;
    expect(branchInstant).not.toBeNull();
    expect(branched.createdAt.endsWith('Z')).toBe(true);
    expect(branched.updatedAt).toBe(branched.createdAt);
    expect(lineage.branchedAt.endsWith('+00:00')).toBe(true);
    expect(parseRfc3339(lineage.branchedAt)!.epochNanos).toBe(branchInstant.epochNanos);
    expect(loadSessionState(db, branched.id)!.updatedAt).toBe(lineage.branchedAt);
    expect(copied.createdAt).toBe(branchInstant.millis);
    expect(copied.tailStartMessageId).toBe(copied.summaryMessageId);
    expect(copied.summaryMessageId).not.toBe(record.summaryMessageId);
    expect(historyBoundaryId(copied)).not.toBe(original.id);
    expect(copied).toMatchObject({
      sessionId: branched.id, reason: 'branch', isAuto: false, isOverflow: true,
      tokensBefore: null, tokensAfter: null, previousCompactionId: null,
      compactedMessageCount: 1, tailStartTimeCreated: 1_000,
    });

    const branchMessages = getSessionMessages(db, branched.id);
    const boundary = historyBoundaryId(copied);
    expect(branchMessages.map(message => message.id)).toContain(copied.summaryMessageId);
    expect(copied.rangeStartMessageId).toBe(branchMessages[0]!.id);
    expect(copied.rangeEndMessageId).toBe(branchMessages[0]!.id);

    // `apply_compaction_view` (pipeline/compaction.rs:1480-1572) filters
    // compaction summary artifacts out of the history, then skips the boundary
    // (plus the virtual summary when summary-only). L03 does not publish this
    // helper yet, so the same selection is reproduced with repository reads.
    const summaryIds = new Set(f.db.all<{ message_id: string }>(
      `SELECT DISTINCT b.message_id FROM chat_v2_blocks b
       INNER JOIN chat_v2_messages m ON m.id = b.message_id
       WHERE b.block_type = 'compaction_summary' AND m.session_id = ?1`,
      [branched.id]).map(row => row.message_id));
    const filtered = branchMessages.filter(message => !summaryIds.has(message.id));
    expect(filtered.map(message => message.id)).toEqual([branchMessages[0]!.id]);
    const boundaryIndex = filtered.findIndex(message => message.id === boundary);
    expect(boundaryIndex).toBe(0);
    const summaryOnly = copied.tailStartMessageId === copied.summaryMessageId;
    const kept = filtered.slice(boundaryIndex + (summaryOnly ? 1 : 0));
    expect(kept).toEqual([]);
    const summaryBlock = getMessageBlocks(db, copied.summaryMessageId)
      .find(block => block.type === 'compaction_summary')!;
    expect(summaryBlock.content).toBe('Saved task state');

    // The source session keeps its own compaction pointer.
    expect(getActiveCompaction(db, session.id)!.id).toBe('cmp_src');
  });

  it('branch_from_super_session_strips_super_marker_and_pin', async () => {
    const session: ChatSession = {
      ...newSession('sess_super_src', 'chat'),
      metadata: {
        super_agent: { active: true, version: 1, workspace_id: 'ws_a', hidden: false },
        pinned: true,
      },
    };
    createSession(db, session);
    const message: ChatMessage = {
      id: 'msg_super', sessionId: session.id, role: 'user', blockIds: [], timestamp: 1,
    };
    createMessage(db, message);

    const branched = await host.invoke<ChatSession>('chat_v2_branch_session', {
      sourceSessionId: session.id, upToMessageId: message.id,
    });
    const metadata = branched.metadata as Record<string, unknown>;
    expect(metadata.super_agent).toBeUndefined();
    expect(metadata.pinned).toBeUndefined();
    expect(metadata.branchedFrom).toEqual({
      sessionId: 'sess_super_src', messageId: 'msg_super', compactionId: null,
      branchedAt: expect.any(String),
    });

    const reloaded = getSession(db, branched.id)!;
    expect(reloaded.metadata).toEqual(metadata);
    // The source Super session is left untouched.
    expect(getSession(db, 'sess_super_src')!.metadata).toEqual(session.metadata);
  });

  it('remaps message, block, variant and shared-context ids and deep-copies tool payloads', async () => {
    const session: ChatSession = {
      ...newSession('sess_remap', 'chat'),
      title: '源会话', description: 'source description', groupId: 'grp_1',
      metadata: { authorityMode: 'plan', frozenToolSchemaOrder: ['a', 'b'] },
    };
    createSession(db, session);
    createMessage(db, {
      id: 'msg_user', sessionId: session.id, role: 'user', blockIds: ['blk_text'],
      timestamp: 1_000, persistentStableId: 'stable-1',
      variants: [{
        id: 'var_old', modelId: 'm1', configId: 'cfg', blockIds: ['blk_var'],
        status: 'complete', createdAt: 10,
        usage: { promptTokens: 3, completionTokens: 4, totalTokens: 7, source: 'api' },
      }],
      activeVariantId: 'var_old',
      sharedContext: {
        ragBlockId: 'blk_text', memoryBlockId: 'blk_missing',
        ragSources: [{ title: 'source' }],
      },
      _meta: { modelId: 'm1' },
    });
    createBlock(db, {
      id: 'blk_text', messageId: 'msg_user', type: 'content', status: 'success',
      blockIndex: 0, content: 'hello',
      toolInput: { originating_block_id: 'blk_text', messageId: 'msg_user' },
      toolOutput: { nested: ['msg_user', 'blk_var'] },
    });
    createBlock(db, {
      id: 'blk_var', messageId: 'msg_user', type: 'content', status: 'success',
      blockIndex: 1, content: 'variant text',
    });
    createMessage(db, {
      id: 'msg_late', sessionId: session.id, role: 'assistant', blockIds: [], timestamp: 2_000,
    });
    f.db.run(`UPDATE chat_v2_blocks SET llm_content = 'llm-visible',
      tool_call_id = 'call-1', round_text = 'round-1' WHERE id = 'blk_text'`);

    const branched = await host.invoke<ChatSession>('chat_v2_branch_session', {
      sourceSessionId: session.id, upToMessageId: 'msg_user',
    });
    expect(branched).toMatchObject({
      mode: 'chat', title: '源会话 (branch)', titleLocked: true,
      description: 'source description', groupId: 'grp_1', persistStatus: 'active',
    });
    expect(branched.metadata).toMatchObject({
      authorityMode: 'plan', frozenToolSchemaOrder: ['a', 'b'],
      branchedFrom: { sessionId: 'sess_remap', messageId: 'msg_user', compactionId: null },
    });

    const messages = getSessionMessages(db, branched.id);
    expect(messages).toHaveLength(1);
    const message = messages[0]!;
    expect(message.id).not.toBe('msg_user');
    expect(message.sessionId).toBe(branched.id);
    expect(message.timestamp).toBe(1_000);
    expect(message.persistentStableId).toBe('stable-1');
    expect(message.blockIds).toHaveLength(1);
    const newBlockId = message.blockIds[0]!;
    expect(newBlockId).not.toBe('blk_text');

    const variant = message.variants![0]!;
    expect(variant.id).not.toBe('var_old');
    expect(variant.blockIds).toHaveLength(1);
    const newVariantBlockId = variant.blockIds[0]!;
    expect(newVariantBlockId).not.toBe('blk_var');
    expect(message.activeVariantId).toBe(variant.id);
    expect(variant).toMatchObject({
      modelId: 'm1', configId: 'cfg', status: 'complete', createdAt: 10,
      usage: { promptTokens: 3, completionTokens: 4, totalTokens: 7, source: 'api' },
    });

    const block = getBlock(db, newBlockId)!;
    expect(block).toMatchObject({ messageId: message.id, type: 'content', content: 'hello' });
    expect(block.toolInput).toEqual({
      originating_block_id: newBlockId, messageId: message.id,
    });
    expect(block.toolOutput).toEqual({ nested: [message.id, newVariantBlockId] });
    // Replay sidecar columns are copied at SQL level, not through MessageBlock.
    expect(f.db.get(
      'SELECT llm_content, tool_call_id, round_text FROM chat_v2_blocks WHERE id = ?1',
      [newBlockId])).toEqual({
      llm_content: 'llm-visible', tool_call_id: 'call-1', round_text: 'round-1',
    });

    const shared = message.sharedContext!;
    expect(shared.ragBlockId).toBe(newBlockId);
    expect(shared.memoryBlockId).toBeUndefined();
    expect(shared.ragSources).toEqual([{ title: 'source' }]);
    expect(message._meta).toEqual({ modelId: 'm1' });

    // Source session untouched.
    expect(getSessionMessages(db, session.id)).toHaveLength(2);
    expect(getBlock(db, 'blk_text')!.toolOutput).toEqual({ nested: ['msg_user', 'blk_var'] });
  });

  it('clones a compaction whose summary and tail both survive the cut', async () => {
    const session = newSession('sess_tail', 'chat');
    createSession(db, session);
    const first: ChatMessage = {
      id: 'msg_first', sessionId: session.id, role: 'user', blockIds: [], timestamp: 1_000,
    };
    createMessage(db, first);
    const summary: ChatMessage = {
      id: 'msg_summary', sessionId: session.id, role: 'assistant',
      blockIds: ['blk_summary'], timestamp: 2_000,
    };
    createMessage(db, summary);
    const summaryMetadata = {
      sessionId: session.id, compactionId: 'cmp_src', previousCompactionId: 'cmp_prev',
      reason: 'overflow', rangeStartMessageId: first.id, rangeEndMessageId: summary.id,
      tailStartMessageId: 'msg_tail', tailMessageCount: 2, tokensBefore: 100,
      tokensAfter: 10, isActive: true,
    };
    createBlock(db, {
      id: 'blk_summary', messageId: summary.id, type: 'compaction_summary',
      status: 'success', blockIndex: 0, content: 'summary text', toolOutput: summaryMetadata,
    });
    const tail: ChatMessage = {
      id: 'msg_tail', sessionId: session.id, role: 'user', blockIds: [], timestamp: 3_000,
    };
    createMessage(db, tail);
    const record: CompactionRecord = {
      id: 'cmp_src', sessionId: session.id, summaryMessageId: summary.id,
      tailStartMessageId: tail.id, tailStartTimeCreated: 2_000, reason: 'overflow',
      isAuto: false, isOverflow: true, tokensBefore: 100, tokensAfter: 10,
      modelId: 'deepseek', modelConfigId: 'cfg', previousCompactionId: 'cmp_prev',
      rangeStartMessageId: first.id, rangeEndMessageId: summary.id,
      compactedMessageCount: 2, createdAt: 3_000,
    };
    createCompaction(db, record);
    setSessionLastCompaction(db, session.id, record.id);

    const branched = await host.invoke<ChatSession>('chat_v2_branch_session', {
      sourceSessionId: session.id, upToMessageId: tail.id,
    });
    const messages = getSessionMessages(db, branched.id);
    expect(messages).toHaveLength(3);
    const copied = getActiveCompaction(db, branched.id)!;
    expect(copied).toMatchObject({
      sessionId: branched.id, summaryMessageId: messages[1]!.id,
      tailStartMessageId: messages[2]!.id, tailStartTimeCreated: 2_000,
      reason: 'branch', isAuto: false, isOverflow: true,
      tokensBefore: null, tokensAfter: null, modelId: 'deepseek',
      modelConfigId: 'cfg', previousCompactionId: null,
      rangeStartMessageId: messages[0]!.id, rangeEndMessageId: messages[1]!.id,
      compactedMessageCount: 2,
    });
    expect(copied.id).not.toBe('cmp_src');
    expect(copied.createdAt).toBeGreaterThanOrEqual(3_000);
    const pointer = f.db.get<{ last_compaction_id: string }>(
      'SELECT last_compaction_id FROM chat_v2_sessions WHERE id = ?1', [branched.id])!;
    expect(pointer.last_compaction_id).toBe(copied.id);

    const metadata = getMessageBlocks(db, copied.summaryMessageId)
      .find(block => block.type === 'compaction_summary')!.toolOutput as Record<string, unknown>;
    expect(metadata).toEqual({
      sessionId: branched.id, compactionId: copied.id, previousCompactionId: null,
      reason: 'branch', rangeStartMessageId: messages[0]!.id,
      rangeEndMessageId: messages[1]!.id, tailStartMessageId: messages[2]!.id,
      isActive: true,
    });
    expect('tokensBefore' in metadata).toBe(false);
    expect('tokensAfter' in metadata).toBe(false);
    expect('tailMessageCount' in metadata).toBe(false);

    // Source compaction untouched.
    expect(getActiveCompaction(db, session.id)!.id).toBe('cmp_src');
    expect((getBlock(db, 'blk_summary')!.toolOutput as Record<string, unknown>).compactionId)
      .toBe('cmp_src');
  });

  it('does not clone a compaction outside the copied prefix', async () => {
    const session = newSession('sess_no_clone', 'chat');
    createSession(db, session);
    const first: ChatMessage = {
      id: 'msg_first', sessionId: session.id, role: 'user', blockIds: [], timestamp: 1_000,
    };
    createMessage(db, first);
    const summary: ChatMessage = {
      id: 'msg_summary', sessionId: session.id, role: 'assistant',
      blockIds: ['blk_summary'], timestamp: 2_000,
    };
    createMessage(db, summary);
    createBlock(db, {
      id: 'blk_summary', messageId: summary.id, type: 'compaction_summary',
      status: 'success', blockIndex: 0, content: 'summary text',
    });
    const tail: ChatMessage = {
      id: 'msg_tail', sessionId: session.id, role: 'user', blockIds: [], timestamp: 3_000,
    };
    createMessage(db, tail);
    createCompaction(db, {
      id: 'cmp_src', sessionId: session.id, summaryMessageId: summary.id,
      tailStartMessageId: tail.id, tailStartTimeCreated: 2_000, reason: 'overflow',
      isAuto: false, isOverflow: true, tokensBefore: 100, tokensAfter: 10,
      modelId: null, modelConfigId: null, previousCompactionId: null,
      rangeStartMessageId: first.id, rangeEndMessageId: summary.id,
      compactedMessageCount: 2, createdAt: 3_000,
    });
    setSessionLastCompaction(db, session.id, 'cmp_src');

    const branched = await host.invoke<ChatSession>('chat_v2_branch_session', {
      sourceSessionId: session.id, upToMessageId: first.id,
    });
    expect(getActiveCompaction(db, branched.id)).toBeNull();
    expect(f.db.get<{ count: number }>(
      'SELECT COUNT(*) AS count FROM chat_v2_compactions WHERE session_id = ?1',
      [branched.id])!.count).toBe(0);
    expect(getSessionMessages(db, branched.id)).toHaveLength(1);
  });

  it('clears drafts and branch-local skills in the copied session state', async () => {
    const session = newSession('sess_state', 'chat');
    createSession(db, session);
    saveSessionState(db, session.id, {
      sessionId: session.id, updatedAt: '2026-01-01T00:00:00Z',
      chatParams: { modelId: 'm1' } as never,
      features: { webSearch: true },
      modeState: { mode: 'chat' },
      inputValue: 'draft', panelStates: { right: 'closed' } as never,
      pendingContextRefsJson: '[]',
      skillStateJson: JSON.stringify({
        manualPinnedSkillIds: ['m'], modeRequiredBundleIds: ['r'],
        agenticSessionSkillIds: ['a'], branchLocalSkillIds: ['b'],
        version: 3, legacyMigrated: null,
      }),
    });
    createMessage(db, {
      id: 'msg_state', sessionId: session.id, role: 'user', blockIds: [], timestamp: 1,
    });

    const branched = await host.invoke<ChatSession>('chat_v2_branch_session', {
      sourceSessionId: session.id, upToMessageId: 'msg_state',
    });
    const state = loadSessionState(db, branched.id)!;
    expect(state.sessionId).toBe(branched.id);
    expect(state.chatParams).toEqual({ modelId: 'm1' });
    expect(state.features).toEqual({ webSearch: true });
    expect(state.modeState).toEqual({ mode: 'chat' });
    expect(state.inputValue).toBeUndefined();
    expect(state.panelStates).toBeUndefined();
    expect(state.pendingContextRefsJson).toBeUndefined();
    expect(JSON.parse(state.skillStateJson!)).toMatchObject({
      manualPinnedSkillIds: ['m'], modeRequiredBundleIds: ['r'],
      agenticSessionSkillIds: ['a'],
      version: 4, legacyMigrated: false,
    });
    // types.rs:1205 skip_serializing_if=Vec::is_empty: clearing the branch omits its wire key.
    expect(JSON.parse(state.skillStateJson!)).not.toHaveProperty('branchLocalSkillIds');
    const raw = f.db.get<{ active_skill_ids_json: string; loaded_skill_ids_json: string }>(
      'SELECT active_skill_ids_json, loaded_skill_ids_json FROM chat_v2_session_state WHERE session_id = ?1',
      [branched.id])!;
    expect(JSON.parse(raw.active_skill_ids_json)).toEqual(['m']);
    expect(JSON.parse(raw.loaded_skill_ids_json)).toEqual(['a', 'r']);

    // Source state keeps its draft and branch-local skills.
    const sourceState = loadSessionState(db, session.id)!;
    expect(sourceState.inputValue).toBe('draft');
    expect(JSON.parse(sourceState.skillStateJson!)).toMatchObject({
      branchLocalSkillIds: ['b'], version: 3,
    });
  });

  it('branches an agent_ session into a new sess_ session without state', async () => {
    const session = newSession('agent_worker', 'chat');
    createSession(db, session);
    createMessage(db, {
      id: 'msg_agent', sessionId: session.id, role: 'user', blockIds: [], timestamp: 1,
    });
    const branched = await host.invoke<ChatSession>('chat_v2_branch_session', {
      sourceSessionId: session.id, upToMessageId: 'msg_agent',
    });
    expect(branched.id).toMatch(/^sess_/);
    expect(loadSessionState(db, branched.id)).toBeNull();
    expect(getSessionMessages(db, branched.id)).toHaveLength(1);
  });

  it('rejects invalid ids, missing sessions and unknown cut messages', async () => {
    await expect(host.invoke('chat_v2_branch_session', {
      sourceSessionId: 'group_1', upToMessageId: 'msg_x',
    })).rejects.toBe(commandError('Validation', 'Invalid source session_id format: group_1'));
    await expect(host.invoke('chat_v2_branch_session', {
      sourceSessionId: 'sess_missing', upToMessageId: 'msg_x',
    })).rejects.toBe(commandError('SessionNotFound', 'sess_missing'));

    const session = newSession('sess_errors', 'chat');
    createSession(db, session);
    createMessage(db, {
      id: 'msg_here', sessionId: session.id, role: 'user', blockIds: [], timestamp: 1,
    });
    await expect(host.invoke('chat_v2_branch_session', {
      sourceSessionId: session.id, upToMessageId: 'msg_absent',
    })).rejects.toBe(commandError('MessageNotFound', 'msg_absent (not found in session sess_errors)'));
  });

  it('rejects archived, deleted and subagent source sessions', async () => {
    const archived = { ...newSession('sess_archived', 'chat'), persistStatus: 'archived' as const };
    createSession(db, archived);
    const deleted = { ...newSession('sess_deleted', 'chat'), persistStatus: 'deleted' as const };
    createSession(db, deleted);
    const subagent = { ...newSession('subagent_worker', 'subagent') };
    createSession(db, subagent);
    for (const id of [archived.id, deleted.id, subagent.id]) {
      createMessage(db, {
        id: `msg_${id}`, sessionId: id, role: 'user', blockIds: [], timestamp: 1,
      });
    }

    await expect(host.invoke('chat_v2_branch_session', {
      sourceSessionId: archived.id, upToMessageId: `msg_${archived.id}`,
    })).rejects.toBe(commandError('Validation',
      'Source session is not active (status: Archived): sess_archived'));
    await expect(host.invoke('chat_v2_branch_session', {
      sourceSessionId: deleted.id, upToMessageId: `msg_${deleted.id}`,
    })).rejects.toBe(commandError('Validation',
      'Source session is not active (status: Deleted): sess_deleted'));
    await expect(host.invoke('chat_v2_branch_session', {
      sourceSessionId: subagent.id, upToMessageId: `msg_${subagent.id}`,
    })).rejects.toBe(commandError('Validation',
      'Subagent sessions are read-only; use the workspace runtime to communicate with them.'));
  });
});
