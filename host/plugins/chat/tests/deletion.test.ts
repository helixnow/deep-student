import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import plugin from '../index.ts';
import { databaseFixture, vfsStub } from './database-fixture.ts';
import { createSession, getSession, updateSession } from '../repository/sessions.ts';
import { createMessage, getMessage } from '../repository/messages.ts';
import { createBlock, getBlock } from '../repository/blocks.ts';
import { insertGoal } from '../repository/goals.ts';
import { saveSessionState } from '../repository/session-state.ts';
import { newSession } from '../src/types.ts';
import { ChatV2Error, ChatV2State } from '../api.ts';
import type { ChatMessage, Variant } from '../api.ts';
import {
  clearBranchLocalSkillState, fallbackSkillStateAfterHistoryRebuild,
  resolveMessageSkillSnapshot,
} from '../src/session-metadata.ts';

function commandError(kind: string, data?: unknown): string {
  const ErrorClass = ChatV2Error as unknown as new (kind: string, data?: unknown) => ChatV2Error;
  return new ErrorClass(kind, data).toCommandError();
}

describe('chat_v2 deletion and skill-state rebuild', () => {
  let f: ReturnType<typeof databaseFixture>;
  let host: Awaited<ReturnType<typeof createTestHost>>;
  beforeEach(async () => {
    f = databaseFixture();
    host = await createTestHost({ plugins: [plugin], provide: { storage: f.storage, vfs: vfsStub } });
  });
  afterEach(async () => { await host.dispose(); f.dispose(); });

  function seedSession(id = 'sess_delete'): void {
    createSession(f.db, newSession(id, 'chat'));
  }

  it('test_resolve_message_skill_snapshot_prefers_active_variant_snapshot', () => {
    const message: ChatMessage = {
      id: 'msg_skill_snapshot', sessionId: 'sess_1', role: 'assistant', blockIds: [], timestamp: 0,
      activeVariantId: 'var_active',
      _meta: { skillSnapshotAfter: { manualPinnedSkillIds: ['message-skill'], version: 2 } },
      variants: [{
        id: 'var_active', modelId: 'model-a', blockIds: [], status: 'success', createdAt: 0,
        meta: { skillSnapshotAfter: { manualPinnedSkillIds: ['variant-skill'], version: 3 } },
      }],
    };
    const resolved = resolveMessageSkillSnapshot(message)!;
    expect(resolved.manualPinnedSkillIds).toEqual(['variant-skill']);
    expect(resolved.version).toBe(3);
  });

  it('test_clear_branch_local_skill_state_removes_only_branch_local', () => {
    const trimmed = clearBranchLocalSkillState({
      manualPinnedSkillIds: ['manual'], agenticSessionSkillIds: ['agentic'],
      branchLocalSkillIds: ['branch'], version: 3,
    });
    expect(trimmed.manualPinnedSkillIds).toEqual(['manual']);
    expect(trimmed.agenticSessionSkillIds).toEqual(['agentic']);
    expect(trimmed.branchLocalSkillIds).toEqual([]);
  });

  it('test_fallback_skill_state_after_history_rebuild_clears_agentic_state', () => {
    const existing = {
      sessionId: 'sess_1', updatedAt: '2026-03-06T00:00:00Z',
      skillStateJson: JSON.stringify({
        manualPinnedSkillIds: ['manual'], modeRequiredBundleIds: ['mode'],
        agenticSessionSkillIds: ['agentic'], branchLocalSkillIds: ['branch'], version: 9,
      }),
    };
    const rebuilt = fallbackSkillStateAfterHistoryRebuild(existing);
    expect(rebuilt.manualPinnedSkillIds).toEqual(['manual']);
    expect(rebuilt.modeRequiredBundleIds).toEqual(['mode']);
    expect(rebuilt.agenticSessionSkillIds).toEqual([]);
    expect(rebuilt.branchLocalSkillIds).toEqual([]);
    expect(rebuilt.version).toBe(10);
  });

  it('delete_message enforces writable, streaming, prefix and ownership, then cascades', async () => {
    seedSession();
    createMessage(f.db, {
      id: 'msg_del', sessionId: 'sess_delete', role: 'assistant', timestamp: 1, blockIds: ['blk_del'],
    });
    createBlock(f.db, {
      id: 'blk_del', messageId: 'msg_del', type: 'content', status: 'success', blockIndex: 0,
    });

    const state = host.ctx.get('chatState') as ChatV2State;
    const token = state.registerStream('sess_delete');
    await expect(host.invoke('chat_v2_delete_message', {
      sessionId: 'sess_delete', messageId: 'msg_del',
    })).rejects.toBe(commandError('Other',
      'Cannot delete message while streaming. Please wait for completion or cancel first.'));
    state.removeStream('sess_delete');
    token.abort();

    await expect(host.invoke('chat_v2_delete_message', {
      sessionId: 'sess_delete', messageId: 'bad',
    })).rejects.toBe(commandError('Validation', 'Invalid message ID format: bad'));

    createMessage(f.db, {
      id: 'msg_other', sessionId: 'sess_delete', role: 'user', timestamp: 2, blockIds: [],
    });
    await expect(host.invoke('chat_v2_delete_message', {
      sessionId: 'sess_other', messageId: 'msg_other',
    })).rejects.toBe(commandError('SessionNotFound', 'sess_other'));

    await expect(host.invoke('chat_v2_delete_message', {
      sessionId: 'sess_delete', messageId: 'msg_del',
    })).resolves.toBeNull();
    expect(getMessage(f.db, 'msg_del')).toBeNull();
    expect(getBlock(f.db, 'blk_del')).toBeNull();
  });

  it('delete_message rebuilds skill state from the newest surviving snapshot', async () => {
    seedSession();
    const variant = (id: string, skill: string): Variant => ({
      id, modelId: 'm', blockIds: [], status: 'success', createdAt: 0,
      meta: { skillSnapshotAfter: { manualPinnedSkillIds: [skill], version: 4 } },
    });
    createMessage(f.db, {
      id: 'msg_old_skill', sessionId: 'sess_delete', role: 'assistant', timestamp: 1,
      blockIds: [], activeVariantId: 'var_old', variants: [variant('var_old', 'old-skill')],
    });
    createMessage(f.db, {
      id: 'msg_new_skill', sessionId: 'sess_delete', role: 'assistant', timestamp: 2,
      blockIds: [], activeVariantId: 'var_new', variants: [variant('var_new', 'new-skill')],
    });
    await host.invoke('chat_v2_delete_message', {
      sessionId: 'sess_delete', messageId: 'msg_new_skill',
    });
    const state = f.db.get<{ skill_state_json: string }>(
      'SELECT skill_state_json FROM chat_v2_session_state WHERE session_id = ?1', ['sess_delete'])!;
    expect(JSON.parse(state.skill_state_json)).toMatchObject({
      manualPinnedSkillIds: ['old-skill'], version: 5,
    });
    expect(JSON.parse(state.skill_state_json)).not.toHaveProperty('branchLocalSkillIds');
  });

  it('delete_message keeps the session and rebuilds fallback state when no snapshot survives', async () => {
    seedSession();
    saveSessionState(f.db, 'sess_delete', {
      sessionId: 'sess_delete', updatedAt: '2026-01-01T00:00:00Z',
      activeSkillIdsJson: '["manual"]', loadedSkillIdsJson: '["loaded"]',
    });
    createMessage(f.db, {
      id: 'msg_plain', sessionId: 'sess_delete', role: 'user', timestamp: 1, blockIds: [],
    });
    await host.invoke('chat_v2_delete_message', {
      sessionId: 'sess_delete', messageId: 'msg_plain',
    });
    const state = f.db.get<{ skill_state_json: string }>(
      'SELECT skill_state_json FROM chat_v2_session_state WHERE session_id = ?1', ['sess_delete'])!;
    expect(JSON.parse(state.skill_state_json)).toMatchObject({
      manualPinnedSkillIds: ['manual'], version: 1,
      legacyMigrated: false,
    });
    expect(JSON.parse(state.skill_state_json)).not.toHaveProperty('agenticSessionSkillIds');
  });

  it('delete_session refuses streaming and running anki blocks before validating the id', async () => {
    seedSession();
    const state = host.ctx.get('chatState') as ChatV2State;
    const token = state.registerStream('sess_delete');
    await expect(host.invoke('chat_v2_delete_session', { sessionId: 'sess_delete' }))
      .rejects.toBe(commandError('Other',
        'Cannot delete session while streaming. Please wait for completion or cancel first.'));
    state.removeStream('sess_delete');
    token.abort();

    createMessage(f.db, {
      id: 'msg_anki_del', sessionId: 'sess_delete', role: 'assistant', timestamp: 1, blockIds: ['blk_anki_del'],
    });
    createBlock(f.db, {
      id: 'blk_anki_del', messageId: 'msg_anki_del', type: 'anki_cards', status: 'running', blockIndex: 0,
    });
    await expect(host.invoke('chat_v2_delete_session', { sessionId: 'sess_delete' }))
      .rejects.toContain('Cannot delete session while ChatAnki generation is still running.');
    f.db.run('UPDATE chat_v2_blocks SET status = ?2 WHERE id = ?1', ['blk_anki_del', 'success']);
    await expect(host.invoke('chat_v2_delete_session', { sessionId: 'bad' }))
      .rejects.toBe(commandError('Validation', 'Invalid session ID format: bad'));
  });

  it('delete_session hard-deletes with cascade and reports missing rows', async () => {
    seedSession();
    createMessage(f.db, {
      id: 'msg_cascade', sessionId: 'sess_delete', role: 'user', timestamp: 1, blockIds: ['blk_cascade'],
    });
    createBlock(f.db, {
      id: 'blk_cascade', messageId: 'msg_cascade', type: 'content', status: 'success', blockIndex: 0,
    });
    insertGoal(f.db, {
      sessionId: 'sess_delete', goalId: 'goal_del', objective: 'x', status: 'active',
      tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0, continuationCount: 0,
      createdAtMs: 1, updatedAtMs: 1,
    });
    await expect(host.invoke('chat_v2_delete_session', { sessionId: 'sess_delete' })).resolves.toBeNull();
    expect(getSession(f.db, 'sess_delete')).toBeNull();
    expect(getMessage(f.db, 'msg_cascade')).toBeNull();
    expect(getBlock(f.db, 'blk_cascade')).toBeNull();
    await expect(host.invoke('chat_v2_delete_session', { sessionId: 'sess_missing_deleted' }))
      .rejects.toBe(commandError('SessionNotFound', 'sess_missing_deleted'));
  });

  it('empty_deleted_sessions purges only rows still marked deleted', async () => {
    seedSession('sess_trash_a');
    seedSession('sess_trash_b');
    seedSession('sess_restored');
    for (const id of ['sess_trash_a', 'sess_trash_b', 'sess_restored']) {
      updateSession(f.db, { ...getSession(f.db, id)!, persistStatus: 'deleted' });
    }
    updateSession(f.db, { ...getSession(f.db, 'sess_restored')!, persistStatus: 'active' });
    await expect(host.invoke('chat_v2_empty_deleted_sessions')).resolves.toBe(2);
    expect(getSession(f.db, 'sess_trash_a')).toBeNull();
    expect(getSession(f.db, 'sess_trash_b')).toBeNull();
    expect(getSession(f.db, 'sess_restored')).not.toBeNull();
    await expect(host.invoke('chat_v2_empty_deleted_sessions')).resolves.toBe(0);
  });
});
