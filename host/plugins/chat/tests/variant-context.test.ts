import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setTimeout as delay } from 'node:timers/promises';
import { createTestHost } from '../../../kernel/testing.ts';
import plugin from '../index.ts';
import { vfsStub } from './database-fixture.ts';
import { ChatV2Emitter, BackendEventsSink, generateVariantId } from '../api.ts';

describe('variant_context.rs via chatSession factories', () => {
  let host: Awaited<ReturnType<typeof createTestHost>>;
  beforeAll(async () => { host = await createTestHost({ plugins: [plugin], provide: { storage: {}, vfs: vfsStub } }); });
  afterAll(async () => { await host.dispose(); });
  function context(parent = new AbortController(), id = 'var_ctx') {
    return host.ctx.chatSession.createVariantExecutionContext(id, 'model', 'msg_ctx', {}, ChatV2Emitter.newHeadless('sess_ctx'), parent.signal);
  }
  it('test_variant_id_generation', () => { expect(generateVariantId().startsWith('var_')).toBe(true); });
  it('test_cancel_token_cascade', () => {
    const parent = new AbortController(); const child = context(parent);
    expect(parent.signal.aborted).toBe(false); expect(child.isCancelled()).toBe(false);
    parent.abort(); expect(parent.signal.aborted).toBe(true); expect(child.isCancelled()).toBe(true);
  });
  it('test_child_cancel_not_affect_parent', () => {
    const parent = new AbortController(); const child = context(parent); child.cancel();
    expect(parent.signal.aborted).toBe(false); expect(child.isCancelled()).toBe(true);
  });
  it('test_parallel_manager_basic', () => {
    const manager = host.ctx.chatSession.createParallelExecutionManager();
    expect(manager.variantCount()).toBe(0); expect(manager.allCompleted()).toBe(true); expect(manager.hasStreaming()).toBe(false);
  });
  it('test_parallel_manager_cancel_all', () => {
    const manager = host.ctx.chatSession.createParallelExecutionManager(); manager.cancelAll(); expect(manager.globalCancelToken().aborted).toBe(true);
  });
  it('test_get_first_success_empty', () => { expect(host.ctx.chatSession.createParallelExecutionManager().getFirstSuccess()).toBeNull(); });
  it('test_shared_context', () => {
    const s = host.ctx.chatSession;
    expect(s.sharedContextHasSources(s.newSharedContext())).toBe(false);
    expect(s.sharedContextHasSources({ ragSources: [] })).toBe(false);
    expect(s.sharedContextHasSources({ ragSources: [{ title: 'Test' }] })).toBe(true);
  });
  it('test_block_auto_attribution', () => {
    const ctx = context(); const id = ctx.createBlock('content');
    expect(ctx.blockIds()).toHaveLength(1); expect(ctx.blockIds()).toContain(id); expect(id.startsWith('blk_')).toBe(true);
  });
  it('test_block_id_no_duplicate', () => {
    const ctx = context(); ctx.setContentBlockId('blk_test_123'); expect(ctx.blockIds()).toHaveLength(1);
    ctx.setContentBlockId('blk_test_123'); ctx.setThinkingBlockId('blk_test_123'); expect(ctx.blockIds()).toHaveLength(1);
  });
  it('test_created_at_consistency', async () => {
    const ctx = context(); const created = ctx.createdAt(); await delay(10);
    expect(context().createdAt()).toBeGreaterThan(created); expect(ctx.toVariant().createdAt).toBe(created);
  });
  it('test_token_usage_default', () => {
    const usage = context().getUsage();
    expect(usage).toMatchObject({ promptTokens: 0, completionTokens: 0, totalTokens: 0, source: 'tiktoken' });
    expect(usage.reasoningTokens).toBeUndefined(); expect(usage.cachedTokens).toBeUndefined();
  });
  it('test_token_usage_from_api', () => {
    expect(host.ctx.chatSession.tokenUsageFromApi(100, 50, 10)).toMatchObject({ promptTokens: 100, completionTokens: 50, totalTokens: 150, source: 'api', reasoningTokens: 10 });
  });
  it('test_token_usage_mutex', () => {
    const ctx = context(); expect(ctx.getUsage().totalTokens).toBe(0);
    ctx.setUsage(host.ctx.chatSession.tokenUsageFromApi(200, 100, null));
    expect(ctx.getUsage()).toMatchObject({ promptTokens: 200, completionTokens: 100, totalTokens: 300, source: 'api' });
    const copy = ctx.getUsage(); copy.totalTokens = 0; expect(ctx.getUsage().totalTokens).toBe(300);
  });
  it('test_variant_with_usage', () => {
    const s = host.ctx.chatSession; expect(s.newVariant('gpt-4').usage).toBeUndefined();
    const variant = s.variantWithUsage(s.newVariant('gpt-4'), s.tokenUsageFromApi(100, 50, null));
    expect(variant.usage).toBeDefined(); expect(variant.usage).toMatchObject({ promptTokens: 100, completionTokens: 50 });
  });
  it('test_variant_set_usage', () => {
    const s = host.ctx.chatSession; const variant = s.newVariant('claude'); expect(variant.usage).toBeUndefined();
    s.setVariantUsage(variant, s.tokenUsageFromApi(300, 150, 20));
    expect(variant.usage).toBeDefined(); expect(s.getVariantUsage(variant)).toMatchObject({ promptTokens: 300, reasoningTokens: 20 });
  });
  it('manager cancellation emits one terminal event per active variant and keeps successful variants intact', () => {
    const manager = host.ctx.chatSession.createParallelExecutionManager();
    const emitter = ChatV2Emitter.withSinkAndBatching(new BackendEventsSink(host.ctx.backendEvents), 'sess_manager', false);
    const a = manager.createVariant('var_a', 'a', 'msg', {}, emitter);
    const b = manager.createVariant('var_b', 'b', 'msg', {}, emitter);
    a.startStreaming(); b.startStreaming(); a.setUsage(host.ctx.chatSession.tokenUsageFromApi(1, 2, null)); a.complete();
    manager.cancelAll(); manager.cancelAll(); a.cancel();
    expect(a.status()).toBe('success'); expect(b.status()).toBe('cancelled'); expect(a.isCancelled()).toBe(true);
    expect(manager.getFirstSuccess()).toBe('var_a'); expect(manager.allCompleted()).toBe(true);
    expect(manager.successCount()).toBe(1); expect(manager.errorCount()).toBe(0);
    const events = host.eventsNamed('chat_v2_event_sess_manager') as Array<{ type: string; phase: string; variantId?: string }>;
    expect(events.filter(event => event.type === 'variant_end')).toHaveLength(2);
    expect(manager.cancelVariant('missing')).toBe(false);
    expect(manager.removeVariant('var_b')).toBe(b); manager.clear(); expect(manager.variantCount()).toBe(0);
  });
  it('round reset clears only transient text and block pointers, preserving interleaved payloads and tool history', () => {
    const ctx = context(); const id = ctx.createBlock('thinking'); ctx.setThinkingBlockId(id);
    ctx.appendReasoning(''); expect(ctx.getAccumulatedReasoning()).toBe(''); expect(ctx.getThinkingFirstChunkAt()).toBeNull();
    ctx.appendReasoning('reason'); ctx.appendContent('content');
    ctx.addInterleavedBlock({ id, messageId: 'msg_ctx', type: 'thinking', status: 'success', content: 'reason', blockIndex: 99 });
    expect(ctx.addInterleavedBlock({ id, messageId: 'msg_ctx', type: 'thinking', status: 'success', content: 'replaced', blockIndex: 22 })).toBe(0);
    expect(ctx.appendInterleavedBlockContent(id, '!')).toBe(true); expect(ctx.appendInterleavedBlockContent('missing', '!')).toBe(false);
    ctx.addToolCall({ id: 'call', name: 'read', arguments: {} }); ctx.addToolResult({ toolName: 'read', input: {}, output: null, success: true });
    ctx.setPendingReasoning('pending'); expect(ctx.incrementToolRound()).toBe(0); expect(ctx.getToolRound()).toBe(1);
    ctx.resetForNewRound(); expect(ctx.getAccumulatedContent()).toBe(''); expect(ctx.getAccumulatedReasoning()).toBeNull();
    expect(ctx.getThinkingBlockId()).toBeNull(); expect(ctx.getContentFirstChunkAt()).toBeNull();
    expect(ctx.getInterleavedBlocks()[0]?.content).toBe('replaced!'); expect(ctx.getPendingReasoning()).toBe('pending');
    expect(ctx.hasToolCalls()).toBe(true); expect(ctx.takeToolCalls()).toHaveLength(1); expect(ctx.hasToolCalls()).toBe(false);
    expect(ctx.getToolResults()).toHaveLength(1); expect(ctx.blockIds()).toEqual([id]);
  });
});

describe('VariantExecutionContext.cancelController (register_existing_token contract)', () => {
  let host: Awaited<ReturnType<typeof createTestHost>>;
  beforeAll(async () => { host = await createTestHost({ plugins: [plugin], provide: { storage: {}, vfs: vfsStub } }); });
  afterAll(async () => { await host.dispose(); });
  it('aborting the registered token cancels only that variant, without emitting variant_end (Rust token.cancel())', () => {
    const events: unknown[] = [];
    const emitter = ChatV2Emitter.withSink({ emitBlockEvent: (_c: string, e: unknown) => { events.push(e); },
      emitSessionEvent: (_c: string, e: unknown) => { events.push(e); }, window: () => null }, 'sess_ctl');
    const manager = host.ctx.chatSession.createParallelExecutionManager();
    const a = manager.createVariant('var_a', 'm', 'msg', {}, emitter);
    const b = manager.createVariant('var_b', 'm', 'msg', {}, emitter);
    a.cancelController().abort();
    expect(a.isCancelled()).toBe(true); expect(a.cancelToken()).toBe(a.cancelController().signal);
    expect(b.isCancelled()).toBe(false); expect(manager.globalCancelToken().aborted).toBe(false);
    expect(a.status()).toBe('pending'); expect(events).toEqual([]);
  });
  it('parent cancellation propagates into the registered token (child_token semantics)', () => {
    const external = new AbortController();
    const manager = host.ctx.chatSession.createParallelExecutionManager(external);
    const ctx = manager.createVariant('var_p', 'm', 'msg', {}, ChatV2Emitter.newHeadless('sess_ctl'));
    expect(ctx.cancelController().signal.aborted).toBe(false);
    external.abort();
    expect(manager.globalCancelToken().aborted).toBe(true);
    expect(ctx.cancelController().signal.aborted).toBe(true); expect(ctx.isCancelled()).toBe(true);
  });
  it('a context created under an already-cancelled parent starts cancelled', () => {
    const parent = new AbortController(); parent.abort();
    const ctx = host.ctx.chatSession.createVariantExecutionContext('var_late', 'm', 'msg', {}, ChatV2Emitter.newHeadless('sess_ctl'), parent.signal);
    expect(ctx.isCancelled()).toBe(true); expect(ctx.cancelController().signal.aborted).toBe(true);
  });
});
