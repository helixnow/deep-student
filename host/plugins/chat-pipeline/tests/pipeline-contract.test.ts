import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPipelineHost } from './chat-host.ts';
import type {
  AttachmentMeta, ChatMessage, ContextRef, ContextSnapshot, MessageBlock, MessageSources, SendMessageRequest,
  SourceInfo, ToolResultInfo,
} from '../../../../contracts/ipc/generated/L04-chat-session.ts';
import type {
  ContentBlock__De, SendContextRef, SendOptions,
} from '../../../../contracts/ipc/generated/_shared.ts';
import { ChatV2StreamingAdapter } from '../src/llm-adapter.ts';
import { PipelineContext } from '../src/pipeline-context.ts';
import { createToolCall } from '../src/tool-order.ts';
import { DEFAULT_CONTEXT_LIMIT, DEFAULT_TOOL_TIMEOUT_MS } from '../src/constants.ts';
import type { SearchInput } from '../src/retrieval.ts';

let host: Awaited<ReturnType<typeof createPipelineHost>>;
let sequence = 0;
beforeAll(async () => {
  host = await createPipelineHost();
  host.ctx.chatSession.createSession({ id: 'sess_test', mode: 'chat', titleLocked: false,
    persistStatus: 'active', createdAt: '2026-09-07T00:00:00Z', updatedAt: '2026-09-07T00:00:00Z' });
}, 60_000);
afterAll(async () => { await host?.dispose(); });

function persistMessage(message: ChatMessage): ChatMessage {
  host.ctx.chatSession.createMessage(message);
  const loaded = host.ctx.chatSession.getMessage(message.id);
  expect(loaded).not.toBeNull();
  return loaded!;
}

function persistMetadata(meta: NonNullable<ChatMessage['_meta']>): NonNullable<ChatMessage['_meta']> {
  return persistMessage({ id: `msg_contract_${++sequence}`, sessionId: 'sess_test',
    role: 'assistant', blockIds: [], timestamp: sequence, _meta: meta })._meta!;
}

function persistSource(source: SourceInfo, kind: 'graph' | 'webSearch'): SourceInfo {
  return persistMetadata({ sources: { [kind]: [source] } }).sources![kind]![0]!;
}

describe('chat_v2/pipeline_tests.rs::tests (types and contracts)', () => {
  it('test_message_role_serialization', () => {
    // MessageRole uses serde rename_all = "snake_case".
    for (const role of ['user', 'assistant'] as const) {
      const message = persistMessage({ id: `msg_role_${role}`, sessionId: 'sess_test', role,
        blockIds: [], timestamp: 0 });
      expect(JSON.stringify(message.role)).toBe(`"${role}"`);
    }
  });

  it('test_send_options_default', () => {
    const options = new PipelineContext({ sessionId: 's', content: '' }).options;
    expect(options.modelId).toBeUndefined();
    expect(options.ragEnabled).toBeUndefined();
    expect(options.enableThinking).toBeUndefined();
  });

  it('test_send_message_request_serialization', () => {
    const request: SendMessageRequest = {
      sessionId: 'sess_123',
      content: 'Hello',
      options: { modelId: 'gpt-4', temperature: 0.7 },
    };
    const json = JSON.stringify(request);
    expect(json).toContain('"sessionId"');
    expect(json).toContain('"modelId"');
  });

  it('test_tool_result_info_serialization', () => {
    const result: ToolResultInfo = {
      toolCallId: 'call_123',
      blockId: 'blk_test_123',
      toolName: 'rag',
      input: { query: 'test' },
      output: { results: [] },
      success: true,
      durationMs: 150,
    };
    const json = JSON.stringify(persistMetadata({ toolResults: [result] }).toolResults![0]);
    expect(json).toContain('"toolName"');
    expect(json).toContain('"durationMs"');
    expect(json).toContain('"toolCallId"');
    // None fields are omitted by serde, not serialized as null.
    expect(json).not.toContain('"error"');
  });

  it('test_tool_result_info_with_duration', () => {
    const result: ToolResultInfo = {
      toolCallId: 'call_abc',
      blockId: 'blk_test_abc',
      toolName: 'web_search',
      input: { query: 'rust async' },
      output: { results: [{ title: 'Async Rust' }] },
      success: true,
      durationMs: 250,
    };
    expect(persistMetadata({ toolResults: [result] }).toolResults![0]!.durationMs).toBe(250);
  });

  it('test_tool_result_info_with_error', () => {
    const result: ToolResultInfo = {
      toolCallId: 'call_err',
      blockId: 'blk_test_err',
      toolName: 'web_search',
      input: { query: 'fail' },
      output: null,
      success: false,
      error: 'network timeout',
    };
    const wire = persistMetadata({ toolResults: [result] }).toolResults![0]!;
    expect(wire.success).toBe(false);
    expect(wire.error).toBe('network timeout');
  });

  it('test_tool_call_creation', () => {
    const toolCall = createToolCall('call_123', 'rag', { query: 'test' });
    expect(toolCall.id).toBe('call_123');
    expect(toolCall.name).toBe('rag');
    expect(toolCall.arguments).toEqual({ query: 'test' });
  });

  it('test_multiple_tool_calls_parallel_execution', () => {
    const toolCalls = [
      createToolCall('call_1', 'rag', { query: 'a' }),
      createToolCall('call_2', 'memory', { query: 'b' }),
      createToolCall('call_3', 'web_search', { query: 'c' }),
    ];
    expect(toolCalls).toHaveLength(3);
    expect(new Set(toolCalls.map(call => call.id)).size).toBe(3);
  });

  it('test_block_id_generation', () => {
    const blockId = ChatV2StreamingAdapter.generateBlockId();
    expect(blockId.startsWith('blk_')).toBe(true);
    expect(blockId).toHaveLength(4 + 36);
  });

  it('test_message_sources_default', () => {
    const sources = new PipelineContext({ sessionId: 's', content: '' }).retrievedSources;
    expect(sources.rag).toBeUndefined();
    expect(sources.memory).toBeUndefined();
    expect(sources.graph).toBeUndefined();
    expect(sources.webSearch).toBeUndefined();
  });

  it('test_message_sources_with_retrievals', () => {
    const ragSources: SourceInfo[] = [
      { title: 'RAG 来源 1', snippet: 'RAG 内容', score: 0.9 },
    ];
    const graphSources: SourceInfo[] = [
      { title: '图谱来源 1', snippet: '图谱内容', score: 0.8 },
    ];
    const webSources: SourceInfo[] = [
      { title: '网络来源 1', url: 'https://example.com', snippet: '网络内容', score: 0.85 },
    ];
    const sources: MessageSources = {
      rag: ragSources,
      graph: graphSources,
      webSearch: webSources,
    };
    expect(sources.rag).toBe(ragSources);
    expect(sources.graph).toBe(graphSources);
    expect(sources.webSearch).toBe(webSources);
    const restored = persistMetadata({ sources }).sources!;
    expect(restored.rag).toEqual(ragSources);
    expect(restored.graph).toEqual(graphSources);
    expect(restored.webSearch).toEqual(webSources);
    expect(restored.memory).toBeUndefined();
    expect(restored.rag).toHaveLength(1);
    expect(restored.graph).toHaveLength(1);
    expect(restored.webSearch).toHaveLength(1);
  });

  it('test_source_info_for_graph_tag', () => {
    const source = persistSource({
      title: '[知识点] 二次函数',
      url: null,
      snippet: '知识点: 二次函数',
      score: 0.8,
      metadata: { sourceType: 'graph_tag', tagId: 'tag_123', tagType: '知识点' },
    }, 'graph');
    expect(source.title).toBe('[知识点] 二次函数');
    expect(source.url).toBeNull();
    expect(source.score).toBe(0.8);
    const metadata = source.metadata as Record<string, unknown>;
    expect(metadata.sourceType).toBe('graph_tag');
    expect(metadata.tagId).toBe('tag_123');
  });

  it('test_source_info_for_graph_card', () => {
    const source = persistSource({
      title: '[错题-待复习] 求解方程...',
      url: null,
      snippet: '【问题】求解方程\n【解析】先化简...',
      score: 0.7,
      metadata: { sourceType: 'graph_card', cardId: 'card_456', status: 'active' },
    }, 'graph');
    expect(source.title).toContain('错题');
    expect(source.score).toBe(0.7);
    expect((source.metadata as Record<string, unknown>).sourceType).toBe('graph_card');
  });

  it('test_source_info_for_web_search', () => {
    const source = persistSource({
      title: '搜索结果标题',
      url: 'https://example.com/article',
      snippet: '这是搜索结果的摘要内容...',
      score: 0.95,
      metadata: { sourceType: 'web_search', chunkIndex: 0, provider: 'google_cse' },
    }, 'webSearch');
    expect(source.url).toBe('https://example.com/article');
    const metadata = source.metadata as Record<string, unknown>;
    expect(metadata.sourceType).toBe('web_search');
    expect(metadata.provider).toBe('google_cse');
  });

  it('test_search_input_construction', () => {
    const input: SearchInput = {
      query: '测试查询',
      topK: 5,
      engine: 'google_cse',
      site: null,
      timeRange: null,
      start: null,
      forceEngine: null,
    };
    expect(input.query).toBe('测试查询');
    expect(input.topK).toBe(5);
    expect(input.engine).toBe('google_cse');
  });

  it('test_retrieval_options_parsing', () => {
    const options = new PipelineContext({ sessionId: 's', content: '', options: {
      ragEnabled: true,
      graphRagEnabled: true,
      memoryEnabled: false,
      webSearchEnabled: true,
      searchEngines: ['bing', 'google_cse'],
      ragTopK: 10,
    } }).options;
    expect(options.ragEnabled).toBe(true);
    expect(options.graphRagEnabled).toBe(true);
    expect(options.memoryEnabled).toBe(false);
    expect(options.webSearchEnabled).toBe(true);
    expect(options.ragTopK).toBe(10);
    expect(options.searchEngines).toEqual(['bing', 'google_cse']);
  });

  it('test_context_limit_application', () => {
    const optionsWithLimit: SendOptions = { contextLimit: 5 };
    const optionsDefault: SendOptions = {};

    expect(optionsWithLimit.contextLimit).toBe(5);
    expect(optionsDefault.contextLimit).toBeUndefined();
    expect(optionsDefault.contextLimit ?? DEFAULT_CONTEXT_LIMIT).toBe(20);
  });

  it('test_tool_timeout_is_30_seconds', () => {
    expect(DEFAULT_TOOL_TIMEOUT_MS).toBe(30_000);
  });

  it('test_message_with_multiple_block_ids', () => {
    const blockIds = ['blk_1', 'blk_2', 'blk_3'];
    const message = persistMessage({
      id: 'msg_test',
      sessionId: 'sess_test',
      role: 'assistant',
      blockIds,
      timestamp: 1,
    });
    expect(message.blockIds).toHaveLength(3);
    expect(message.blockIds).toEqual(blockIds);
  });

  it('test_user_message_block_structure', () => {
    const messageId = 'msg_test_123';
    const blockId = host.ctx.chatPipeline.generateBlockId();
    persistMessage({ id: messageId, sessionId: 'sess_test', role: 'user',
      blockIds: [blockId], timestamp: Date.now() });
    const storedBlock: MessageBlock & { blockIndex: number } = { id: blockId, messageId, type: 'content',
      status: 'success', content: '用户消息内容', startedAt: Date.now(), endedAt: Date.now(), blockIndex: 0 };
    host.ctx.chatSession.createBlock(storedBlock);
    const block = host.ctx.chatSession.getBlock(blockId)!;
    expect(block.id.startsWith('blk_')).toBe(true);
    expect(block.messageId).toBe(messageId);
    expect(block.type).toBe('content');
    expect(block.status).toBe('success');
    expect(block.content).toBe('用户消息内容');
    // L04 returns the serde wire block, which skips block_index. Verify the stored field.
    const stored = host.ctx.chatSession.database.getConnSafe().get<{ block_index: number }>(
      'SELECT block_index FROM chat_v2_blocks WHERE id = ?1', [blockId]);
    expect(stored!.block_index).toBe(0);
    expect(block.startedAt).toBeGreaterThan(1_700_000_000_000);
    expect(block.endedAt).toBeGreaterThan(1_700_000_000_000);
  });

  it('test_assistant_message_meta_with_sources', () => {
    const meta = persistMetadata({ modelId: 'gpt-4', sources: {
      rag: [{ title: '文档1', url: null, snippet: '内容片段', score: 0.9, metadata: null }],
    } });
    expect(meta.sources).toBeDefined();
    expect(meta.sources!.rag).toHaveLength(1);
    expect(meta.modelId).toBe('gpt-4');
  });

  it('test_assistant_message_meta_with_tool_results', () => {
    const meta = persistMetadata({ toolResults: [{ toolCallId: 'call_123', blockId: 'blk_test_123',
      toolName: 'memory', input: { query: 'test' }, output: { results: [] },
      success: true, durationMs: 150 }] });
    expect(meta.toolResults).toBeDefined();
    expect(meta.toolResults).toHaveLength(1);
    expect(meta.toolResults![0]!.success).toBe(true);
    expect(meta.toolResults![0]!.toolName).toBe('memory');
  });

  it('test_block_index_ordering', () => {
    const messageId = 'msg_block_order';
    const blocks: (MessageBlock & { blockIndex: number })[] = Array.from({ length: 3 }, (_, blockIndex) => ({
      id: host.ctx.chatPipeline.generateBlockId(), messageId,
      type: blockIndex === 0 ? 'thinking' : 'content', status: 'success',
      content: `块内容 ${blockIndex}`, blockIndex,
    }));
    persistMessage({ id: messageId, sessionId: 'sess_test', role: 'assistant',
      blockIds: blocks.map(block => block.id), timestamp: 1 });
    for (const block of [...blocks].reverse()) host.ctx.chatSession.createBlock(block);
    const restored = host.ctx.chatSession.getMessageBlocks(messageId);
    expect(restored).toHaveLength(3);
    const stored = host.ctx.chatSession.database.getConnSafe().all<{ id: string; block_index: number }>(
      'SELECT id, block_index FROM chat_v2_blocks WHERE message_id = ?1 ORDER BY block_index', [messageId]);
    stored.forEach((block, index) => { expect(block.block_index).toBe(index); });
    expect(restored.map(block => block.id)).toEqual(stored.map(block => block.id));
    expect(restored.map(block => block.type)).toEqual(['thinking', 'content', 'content']);
  });

  it('test_user_message_with_attachments', () => {
    const attachment: AttachmentMeta = {
      id: 'att_test_1',
      name: 'image.png',
      type: 'image',
      mimeType: 'image/png',
      size: 1024,
      previewUrl: null,
      status: 'ready',
    };
    const message = persistMessage({
      id: 'msg_user',
      sessionId: 'sess_test',
      role: 'user',
      blockIds: ['blk_1'],
      timestamp: 1,
      attachments: [attachment],
    });
    expect(message.attachments).toHaveLength(1);
    expect(message.attachments![0]!.name).toBe('image.png');
  });

  it('test_send_context_ref_serialization', () => {
    const formattedBlocks: ContentBlock__De[] = [{ type: 'text', text: 'Hello' }];
    const sendRef: SendContextRef = {
      resourceId: 'res_123',
      hash: 'abc123',
      typeId: 'note',
      formattedBlocks,
    };
    const execution = host.ctx.chatPipeline.createPipelineContext({ sessionId: 'sess_test',
      content: '', userContextRefs: [sendRef] });
    const json = JSON.stringify(execution.userContextRefs[0]);
    expect(json).toContain('"resourceId"');
    expect(json).toContain('"typeId"');
    expect(json).toContain('"formattedBlocks"');
  });

  it('test_context_snapshot_serialization', () => {
    const ref: ContextRef = { resourceId: 'res_1', hash: 'h1', typeId: 'note' };
    const snapshot: ContextSnapshot = { userRefs: [ref], retrievalRefs: [] };
    const json = JSON.stringify(persistMetadata({ contextSnapshot: snapshot }).contextSnapshot);
    expect(json).toContain('"userRefs"');
    expect(json).toContain('"retrievalRefs"');
    expect(json).toContain('"resourceId"');
  });
});
