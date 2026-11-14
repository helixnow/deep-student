import { describe, expect, it } from 'vitest';
import {
  ChatV2StreamingAdapter, EVENT_TYPE_TOOL_CALL_PREPARING, type StreamEventSink,
} from '../src/llm-adapter.ts';
import type { LegacyChatMessage } from '../src/microcompact.ts';

interface RecordedEvent {
  type: string;
  phase: 'start' | 'chunk' | 'end' | 'error';
  messageId: string;
  blockId: string | null;
  chunk: string | null;
  payload: unknown;
  result: unknown;
}

class RecordingSink implements StreamEventSink {
  readonly events: RecordedEvent[] = [];

  emitStart(type: string, messageId: string, blockId: string | null,
    payload: unknown | null): void {
    this.events.push({ type, phase: 'start', messageId, blockId, chunk: null, payload, result: null });
  }

  emitChunk(type: string, blockId: string, chunk: string): void {
    this.events.push({
      type, phase: 'chunk', messageId: '', blockId, chunk, payload: null, result: null,
    });
  }

  emitEnd(type: string, blockId: string, result: unknown | null): void {
    this.events.push({
      type, phase: 'end', messageId: '', blockId, chunk: null, payload: null, result,
    });
  }

  emitError(type: string, blockId: string, error: string): void {
    this.events.push({
      type, phase: 'error', messageId: '', blockId, chunk: null, payload: error, result: null,
    });
  }

  emitToolCallPreparingStart(messageId: string, toolCallId: string, toolName: string,
    blockId: string | null): void {
    this.events.push({
      type: EVENT_TYPE_TOOL_CALL_PREPARING, phase: 'start', messageId, blockId, chunk: null,
      payload: { toolCallId, toolName, status: 'preparing' }, result: null,
    });
  }
}

let blockCounter = 0;
it('reset_stream_state_clears_reasoning_items: X5-05 reset uses the activity clock, not Unix time', () => {
  let monotonic = 100;
  let wall = 1_800_000_000_000;
  const adapter = new ChatV2StreamingAdapter(new RecordingSink(), 'msg_clock', {
    enableThinking: true, now: () => wall, elapsed: () => monotonic,
  });
  adapter.resetStreamState();
  monotonic = 151;
  expect(adapter.idleElapsedMs()).toBe(51);
  wall -= 1_000_000;
  expect(adapter.idleElapsedMs()).toBe(51);
  adapter.onContentChunk('x');
  monotonic += 20;
  expect(adapter.idleElapsedMs()).toBe(20);
});

function adapterWith(enableThinking: boolean): [ChatV2StreamingAdapter, RecordingSink] {
  const sink = new RecordingSink();
  const adapter = new ChatV2StreamingAdapter(sink, 'msg_test', {
    enableThinking,
    generateBlockId: () => `blk_test_${++blockCounter}`,
    now: () => 1_000 + blockCounter,
  });
  return [adapter, sink];
}

function reasoningItem(id: string): Record<string, unknown> {
  return { type: 'reasoning', id, encrypted_content: `enc-${id}` };
}

function collectedToolCall(id: string, name: string): LegacyChatMessage {
  return {
    role: 'assistant',
    content: '',
    tool_call: { id, tool_name: name, args_json: { note_id: 'n1' } },
  };
}

function preparingStartsFor(sink: RecordingSink, toolCallId: string): RecordedEvent[] {
  return sink.events.filter(event => event.type === EVENT_TYPE_TOOL_CALL_PREPARING
    && event.phase === 'start'
    && (event.payload as { toolCallId?: string } | null)?.toolCallId === toolCallId);
}

describe('chat_v2/pipeline/llm_adapter.rs::interleaved_text_segment_tests', () => {
  it('preserves_real_reasoning_content_alternation_as_distinct_blocks', () => {
    const [adapter] = adapterWith(true);

    adapter.onReasoningChunk('reasoning-1');
    adapter.onContentChunk('content-1');
    adapter.onReasoningChunk('reasoning-2');
    adapter.onContentChunk('content-2');
    adapter.onComplete();

    const segments = adapter.getTextSegments();
    expect(segments).toHaveLength(4);
    expect(segments.map(segment => [segment.blockType, segment.content])).toEqual([
      ['thinking', 'reasoning-1'],
      ['content', 'content-1'],
      ['thinking', 'reasoning-2'],
      ['content', 'content-2'],
    ]);
    expect(segments.every(segment => segment.endedAt !== null)).toBe(true);
    for (let index = 1; index < segments.length; index++) {
      expect(segments[index]!.blockId).not.toBe(segments[index - 1]!.blockId);
    }
  });
});

describe('chat_v2/pipeline/llm_adapter.rs::web_search_item_tests', () => {
  it('handle_web_search_caches_full_items_deduped_by_id', () => {
    const [adapter] = adapterWith(false);

    adapter.onWebSearch({
      id: 'ws_1',
      stage: 'in_progress',
      item: { type: 'web_search_call', id: 'ws_1', status: 'in_progress' },
    });
    adapter.onWebSearch({
      id: 'ws_1',
      stage: 'completed',
      sources: [{ title: 'A', url: 'https://a.example.com' }],
      item: {
        type: 'web_search_call',
        id: 'ws_1',
        status: 'completed',
        search_results: [{ url: 'https://a.example.com', title: 'A' }],
      },
    });
    adapter.onWebSearch({
      id: 'ws_2',
      stage: 'completed',
      sources: [],
      item: { type: 'web_search_call', id: 'ws_2', status: 'completed' },
    });
    // A progress payload without an `item` key never touches the cache.
    adapter.onWebSearch({ id: 'ws_3', stage: 'searching' });

    const items = adapter.takeWebSearchItems() as Array<Record<string, unknown>>;
    expect(items).toHaveLength(2);
    expect(items[0]!.id).toBe('ws_1');
    expect(items[0]!.status).toBe('completed');
    expect(items[0]!.search_results).toBeDefined();
    expect(items[1]!.id).toBe('ws_2');

    expect(adapter.takeWebSearchItems()).toEqual([]);
  });
});

describe('chat_v2/pipeline/llm_adapter.rs::response_reasoning_pairing_tests', () => {
  it('pairs_each_reasoning_item_with_adjacent_function_call', () => {
    const [adapter] = adapterWith(false);
    const r1 = reasoningItem('rs_1');
    const r2 = reasoningItem('rs_2');

    adapter.onResponseReasoningItem(r1);
    adapter.onToolCallStart('call_1', 'tool_a');
    adapter.onResponseReasoningItem(r2);
    adapter.onToolCallStart('call_2', 'tool_b');

    const items = adapter.getResponseReasoningItems();
    // Both items survive: a single-value overwrite is forbidden.
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual(['call_1', r1]);
    expect(items[1]).toEqual(['call_2', r2]);
  });

  it('repeated_tool_call_start_does_not_steal_next_reasoning_item', () => {
    const [adapter] = adapterWith(false);
    const r1 = reasoningItem('rs_1');
    const r2 = reasoningItem('rs_2');

    adapter.onResponseReasoningItem(r1);
    adapter.onToolCallStart('call_1', 'tool_a');
    adapter.onResponseReasoningItem(r2);
    adapter.onToolCallStart('call_1', 'tool_a');
    adapter.onToolCallStart('call_2', 'tool_b');

    const items = adapter.getResponseReasoningItems();
    expect(items[0]![0]).toBe('call_1');
    expect(items[1]![0]).toBe('call_2');
  });

  it('builtin_retrieval_tool_still_claims_reasoning_item', () => {
    const [adapter] = adapterWith(false);
    const r1 = reasoningItem('rs_1');
    adapter.onResponseReasoningItem(r1);
    adapter.onToolCallStart('call_rag', 'builtin-rag_search');

    expect(adapter.getResponseReasoningItems()[0]![0]).toBe('call_rag');
  });

  it('text_only_round_keeps_reasoning_item_unpaired', () => {
    const [adapter] = adapterWith(false);
    const r1 = reasoningItem('rs_final');
    adapter.onResponseReasoningItem(r1);

    expect(adapter.getResponseReasoningItems()).toEqual([[null, r1]]);
  });

  it('reset_stream_state_clears_reasoning_items', () => {
    const [adapter] = adapterWith(false);
    adapter.onResponseReasoningItem(reasoningItem('rs_1'));
    adapter.resetStreamState();
    expect(adapter.getResponseReasoningItems()).toEqual([]);
  });
});

describe('chat_v2/pipeline/llm_adapter.rs::tool_call_preparing_emit_once_tests', () => {
  it('repeated_tool_call_start_emits_preparing_once', () => {
    const [adapter, sink] = adapterWith(false);
    adapter.onToolCallStart('call_00_dup', 'builtin-note_read');
    adapter.onToolCallStart('call_00_dup', 'builtin-note_read');

    expect(preparingStartsFor(sink, 'call_00_dup')).toHaveLength(1);
  });

  it('tool_call_start_after_collection_does_not_reannounce_preparing', () => {
    const [adapter, sink] = adapterWith(false);
    adapter.onToolCallStart('call_00_late', 'builtin-note_read');
    adapter.onToolCallArgsDelta('call_00_late', '{"note_id":"n1"}');
    adapter.onToolCall(collectedToolCall('call_00_late', 'builtin-note_read'));
    adapter.onToolCallStart('call_00_late', 'builtin-note_read');

    const starts = preparingStartsFor(sink, 'call_00_late');
    expect(starts).toHaveLength(1);
    // Argument preview chunks still address the first preparing block.
    const blockId = starts[0]!.blockId;
    const chunks = sink.events
      .filter(event => event.type === EVENT_TYPE_TOOL_CALL_PREPARING && event.phase === 'chunk')
      .map(event => event.blockId);
    expect(chunks).toEqual([blockId]);
    expect(adapter.takeToolCalls()).toHaveLength(1);
  });

  it('distinct_ids_and_retry_reset_each_announce_once', () => {
    const [adapter, sink] = adapterWith(false);
    adapter.onToolCallStart('call_a', 'builtin-note_read');
    adapter.onToolCallStart('call_b', 'builtin-resource_list');
    adapter.onToolCallStart('call_a', 'builtin-note_read');
    expect(preparingStartsFor(sink, 'call_a')).toHaveLength(1);
    expect(preparingStartsFor(sink, 'call_b')).toHaveLength(1);

    adapter.resetStreamState();
    adapter.onToolCallStart('call_c', 'builtin-note_read');
    adapter.onToolCallStart('call_c', 'builtin-note_read');
    expect(preparingStartsFor(sink, 'call_c')).toHaveLength(1);
  });

  it('RF-W05-streaming-adapter-block-round-id: content and thinking block events carry roundId and skillStateVersion metadata', () => {
    const metas: Array<{ type: string; phase: string; meta: unknown }> = [];
    const sink: StreamEventSink = {
      emitStart: (type, _msg, _blk, _payload, meta) => { metas.push({ type, phase: 'start', meta }); },
      emitChunk: (type, _blk, _chunk, meta) => { metas.push({ type, phase: 'chunk', meta }); },
      emitEnd: (type, _blk, _res, meta) => { metas.push({ type, phase: 'end', meta }); },
      emitError: (type, _blk, _err, meta) => { metas.push({ type, phase: 'error', meta }); },
      emitToolCallPreparingStart: (_msg, _id, _name, _blk, meta) => { metas.push({ type: EVENT_TYPE_TOOL_CALL_PREPARING, phase: 'start', meta }); },
    };
    const adapter = new ChatV2StreamingAdapter(sink, 'msg_meta', {
      enableThinking: true,
      roundId: 'tool-round-0',
      skillStateVersion: 3,
    });
    adapter.onReasoningChunk('think');
    adapter.onContentChunk('answer');
    adapter.onComplete();
    expect(metas.length).toBeGreaterThanOrEqual(6);
    for (const item of metas) {
      expect(item.meta).toEqual({ roundId: 'tool-round-0', skillStateVersion: 3 });
    }
  });
});

describe('chat_v2/pipeline_tests.rs::tests (adapter basics)', () => {
  it('test_llm_adapter_creation', () => {
    const first = ChatV2StreamingAdapter.generateBlockId();
    const second = ChatV2StreamingAdapter.generateBlockId();
    expect(first.startsWith('blk_')).toBe(true);
    expect(first).toHaveLength(4 + 36);
    expect(first).not.toBe(second);
  });

  it('test_adapter_tool_call_collection', () => {
    const [adapter] = adapterWith(false);
    adapter.onToolCall(collectedToolCall('call_123', 'memory'));
    expect(adapter.hasToolCalls()).toBe(true);
    expect(adapter.takeToolCalls()).toEqual([
      { id: 'call_123', name: 'memory', arguments: { note_id: 'n1' } },
    ]);
  });

  it('test_adapter_take_tool_calls_clears_collection', () => {
    const [adapter] = adapterWith(false);
    adapter.onToolCall(collectedToolCall('call_1', 'tool_a'));
    adapter.onToolCall(collectedToolCall('call_2', 'tool_b'));

    const taken = adapter.takeToolCalls();
    expect(taken).toHaveLength(2);
    expect(taken.map(call => call.id)).toEqual(['call_1', 'call_2']);
    expect(adapter.takeToolCalls()).toEqual([]);
    expect(adapter.hasToolCalls()).toBe(false);
  });

  it('test_tool_call_conversion_from_message', () => {
    const [adapter] = adapterWith(false);
    const message: LegacyChatMessage = {
      role: 'assistant',
      content: '',
      tool_call: {
        id: 'call_test_123',
        tool_name: 'rag',
        args_json: { query: '测试查询', top_k: 5 },
      },
    };

    adapter.onToolCall(message);
    const [converted] = adapter.takeToolCalls();
    expect(converted!.id).toBe('call_test_123');
    expect(converted!.name).toBe('rag');
    expect(converted!.arguments).toEqual({ query: '测试查询', top_k: 5 });
  });
});

describe('preparing block lifecycle cleanup & retrieval tool matching', () => {
  it('matches builtin retrieval tools across prefixes while excluding mcp and memory_search', () => {
    expect(ChatV2StreamingAdapter.isBuiltinRetrievalTool('rag_search')).toBe(true);
    expect(ChatV2StreamingAdapter.isBuiltinRetrievalTool('builtin-rag_search')).toBe(true);
    expect(ChatV2StreamingAdapter.isBuiltinRetrievalTool('builtin:web_search')).toBe(true);
    expect(ChatV2StreamingAdapter.isBuiltinRetrievalTool('insight_recall')).toBe(true);
    expect(ChatV2StreamingAdapter.isBuiltinRetrievalTool('builtin-memory_search')).toBe(false);
    expect(ChatV2StreamingAdapter.isBuiltinRetrievalTool('mcp_rag_search')).toBe(false);
    expect(ChatV2StreamingAdapter.isBuiltinRetrievalTool('mcp.tools.web_search')).toBe(false);
  });

  it('fails unpromoted preparing blocks on onError and discards them on resetStreamState unless promoted', () => {
    const [adapter, sink] = adapterWith(false);
    adapter.onToolCallStart('call_err', 'note_read');
    expect(adapter.hasPreparingBlocks()).toBe(true);
    adapter.onToolCall(collectedToolCall('call_err', 'note_read'));
    // Still tracked until promoted to tool execution
    expect(adapter.hasPreparingBlocks()).toBe(true);

    adapter.onError('upstream failed');
    expect(adapter.hasPreparingBlocks()).toBe(false);
    expect(sink.events.some(e => e.type === EVENT_TYPE_TOOL_CALL_PREPARING && e.phase === 'error')).toBe(true);

    adapter.onToolCallStart('call_discard', 'note_read');
    adapter.resetStreamState();
    expect(adapter.hasPreparingBlocks()).toBe(false);
    expect(sink.events.some(e => e.type === EVENT_TYPE_TOOL_CALL_PREPARING && e.phase === 'end')).toBe(true);

    const beforeCount = sink.events.length;
    adapter.onToolCallStart('call_exec', 'note_read');
    adapter.markPreparingPromoted();
    expect(adapter.hasPreparingBlocks()).toBe(false);
    adapter.onError('later error');
    const afterEvents = sink.events.slice(beforeCount);
    expect(afterEvents.some(e => e.type === EVENT_TYPE_TOOL_CALL_PREPARING && (e.phase === 'end' || e.phase === 'error'))).toBe(false);
  });
});
