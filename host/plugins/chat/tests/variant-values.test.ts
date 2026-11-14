import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import plugin from '../index.ts';
import { databaseFixture, vfsStub } from './database-fixture.ts';
import { newSession } from '../src/types.ts';
import { canActivateVariant, canRetryVariant, generateVariantId, type ChatSessionService, type ChatMessage, type Variant } from '../api.ts';

describe('types.rs variant/message runtime values', () => {
  let f: ReturnType<typeof databaseFixture>;
  let host: Awaited<ReturnType<typeof createTestHost>>;
  let s: ChatSessionService;
  beforeAll(async () => {
    f = databaseFixture(); host = await createTestHost({ plugins: [plugin], provide: { storage: f.storage, vfs: vfsStub } });
    s = host.ctx.chatSession; s.createSession(newSession('sess_values', 'chat'));
  });
  afterAll(async () => { await host.dispose(); f.dispose(); });
  function persist(message: ChatMessage) { s.createMessage(message); return s.getMessage(message.id)!; }
  function savedVariant(variant: Variant) {
    const message = s.newAssistantMessage('sess_values'); message.variants = [variant];
    return persist(message).variants![0]!;
  }
  it('test_variant_serialization_camel_case', () => {
    const variant = s.newVariant('gpt-4', null, 'var_123'); variant.blockIds = ['blk_1', 'blk_2']; variant.status = 'success'; variant.createdAt = 1234567890;
    const json = JSON.stringify(savedVariant(variant));
    for (const key of ['modelId', 'blockIds', 'createdAt']) expect(json).toContain(`"${key}":`);
    expect(json).not.toContain('"error":');
  });
  it('test_variant_id_generation', () => {
    const a = generateVariantId(); const b = generateVariantId(); expect(a.startsWith('var_')).toBe(true); expect(a).not.toBe(b);
  });
  it('test_variant_state_transitions', () => {
    const variant = s.newVariant('gpt-4'); expect(variant.status).toBe('pending'); expect(canActivateVariant(variant)).toBe(true); expect(canRetryVariant(variant)).toBe(false);
    s.setVariantStreaming(variant); expect(variant.status).toBe('streaming'); expect(canActivateVariant(variant)).toBe(true);
    s.setVariantSuccess(variant); expect(variant.status).toBe('success'); expect(canActivateVariant(variant)).toBe(true); expect(canRetryVariant(variant)).toBe(false);
  });
  it('test_variant_error_state', () => {
    const variant = s.newVariant('gpt-4'); s.setVariantError(variant, 'API rate limit exceeded');
    expect(variant.status).toBe('error'); expect(variant.error).toBe('API rate limit exceeded'); expect(canActivateVariant(variant)).toBe(false); expect(canRetryVariant(variant)).toBe(true);
  });
  it('test_variant_cancelled_state', () => {
    const variant = s.newVariant('gpt-4'); s.setVariantCancelled(variant);
    expect(variant.status).toBe('cancelled'); expect(canActivateVariant(variant)).toBe(true); expect(canRetryVariant(variant)).toBe(true);
  });
  it('test_shared_context_serialization', () => {
    const message = s.newAssistantMessage('sess_values');
    message.sharedContext = { ...s.newSharedContext(), ragSources: [{ title: 'Test Doc', snippet: 'Test snippet', score: 0.95 }] };
    const json = JSON.stringify(persist(message).sharedContext); expect(json).toContain('"ragSources":'); expect(json).not.toContain('"memorySources":');
  });
  it('test_shared_context_has_sources', () => {
    expect(s.sharedContextHasSources(s.newSharedContext())).toBe(false);
    expect(s.sharedContextHasSources({ ...s.newSharedContext(), ragSources: [{ title: 'Test' }] })).toBe(true);
  });
  it('test_chat_message_is_multi_variant', () => {
    const message = s.newAssistantMessage('sess_values'); expect(s.isMultiVariant(message)).toBe(false);
    message.variants = [s.newVariant('gpt-4')]; expect(s.isMultiVariant(message)).toBe(false);
    message.variants.push(s.newVariant('claude')); expect(s.isMultiVariant(message)).toBe(true);
  });
  it('test_chat_message_get_active_block_ids_fallback', () => {
    const message = s.newAssistantMessage('sess_values'); message.blockIds = ['blk_1', 'blk_2'];
    expect(s.getActiveBlockIds(message)).toEqual(['blk_1', 'blk_2']);
    const variant = s.newVariant('gpt-4'); variant.blockIds = ['blk_3']; message.variants = [variant];
    expect(s.getActiveBlockIds(message)).toEqual(['blk_1', 'blk_2']);
    message.activeVariantId = variant.id; expect(s.getActiveBlockIds(message)).toEqual(['blk_3']);
    message.activeVariantId = 'non_existent_var_id'; expect(s.getActiveBlockIds(message)).toEqual(['blk_1', 'blk_2']);
  });
  it('test_chat_message_select_best_active_variant', () => {
    const message = s.newAssistantMessage('sess_values'); const a = s.newVariant('gpt-4'); const b = s.newVariant('claude'); const c = s.newVariant('deepseek');
    s.setVariantError(a, 'Error'); s.setVariantCancelled(b); s.setVariantSuccess(c); message.variants = [a, b, c];
    s.selectBestActiveVariant(message); expect(message.activeVariantId).toBe(c.id);
  });
  it('test_chat_message_select_best_active_variant_fallback', () => {
    const message = s.newAssistantMessage('sess_values'); const a = s.newVariant('gpt-4'); const b = s.newVariant('claude');
    s.setVariantError(a, 'Error'); s.setVariantCancelled(b); message.variants = [a, b];
    s.selectBestActiveVariant(message); expect(message.activeVariantId).toBe(b.id);
  });
  it('test_chat_message_select_best_active_variant_all_error', () => {
    const message = s.newAssistantMessage('sess_values'); const a = s.newVariant('gpt-4'); const b = s.newVariant('claude');
    s.setVariantError(a, 'Error 1'); s.setVariantError(b, 'Error 2'); message.variants = [a, b];
    s.selectBestActiveVariant(message); expect(message.activeVariantId).toBe(a.id);
  });
  it('test_chat_message_add_and_remove_variant', () => {
    const message = s.newAssistantMessage('sess_values'); const a = s.newVariant('gpt-4');
    s.addVariant(message, a); expect(s.variantCount(message)).toBe(1);
    s.addVariant(message, s.newVariant('claude')); expect(s.variantCount(message)).toBe(2);
    expect(s.removeVariant(message, a.id)).toBe(true); expect(s.variantCount(message)).toBe(1);
    expect(s.removeVariant(message, 'non_existent')).toBe(false);
  });
  it('test_chat_message_with_variants_serialization', () => {
    const message = s.newAssistantMessage('sess_values'); const variant = s.newVariant('gpt-4'); variant.blockIds = ['blk_1']; s.setVariantSuccess(variant);
    message.variants = [variant]; message.activeVariantId = variant.id; message.sharedContext = { ragSources: [] };
    const json = JSON.stringify(persist(message));
    expect(json).toContain('"activeVariantId":'); expect(json).toContain('"variants":'); expect(json).toContain('"sharedContext":');
  });
  it('test_variant_with_usage_builder', () => {
    const variant = s.variantWithUsage(s.newVariant('gpt-4'), s.tokenUsageFromApi(1000, 500, null));
    expect(variant.usage).toBeDefined(); expect(variant.usage).toMatchObject({ promptTokens: 1000, completionTokens: 500, source: 'api' });
  });
  it('test_variant_set_usage', () => {
    const variant = s.newVariant('gpt-4'); expect(variant.usage).toBeUndefined();
    s.setVariantUsage(variant, s.tokenUsageFromApi(1000, 500, null)); expect(variant.usage).toBeDefined(); expect(s.getVariantUsage(variant)?.promptTokens).toBe(1000);
  });
  it('test_variant_serialization_with_usage', () => {
    const variant = s.variantWithUsage(s.newVariant('gpt-4'), s.tokenUsageFromApi(1000, 500, 100));
    const json = JSON.stringify(savedVariant(variant)); expect(json).toContain('"usage":'); expect(json).toContain('"promptTokens":1000'); expect(json).toContain('"source":"api"');
  });
  it('test_variant_serialization_without_usage', () => { expect(JSON.stringify(savedVariant(s.newVariant('gpt-4')))).not.toContain('"usage":'); });
  it('test_message_variant_helpers', () => {
    const message = s.newAssistantMessage('sess_values'); expect(s.isMultiVariant(message)).toBe(false); expect(s.getActiveBlockIds(message)).toEqual([]);
    const a = s.newVariant('gpt-4'); message.variants = [a]; message.activeVariantId = a.id; expect(s.isMultiVariant(message)).toBe(false);
    a.blockIds = ['blk_1', 'blk_2']; message.variants.push(s.newVariant('claude-3'));
    expect(s.isMultiVariant(message)).toBe(true); expect(s.getActiveBlockIds(message)).toEqual(['blk_1', 'blk_2']);
  });
});
