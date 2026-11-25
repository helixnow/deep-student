import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createPipelineHost } from './chat-host.ts';
import { persistenceStorePort } from './persistence-store-port.ts';
import type { PipelineFinalStore, PipelinePostCommitEffects, PersistenceBlock } from '../api.ts';
import { makeEmptyMessage } from '../src/microcompact.ts';

let host: Awaited<ReturnType<typeof createPipelineHost>>;
const base = persistenceStorePort();
const store: PipelineFinalStore = {
  ...base,
  getMessageWithConn: vi.fn<PipelineFinalStore['getMessageWithConn']>((_conn, id) => host.ctx.chatSession.getMessage(id)),
  updateMessageWithConn: vi.fn<PipelineFinalStore['updateMessageWithConn']>((conn, message) => {
    conn.run('UPDATE chat_v2_messages SET block_ids_json = ?, meta_json = ? WHERE id = ?',
      [JSON.stringify(message.blockIds), JSON.stringify(message._meta), message.id]);
  }),
};
const effects: PipelinePostCommitEffects = {
  incrementResourceRefs: vi.fn(async () => {}), triggerAutoMemoryExtraction: vi.fn(), onTurnCommitted: vi.fn(),
};
beforeAll(async () => { host = await createPipelineHost({ provide: { finalStore: store, finalEffects: effects } }); }, 60_000);
afterAll(async () => { await host?.dispose(); });
let sequence = 0;
function setup() {
  const sessionId = `final_${++sequence}`;
  host.ctx.chatSession.createSession({ id: sessionId, mode: 'chat', titleLocked: false, persistStatus: 'active',
    createdAt: '2026-11-04T00:00:00Z', updatedAt: '2026-11-04T00:00:00Z' });
  const ctx = host.ctx.chatPipeline.createPipelineContext({ sessionId, content: 'question' });
  const save = host.ctx.chatPipeline.createFinalPersistence(host.ctx.get('finalStore') as PipelineFinalStore,
    host.ctx.get('finalEffects') as PipelinePostCommitEffects);
  vi.mocked(effects.incrementResourceRefs).mockClear(); vi.mocked(effects.triggerAutoMemoryExtraction).mockClear();
  vi.mocked(effects.onTurnCommitted).mockClear();
  return { ctx, save, db: host.ctx.chatSession.database.getConnSafe() };
}
function block(messageId: string, id: string, type: string, content: string, blockIndex = 0): PersistenceBlock {
  return { messageId, id, type, status: 'success', content, blockIndex };
}

describe('persistence.rs:860–1549 final save production orchestration', () => {
  it('saves normal answer metadata and replay before owner effects, preserving duplicate reference increments', async () => {
    const { ctx, save, db } = setup();
    ctx.finalContent = 'answer'; ctx.finalReasoning = 'reason'; ctx.modelDisplayName = 'display model';
    ctx.streamingContentBlockId = `${ctx.sessionId}_content`; ctx.streamingThinkingBlockId = `${ctx.sessionId}_thinking`;
    ctx.options.modelId = 'config'; ctx.options.temperature = 0.5;
    ctx.options.userMessageOrigin = { kind: 'inbox' };
    ctx.tokenUsage = { promptTokens: 2, completionTokens: 3, totalTokens: 5, source: 'api' };
    ctx.contextSnapshot.userRefs = [{ resourceId: 'res_same', hash: 'h', typeId: 'note' }];
    ctx.contextSnapshot.retrievalRefs = [{ resourceId: 'res_same', hash: 'h', typeId: 'retrieval' }];
    ctx.compiledCurrentUserMessage = makeEmptyMessage('user', '<user_query>question</user_query>');
    const order: string[] = [];
    vi.mocked(effects.incrementResourceRefs).mockImplementationOnce(async ids => {
      expect(ids).toEqual(['res_same', 'res_same']);
      expect(host.ctx.chatSession.getMessage(ctx.assistantMessageId)).not.toBeNull();
      expect(db.pluck('SELECT llm_content FROM chat_v2_blocks WHERE message_id = ?', [ctx.userMessageId])).toBe(ctx.liveUserLlmContent());
      order.push('refs');
    });
    vi.mocked(effects.triggerAutoMemoryExtraction).mockImplementationOnce(() => { order.push('memory'); });
    vi.mocked(effects.onTurnCommitted).mockImplementationOnce(() => { order.push('skills'); });
    await save.saveResults(ctx);
    const assistant = host.ctx.chatSession.getMessage(ctx.assistantMessageId)!;
    expect(assistant.blockIds).toEqual([ctx.streamingThinkingBlockId, ctx.streamingContentBlockId]);
    expect(assistant._meta).toMatchObject({ modelId: 'display model', usage: ctx.tokenUsage,
      chatParams: { modelId: 'config', temperature: 0.5, contextLimit: null, maxTokens: null,
        enableThinking: null, reasoningEffort: null, thinkingBudget: null, disableTools: null, model2OverrideId: null } });
    expect(assistant._meta?.inboundOrigin).toBeUndefined();
    expect(host.ctx.chatSession.getMessage(ctx.userMessageId)!._meta?.inboundOrigin).toEqual({ kind: 'inbox' });
    expect(order).toEqual(['refs', 'memory', 'skills']);
  });

  it('interleaved blocks retain order while external Anki positions and frontend IDs survive', async () => {
    const { ctx, save, db } = setup();
    const first = block(ctx.assistantMessageId, `${ctx.sessionId}_first`, 'thinking', 'think');
    const last = block(ctx.assistantMessageId, `${ctx.sessionId}_last`, 'content', 'answer', 1);
    const anki = block(ctx.assistantMessageId, `${ctx.sessionId}_anki`, 'anki_cards', 'outside', 1);
    const frontend = `${ctx.sessionId}_frontend`;
    store.createMessageWithConn(db, { id: ctx.assistantMessageId, sessionId: ctx.sessionId, role: 'assistant',
      timestamp: 0, blockIds: [first.id, anki.id, frontend] });
    store.createBlockWithConn(db, anki);
    ctx.addInterleavedBlock(first); ctx.addInterleavedBlock(last);
    ctx.generatedBlocks = [block(ctx.assistantMessageId, 'unused_generated', 'content', 'ignored')];
    ctx.finalContent = 'answer';
    await save.saveResults(ctx);
    expect(host.ctx.chatSession.getMessage(ctx.assistantMessageId)!.blockIds).toEqual([first.id, anki.id, last.id, frontend]);
    expect(host.ctx.chatSession.getBlock(anki.id)!.content).toBe('outside');
    expect(db.all<{ id: string; block_index: number }>('SELECT id, block_index FROM chat_v2_blocks WHERE message_id = ? ORDER BY block_index',
      [ctx.assistantMessageId])).toEqual([{ id: first.id, block_index: 0 }, { id: anki.id, block_index: 1 }, { id: last.id, block_index: 2 }]);
  });

  it('generated and manual paths keep Rust retrieval ordering and the distinct final tool mapping', async () => {
    const { ctx, save, db } = setup();
    ctx.generatedBlocks = [block(ctx.assistantMessageId, 'generated_content', 'content', 'c'), block(ctx.assistantMessageId, 'generated_thinking', 'thinking', 't')];
    ctx.retrievedSources.rag = [{ title: 'source' }]; ctx.streamingRetrievalBlockIds.set('rag', 'retrieved_rag');
    ctx.toolResults = [{ toolName: 'mcp_graph_search', toolCallId: 'call_graph', blockId: 'graph_tool', input: {}, output: { source: 1 }, success: false, error: 'error' }];
    await save.saveResults(ctx);
    expect(host.ctx.chatSession.getMessage(ctx.assistantMessageId)!.blockIds).toEqual(['generated_thinking', 'retrieved_rag', 'generated_content', 'graph_tool']);
    expect(host.ctx.chatSession.getBlock('graph_tool')).toMatchObject({ type: 'graph', status: 'error', error: 'error' });
    expect(db.pluck('SELECT tool_call_id FROM chat_v2_blocks WHERE id = ?', ['graph_tool'])).toBe('call_graph');
  });

  it('retry updates existing assistant and write/COMMIT failure never runs post-commit effects', async () => {
    const { ctx, save, db } = setup();
    ctx.finalContent = 'original'; await save.saveResults(ctx);
    ctx.options.skipUserMessageSave = true; ctx.options.skipAssistantMessageSave = true;
    ctx.finalContent = 'replacement';
    const updates = vi.mocked(store.updateMessageWithConn); updates.mockClear();
    vi.mocked(effects.triggerAutoMemoryExtraction).mockClear();
    updates.mockImplementationOnce(() => { throw new Error('owner write failed'); });
    await expect(save.saveResults(ctx)).rejects.toThrow('owner write failed');
    expect(effects.triggerAutoMemoryExtraction).not.toHaveBeenCalled();
    db.exec(`CREATE TABLE final_parent (id INTEGER PRIMARY KEY);
      CREATE TABLE final_deferred (parent_id INTEGER REFERENCES final_parent(id) DEFERRABLE INITIALLY DEFERRED);
      CREATE TRIGGER final_commit_reject AFTER UPDATE ON chat_v2_messages
      WHEN NEW.id = '${ctx.assistantMessageId}' BEGIN INSERT INTO final_deferred VALUES (999); END;`);
    await expect(save.saveResults(ctx)).rejects.toThrow('Failed to commit transaction');
    expect(effects.triggerAutoMemoryExtraction).not.toHaveBeenCalled();
    db.exec('DROP TRIGGER final_commit_reject');
    await save.saveResults(ctx);
    expect(updates).toHaveBeenCalledTimes(3);
    expect(effects.triggerAutoMemoryExtraction).toHaveBeenCalledTimes(1);
    expect(host.ctx.chatSession.getMessage(ctx.assistantMessageId)!._meta?.usage).toEqual(ctx.tokenUsage);
  });

  it('skips auto-memory extraction when skipAutoMemoryExtraction is set or cancellation token is aborted', async () => {
    const first = setup();
    first.ctx.finalContent = 'partial';
    await first.save.saveResults(first.ctx, { skipAutoMemoryExtraction: true });
    expect(effects.triggerAutoMemoryExtraction).not.toHaveBeenCalled();
    expect(effects.onTurnCommitted).toHaveBeenCalledTimes(1);

    const second = setup();
    const cancel = new AbortController();
    cancel.abort();
    second.ctx.setCancellationToken(cancel.signal);
    second.ctx.finalContent = 'cancelled partial';
    await second.save.saveResults(second.ctx);
    expect(effects.triggerAutoMemoryExtraction).not.toHaveBeenCalled();
    expect(effects.onTurnCommitted).toHaveBeenCalledTimes(1);
  });

  it('S4-02 persists stoppedByUser on aborted turns and flushes partial buffers silently without extra events', async () => {
    const { ctx, save } = setup();
    const emitted: string[] = [];
    const { ChatV2StreamingAdapter } = await import('../src/llm-adapter.ts');
    const adapter = new ChatV2StreamingAdapter(
      {
        emitStart: (type) => emitted.push(`${type}:start`),
        emitChunk: (type) => emitted.push(`${type}:chunk`),
        emitEnd: (type) => emitted.push(`${type}:end`),
        emitError: (type) => emitted.push(`${type}:error`),
        emitToolCallPreparingStart: () => emitted.push('preparing:start'),
      },
      ctx.assistantMessageId,
      { enableThinking: true },
    );
    adapter.onReasoningChunk('逐步推理内容');
    adapter.onContentChunk('部分正文回答<t');
    emitted.length = 0;

    adapter.flushBuffersSilently();
    expect(emitted).toEqual([]);
    expect(adapter.getAccumulatedReasoning()).toBe('逐步推理内容');
    expect(adapter.getAccumulatedContent()).toBe('部分正文回答<t');

    ctx.aborted = true;
    ctx.finalReasoning = adapter.getAccumulatedReasoning();
    ctx.finalContent = adapter.getAccumulatedContent();
    ctx.streamingThinkingBlockId = adapter.getThinkingBlockId();
    ctx.streamingContentBlockId = adapter.getContentBlockId();
    ctx.collectStreamedTextSegments(adapter.getTextSegments(), ctx.assistantMessageId);

    await save.saveResults(ctx, { skipAutoMemoryExtraction: true });
    const restoredMsg = host.ctx.chatSession.getMessage(ctx.assistantMessageId)!;
    const restoredBlocks = host.ctx.chatSession.getMessageBlocks(ctx.assistantMessageId);
    expect((restoredMsg._meta as { stoppedByUser?: boolean } | undefined)?.stoppedByUser).toBe(true);
    expect(restoredBlocks.map((b) => ({ type: b.type, content: b.content }))).toEqual([
      { type: 'thinking', content: '逐步推理内容' },
      { type: 'content', content: '部分正文回答<t' },
    ]);
  });

  it('S4-02 updates only targetVariantId while preserving sibling version blocks on regenerate', async () => {
    const { ctx, save, db } = setup();
    const v1Block = block(ctx.assistantMessageId, `${ctx.sessionId}_v1_blk`, 'content', 'v1 original');
    host.ctx.chatSession.createMessage({
      id: ctx.assistantMessageId,
      sessionId: ctx.sessionId,
      role: 'assistant',
      timestamp: 12345,
      blockIds: [],
      activeVariantId: 'var_v2',
      variants: [
        { id: 'var_v1', modelId: 'm1', blockIds: [v1Block.id], status: 'success', createdAt: 1000, meta: { versioned: true } as never },
        { id: 'var_v2', modelId: 'm1', blockIds: [], status: 'streaming', createdAt: 2000, meta: { versioned: true } as never },
      ],
    });
    store.createBlockWithConn(db, v1Block);
    ctx.options.skipUserMessageSave = true;
    ctx.options.skipAssistantMessageSave = true;
    ctx.options.targetVariantId = 'var_v2';
    ctx.finalContent = 'v2 regenerated';
    ctx.streamingContentBlockId = `${ctx.sessionId}_v2_blk`;
    vi.mocked(store.updateMessageWithConn).mockClear();

    await save.saveResults(ctx);

    const updatedCall = vi.mocked(store.updateMessageWithConn).mock.calls[0]?.[1];
    expect(updatedCall).toBeDefined();
    expect(updatedCall!.timestamp).toBe(12345);
    expect(updatedCall!.activeVariantId).toBe('var_v2');
    expect(updatedCall!.variants).toHaveLength(2);
    expect(updatedCall!.variants![0]).toMatchObject({ id: 'var_v1', blockIds: [v1Block.id], status: 'success' });
    expect(updatedCall!.variants![1]).toMatchObject({
      id: 'var_v2',
      blockIds: [`${ctx.sessionId}_v2_blk`],
      status: 'success',
      meta: { versioned: true },
    });
  });

  it('S4-02 synthesizes var_v1 and preserves variants even when existingMessage lacked variants array', async () => {
    const { ctx, save, db } = setup();
    const v1Block = block(ctx.assistantMessageId, `${ctx.sessionId}_legacy_v1_blk`, 'content', 'v1 before retry');
    host.ctx.chatSession.createMessage({
      id: ctx.assistantMessageId,
      sessionId: ctx.sessionId,
      role: 'assistant',
      timestamp: 54321,
      blockIds: [v1Block.id],
      _meta: { modelId: 'Model-V1' },
    });
    store.createBlockWithConn(db, v1Block);

    ctx.options.skipUserMessageSave = true;
    ctx.options.skipAssistantMessageSave = true;
    ctx.options.targetVariantId = 'var_v2_recovered';
    ctx.modelDisplayName = 'Model-V2';
    ctx.finalContent = 'v2 recovered answer';
    ctx.streamingContentBlockId = `${ctx.sessionId}_recovered_v2_blk`;
    vi.mocked(store.updateMessageWithConn).mockClear();

    await save.saveResults(ctx);

    const updatedCall = vi.mocked(store.updateMessageWithConn).mock.calls[0]?.[1];
    expect(updatedCall).toBeDefined();
    expect(updatedCall!.timestamp).toBe(54321);
    expect(updatedCall!.blockIds).toEqual([`${ctx.sessionId}_recovered_v2_blk`]);
    expect(updatedCall!.activeVariantId).toBe('var_v2_recovered');
    expect(updatedCall!.variants).toHaveLength(2);
    expect(updatedCall!.variants![0]).toMatchObject({
      id: `var_v1_${ctx.assistantMessageId}`,
      modelId: 'Model-V1',
      blockIds: [v1Block.id],
      status: 'success',
      meta: { versioned: true },
    });
    expect(updatedCall!.variants![1]).toMatchObject({
      id: 'var_v2_recovered',
      modelId: 'Model-V2',
      blockIds: [`${ctx.sessionId}_recovered_v2_blk`],
      status: 'success',
      meta: { versioned: true },
    });
  });
});
