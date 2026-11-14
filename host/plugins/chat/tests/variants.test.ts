import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import plugin from '../index.ts';
import { databaseFixture, vfsStub } from './database-fixture.ts';
import { createSession, getSession } from '../repository/sessions.ts';
import { createMessage, getMessage } from '../repository/messages.ts';
import { createBlock, getBlock } from '../repository/blocks.ts';
import { newSession } from '../src/types.ts';
import { ChatV2Error, ChatV2State } from '../api.ts';
import type { ChatMessage, Variant } from '../api.ts';
import {
  canActivateVariant, canRetryVariant, getVariant, resolveRetryOptions, sessionSkillStateFromSnapshot,
} from '../src/variant-actions.ts';

function variant(id: string, status: string, blockIds: string[] = []): Variant {
  return { id, modelId: `model_${id}`, blockIds, status, createdAt: 1 };
}

function assistantMessage(): ChatMessage {
  return {
    id: 'msg_test_123', sessionId: 'sess_test_456', role: 'assistant',
    blockIds: ['blk_1', 'blk_2'], timestamp: 1,
    activeVariantId: 'var_1',
    variants: [variant('var_1', 'success', ['blk_1']), {
      ...variant('var_2', 'error', ['blk_2']), error: 'Test error',
    }],
  };
}

function commandError(kind: string, data?: unknown): string {
  const ErrorClass = ChatV2Error as unknown as new (kind: string, data?: unknown) => ChatV2Error;
  return new ErrorClass(kind, data).toCommandError();
}

describe('chat_v2 variant handlers', () => {
  let f: ReturnType<typeof databaseFixture>;
  let host: Awaited<ReturnType<typeof createTestHost>>;
  beforeEach(async () => {
    f = databaseFixture();
    host = await createTestHost({ plugins: [plugin], provide: { storage: f.storage, vfs: vfsStub } });
    createSession(f.db, newSession('sess_variants', 'chat'));
  });
  afterEach(async () => { await host.dispose(); f.dispose(); });

  function seedMessage(): void {
    createMessage(f.db, {
      id: 'msg_variants', sessionId: 'sess_variants', role: 'assistant', timestamp: 1,
      blockIds: ['blk_va', 'blk_vb', 'blk_vc'],
      activeVariantId: 'var_a',
      variants: [
        variant('var_a', 'success', ['blk_va']),
        { ...variant('var_b', 'error', ['blk_vb']), error: 'boom' },
        variant('var_c', 'cancelled', ['blk_vc']),
      ],
    });
    for (const [id, messageId] of [['blk_va', 'msg_variants'], ['blk_vb', 'msg_variants'], ['blk_vc', 'msg_variants']] as const) {
      createBlock(f.db, { id, messageId, type: 'content', status: 'success', blockIndex: 0 });
    }
  }

  it('test_variant_can_activate', () => {
    const message = assistantMessage();
    expect(canActivateVariant(message.variants![0]!)).toBe(true);
    expect(canActivateVariant(message.variants![1]!)).toBe(false);
  });

  it('test_variant_can_retry', () => {
    const message = assistantMessage();
    expect(canRetryVariant(message.variants![0]!)).toBe(false);
    expect(canRetryVariant(message.variants![1]!)).toBe(true);
  });

  it('test_get_variant', () => {
    const message = assistantMessage();
    expect(getVariant(message, 'var_1')).toBeDefined();
    expect(getVariant(message, 'var_2')).toBeDefined();
    expect(getVariant(message, 'var_nonexistent')).toBeUndefined();
  });

  it('test_delete_variant_result_serialization', async () => {
    seedMessage();
    const result = await host.invoke<Record<string, unknown>>('chat_v2_delete_variant', {
      sessionId: 'sess_variants', messageId: 'msg_variants', variantId: 'var_b',
    });
    const json = JSON.stringify(result);
    expect(json).toContain('"deletedVariantId"');
    expect(json).toContain('"remainingCount"');
    expect(json).toContain('"newActiveVariantId"');
  });

  it('test_session_skill_state_from_snapshot_drops_branch_local_without_promoting', () => {
    const state = sessionSkillStateFromSnapshot({
      manualPinnedSkillIds: ['manual-a'], modeRequiredBundleIds: ['mode-a'],
      agenticSessionSkillIds: ['agentic-a'], branchLocalSkillIds: ['branch-a'], version: 4,
    });
    expect(state.manualPinnedSkillIds).toEqual(['manual-a']);
    expect(state.modeRequiredBundleIds).toEqual(['mode-a']);
    expect(state.agenticSessionSkillIds).toEqual(['agentic-a']);
    expect(state.branchLocalSkillIds).toEqual([]);
    expect(state.version).toBe(5);
    expect(state.legacyMigrated).toBe(false);
  });

  it('test_variant_streaming_status', () => {
    const streaming = variant('var_streaming', 'streaming');
    expect(canActivateVariant(streaming)).toBe(true);
    expect(canRetryVariant(streaming)).toBe(false);
  });

  it('test_variant_cancelled_status', () => {
    const cancelled = variant('var_cancelled', 'cancelled');
    expect(canActivateVariant(cancelled)).toBe(true);
    expect(canRetryVariant(cancelled)).toBe(true);
  });

  it('test_variant_pending_status', () => {
    const pending = variant('var_pending', 'pending');
    expect(canActivateVariant(pending)).toBe(true);
    expect(canRetryVariant(pending)).toBe(false);
  });

  it('test_resolve_retry_options_prefers_frontend_and_keeps_tool_settings', () => {
    const merged = resolveRetryOptions(null, 'cfg-1', {
      temperature: 0.55, maxTokens: 1234, enableThinking: false,
      mcpToolSchemas: [{
        name: 'builtin-web_search', description: 'web search',
        inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
      }],
      schemaToolIds: ['builtin-web_search'], systemPromptOverride: 'override',
    });
    expect(merged.modelId).toBe('cfg-1');
    expect(merged.model2OverrideId).toBe('cfg-1');
    expect(merged.temperature).toBe(0.55);
    expect(merged.maxTokens).toBe(1234);
    expect(merged.enableThinking).toBe(false);
    expect(merged.schemaToolIds).toEqual(['builtin-web_search']);
    expect(merged.systemPromptOverride).toBe('override');
    expect(merged.mcpToolSchemas).toHaveLength(1);
  });

  it('test_resolve_retry_options_fallback_to_saved_params', () => {
    const merged = resolveRetryOptions({
      temperature: 0.2, maxTokens: 2048, enableThinking: true,
    }, 'cfg-2', null);
    expect(merged.modelId).toBe('cfg-2');
    expect(merged.model2OverrideId).toBe('cfg-2');
    expect(merged.temperature).toBe(0.2);
    expect(merged.maxTokens).toBe(2048);
    expect(merged.enableThinking).toBe(true);
    expect(merged.mcpToolSchemas ?? null).toBeNull();
    expect(merged.schemaToolIds ?? null).toBeNull();
  });

  it('switch_variant validates ownership, existence and error status before persisting', async () => {
    seedMessage();
    await expect(host.invoke('chat_v2_switch_variant', {
      sessionId: 'sess_variants', messageId: 'msg_variants', variantId: 'var_missing',
    })).rejects.toBe(commandError('VariantNotFound', 'var_missing'));
    await expect(host.invoke('chat_v2_switch_variant', {
      sessionId: 'sess_variants', messageId: 'msg_variants', variantId: 'var_b',
    })).rejects.toBe(commandError('VariantCannotActivateFailed', 'var_b'));
    await expect(host.invoke('chat_v2_switch_variant', {
      sessionId: 'sess_other', messageId: 'msg_variants', variantId: 'var_c',
    })).rejects.toBe(commandError('Validation',
      'Permission denied: cannot switch variant for message in another session'));
    await expect(host.invoke('chat_v2_switch_variant', {
      sessionId: 'sess_variants', messageId: 'msg_variants', variantId: 'var_c',
    })).resolves.toBeNull();
    expect(getMessage(f.db, 'msg_variants')!.activeVariantId).toBe('var_c');
  });

  it('delete_variant deletes blocks, reprioritizes the active variant and emits the event', async () => {
    seedMessage();
    const result = await host.invoke<Record<string, unknown>>('chat_v2_delete_variant', {
      sessionId: 'sess_variants', messageId: 'msg_variants', variantId: 'var_a',
    });
    expect(result).toEqual({
      deletedVariantId: 'var_a', remainingCount: 2, newActiveVariantId: 'var_c',
    });
    expect(getBlock(f.db, 'blk_va')).toBeNull();
    const message = getMessage(f.db, 'msg_variants')!;
    expect(message.blockIds).toEqual(['blk_vb', 'blk_vc']);
    expect(message.activeVariantId).toBe('var_c');
    expect(host.eventsNamed('chat_v2_session_sess_variants')).toEqual([{
      eventType: 'variant_deleted', messageId: 'msg_variants', variantId: 'var_a',
      remainingCount: 2, newActiveVariantId: 'var_c',
    }]);

    await expect(host.invoke('chat_v2_delete_variant', {
      sessionId: 'sess_variants', messageId: 'msg_variants', variantId: 'var_missing',
    })).rejects.toBe(commandError('VariantNotFound', 'var_missing'));
  });

  it('delete_variant refuses the last variant and streaming variants', async () => {
    createMessage(f.db, {
      id: 'msg_single', sessionId: 'sess_variants', role: 'assistant', timestamp: 2,
      blockIds: [], variants: [variant('var_only', 'success')],
    });
    await expect(host.invoke('chat_v2_delete_variant', {
      sessionId: 'sess_variants', messageId: 'msg_single', variantId: 'var_only',
    })).rejects.toBe(commandError('VariantCannotDeleteLast'));

    createMessage(f.db, {
      id: 'msg_streaming', sessionId: 'sess_variants', role: 'assistant', timestamp: 3,
      blockIds: [], variants: [variant('var_s1', 'streaming'), variant('var_s2', 'success')],
    });
    await expect(host.invoke('chat_v2_delete_variant', {
      sessionId: 'sess_variants', messageId: 'msg_streaming', variantId: 'var_s1',
    })).rejects.toBe(commandError('Other',
      'Cannot delete a streaming variant. Please wait for completion or cancel it first.'));
  });

  it('cancel_variant validates ownership and aborts the scoped token', async () => {
    seedMessage();
    await expect(host.invoke('chat_v2_cancel_variant', {
      sessionId: 'sess_variants', variantId: 'var_missing',
    })).rejects.toBe(commandError('Validation',
      'Variant var_missing does not belong to session sess_variants'));
    const state = host.ctx.get('chatState') as ChatV2State;
    const token = state.registerStream('sess_variants:var_c');
    await expect(host.invoke('chat_v2_cancel_variant', {
      sessionId: 'sess_variants', variantId: 'var_c',
    })).resolves.toBeNull();
    expect(token.signal.aborted).toBe(true);
  });

  it('switch_variant syncs the session skill state from the target snapshot', async () => {
    createMessage(f.db, {
      id: 'msg_skill', sessionId: 'sess_variants', role: 'assistant', timestamp: 4,
      blockIds: [], activeVariantId: 'var_old',
      variants: [
        variant('var_old', 'success'),
        {
          ...variant('var_new', 'cancelled'),
          meta: { skillSnapshotAfter: { manualPinnedSkillIds: ['manual-b'], version: 7 } },
        },
      ],
    });
    await host.invoke('chat_v2_switch_variant', {
      sessionId: 'sess_variants', messageId: 'msg_skill', variantId: 'var_new',
    });
    const state = f.db.get<{ skill_state_json: string | null; active_skill_ids_json: string | null }>(
      'SELECT skill_state_json, active_skill_ids_json FROM chat_v2_session_state WHERE session_id = ?1',
      ['sess_variants'])!;
    expect(JSON.parse(state.skill_state_json!)).toMatchObject({
      manualPinnedSkillIds: ['manual-b'], version: 8,
      legacyMigrated: false,
    });
    expect(JSON.parse(state.skill_state_json!)).not.toHaveProperty('branchLocalSkillIds');
    expect(JSON.parse(state.active_skill_ids_json!)).toEqual(['manual-b']);
    expect(getSession(f.db, 'sess_variants')).not.toBeNull();
  });
});
