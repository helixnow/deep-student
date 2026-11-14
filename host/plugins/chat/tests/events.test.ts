import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BackendEvent,
  ChatV2EventEmitter,
  EVENT_PHASE,
  EVENT_TYPE,
  NoopEventSink,
  SESSION_EVENT_TYPE,
  SessionEvent,
  emitFailureCount,
  clearSessionSequenceCounter,
} from '../src/events.ts';
import type {
  BackendEvent as BackendEventWire,
  ExecutionEventSink,
  SessionEvent as SessionEventWire,
} from '../src/events.ts';
import { tokenUsageFromApi } from '../src/types.ts';

class RecordingSink implements ExecutionEventSink {
  blockEvents: Array<[string, BackendEventWire]> = [];
  sessionEvents: Array<[string, SessionEventWire]> = [];

  emitBlockEvent(channel: string, event: BackendEventWire): void {
    this.blockEvents.push([channel, { ...event }]);
  }

  emitSessionEvent(channel: string, event: SessionEventWire): void {
    this.sessionEvents.push([channel, { ...event }]);
  }

  window(): null {
    return null;
  }
}

function batchingEmitter(session: string): {
  emitter: ChatV2EventEmitter;
  recorded: Array<[string, BackendEventWire]>;
} {
  const sink = new RecordingSink();
  const emitter = ChatV2EventEmitter.withSinkAndBatching(sink, session, true);
  return { emitter, recorded: sink.blockEvents };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('chat_v2/events.rs', () => {
  it('test_backend_event_serialization', () => {
    const event = BackendEvent.chunk(42, 'content', 'blk_123', 'Hello', null);

    const json = JSON.stringify(event);

    expect(json).toContain('"blockId"');
    expect(json).toContain('"blk_123"');
    expect(json).toContain('"sequenceId"');
    expect(json).toContain('42');

    expect(json).not.toContain('"messageId"');
    expect(json).not.toContain('"blockType"');
    expect(json).not.toContain('"result"');
    expect(json).not.toContain('"error"');
    expect(json).not.toContain('"payload"');
    expect(json).not.toContain('"variantId"');
    expect(json).not.toContain('"modelId"');
    expect(json).not.toContain('"status"');
  });

  it('test_backend_event_start_creation', () => {
    const event = BackendEvent.start(
      0,
      EVENT_TYPE.CONTENT,
      'msg_456',
      'blk_123',
      { key: 'value' },
      null,
    );

    expect(event.sequenceId).toBe(0);
    expect(event.type).toBe('content');
    expect(event.phase).toBe('start');
    expect(event.messageId).toBe('msg_456');
    expect(event.blockId).toBe('blk_123');
    expect(event.payload).toEqual({ key: 'value' });
    expect(event.variantId).toBeUndefined();
  });

  it('test_backend_event_start_with_variant', () => {
    const event = BackendEvent.start(5, EVENT_TYPE.CONTENT, 'msg_456', 'blk_123', null, 'var_001');

    expect(event.sequenceId).toBe(5);
    expect(event.variantId).toBe('var_001');
  });

  it('test_backend_event_chunk_creation', () => {
    const event = BackendEvent.chunk(1, EVENT_TYPE.THINKING, 'blk_789', '思考中...', null);

    expect(event.sequenceId).toBe(1);
    expect(event.type).toBe('thinking');
    expect(event.phase).toBe('chunk');
    expect(event.blockId).toBe('blk_789');
    expect(event.chunk).toBe('思考中...');
    expect(event.messageId).toBeUndefined();
    expect(event.variantId).toBeUndefined();
  });

  it('test_backend_event_chunk_with_variant', () => {
    const event = BackendEvent.chunk(10, EVENT_TYPE.CONTENT, 'blk_789', '内容', 'var_002');

    expect(event.sequenceId).toBe(10);
    expect(event.variantId).toBe('var_002');
  });

  it('test_backend_event_end_creation', () => {
    const result = { sources: [{ title: '文档1' }] };
    const event = BackendEvent.end(2, EVENT_TYPE.RAG, 'blk_abc', result, null);

    expect(event.sequenceId).toBe(2);
    expect(event.type).toBe('rag');
    expect(event.phase).toBe('end');
    expect(event.blockId).toBe('blk_abc');
    expect(event.result).toEqual(result);
    expect(event.variantId).toBeUndefined();
  });

  it('test_backend_event_error_creation', () => {
    const event = BackendEvent.error(3, EVENT_TYPE.TOOL_CALL, 'blk_def', '工具调用超时', null);

    expect(event.sequenceId).toBe(3);
    expect(event.type).toBe('tool_call');
    expect(event.phase).toBe('error');
    expect(event.blockId).toBe('blk_def');
    expect(event.error).toBe('工具调用超时');
  });

  it('test_backend_event_variant_start', () => {
    const event = BackendEvent.variantStart(0, 'msg_001', 'var_001', 'gpt-4');

    expect(event.sequenceId).toBe(0);
    expect(event.type).toBe(EVENT_TYPE.VARIANT_START);
    expect(event.phase).toBe(EVENT_PHASE.START);
    expect(event.messageId).toBe('msg_001');
    expect(event.variantId).toBe('var_001');
    expect(event.modelId).toBe('gpt-4');
    expect(event.blockId).toBeUndefined();
    expect(event.status).toBeUndefined();
  });

  it('test_backend_event_variant_end_success', () => {
    const event = BackendEvent.variantEnd(10, 'var_001', 'success', null, null);

    expect(event.sequenceId).toBe(10);
    expect(event.type).toBe(EVENT_TYPE.VARIANT_END);
    expect(event.phase).toBe(EVENT_PHASE.END);
    expect(event.variantId).toBe('var_001');
    expect(event.status).toBe('success');
    expect(event.error).toBeUndefined();
    expect(event.messageId).toBeUndefined();
    expect(event.usage).toBeUndefined();
  });

  it('test_backend_event_variant_end_error', () => {
    const event = BackendEvent.variantEnd(15, 'var_002', 'error', '模型调用失败', null);

    expect(event.sequenceId).toBe(15);
    expect(event.variantId).toBe('var_002');
    expect(event.status).toBe('error');
    expect(event.error).toBe('模型调用失败');
    expect(event.usage).toBeUndefined();
  });

  it('test_backend_event_variant_end_with_usage', () => {
    const usage = tokenUsageFromApi(100, 50, 10);
    const event = BackendEvent.variantEnd(20, 'var_003', 'success', null, usage);

    expect(event.sequenceId).toBe(20);
    expect(event.variantId).toBe('var_003');
    expect(event.status).toBe('success');
    expect(event.usage).toBeDefined();
    const actual = event.usage!;
    expect(actual.promptTokens).toBe(100);
    expect(actual.completionTokens).toBe(50);
    expect(actual.totalTokens).toBe(150);
  });

  it('test_session_event_serialization', () => {
    vi.useFakeTimers(); vi.setSystemTime(1701619200000);
    clearSessionSequenceCounter('sess_123');
    const sink = new RecordingSink();
    const emitter = ChatV2EventEmitter.withSink(sink, 'sess_123').withStreamGeneration(42);
    for (let i = 0; i < 7; i++) emitter.emitStreamStart('msg_456', null);
    emitter.emitStreamComplete('msg_456', 1500);
    const event = sink.sessionEvents.at(-1)![1];
    emitter.dispose();

    const json = JSON.stringify(event);

    expect(json).toContain('"sessionId"');
    expect(json).toContain('"sequenceId":7');
    expect(json).toContain('"streamGeneration":42');
    expect(json).toContain('"eventType"');
    expect(json).toContain('"messageId"');
    expect(json).toContain('"durationMs"');

    expect(json).not.toContain('"error"');
    expect(json).not.toContain('"usage"');
  });

  it('lifecycle_events_keep_one_stream_generation_contract', () => {
    const generation = 73;
    const events = [
      SessionEvent.withStreamGeneration(SessionEvent.streamStart('sess', 'msg', null), generation),
      SessionEvent.withStreamGeneration(SessionEvent.streamReconnect('sess', 'msg', 1, 2), generation),
      SessionEvent.withStreamGeneration(SessionEvent.streamComplete('sess', 'msg', 10), generation),
      SessionEvent.withStreamGeneration(SessionEvent.streamError('sess', 'msg', 'failed'), generation),
      SessionEvent.withStreamGeneration(SessionEvent.streamCancelled('sess', 'msg'), generation),
    ];

    for (const event of events) {
      expect(event.streamGeneration).toBe(generation);
      expect(JSON.parse(JSON.stringify(event)).streamGeneration).toBe(73);
    }
  });

  it('test_session_event_stream_start', () => {
    const event = SessionEvent.streamStart('sess_abc', 'msg_def', null);
    expect(event.sessionId).toBe('sess_abc');
    expect(event.eventType).toBe(SESSION_EVENT_TYPE.STREAM_START);
    expect(event.messageId).toBe('msg_def');
    expect(event.modelId).toBeUndefined();
    expect(event.error).toBeUndefined();
    expect(event.durationMs).toBeUndefined();
    expect(event.timestamp).toBeGreaterThan(0);

    const eventWithModel = SessionEvent.streamStart('sess_abc', 'msg_def', 'Qwen/Qwen3-8B');
    expect(eventWithModel.modelId).toBe('Qwen/Qwen3-8B');
  });

  it('test_session_event_stream_complete', () => {
    const event = SessionEvent.streamComplete('sess_abc', 'msg_def', 2500);

    expect(event.eventType).toBe(SESSION_EVENT_TYPE.STREAM_COMPLETE);
    expect(event.durationMs).toBe(2500);
    expect(event.usage).toBeUndefined();
  });

  it('test_session_event_stream_complete_with_usage', () => {
    const usage = tokenUsageFromApi(1234, 567, 200);

    const event = SessionEvent.streamCompleteWithUsage('sess_abc', 'msg_def', 2500, usage);

    expect(event.eventType).toBe(SESSION_EVENT_TYPE.STREAM_COMPLETE);
    expect(event.durationMs).toBe(2500);
    expect(event.usage).toBeDefined();

    const eventUsage = event.usage!;
    expect(eventUsage.promptTokens).toBe(1234);
    expect(eventUsage.completionTokens).toBe(567);
    expect(eventUsage.totalTokens).toBe(1801);
    expect(eventUsage.source).toBe('api');
    expect(eventUsage.reasoningTokens).toBe(200);
  });

  it('test_session_event_with_usage_serialization', () => {
    const usage = tokenUsageFromApi(1000, 500, null);
    const event = SessionEvent.streamCompleteWithUsage('sess_123', 'msg_456', 1500, usage);

    const json = JSON.stringify(event);

    expect(json).toContain('"usage"');
    expect(json).toContain('"promptTokens":1000');
    expect(json).toContain('"completionTokens":500');
    expect(json).toContain('"totalTokens":1500');
    expect(json).toContain('"source":"api"');
    expect(json).not.toContain('"reasoningTokens"');
  });

  it('test_session_event_stream_error', () => {
    const event = SessionEvent.streamError('sess_abc', 'msg_def', '网络错误');

    expect(event.eventType).toBe(SESSION_EVENT_TYPE.STREAM_ERROR);
    expect(event.error).toBe('网络错误');
  });

  it('test_session_event_stream_cancelled', () => {
    const event = SessionEvent.streamCancelled('sess_abc', 'msg_def');

    expect(event.eventType).toBe(SESSION_EVENT_TYPE.STREAM_CANCELLED);
    expect(event.error).toBeUndefined();
  });

  it('test_session_event_save_complete', () => {
    const event = SessionEvent.saveComplete('sess_abc');

    expect(event.eventType).toBe(SESSION_EVENT_TYPE.SAVE_COMPLETE);
    expect(event.messageId).toBeUndefined();
  });

  it('compaction_progress_events_have_stable_session_contracts', () => {
    const started = JSON.parse(JSON.stringify(SessionEvent.compactionStarted('sess_progress', 'auto')));
    expect(started.eventType).toBe('compaction_started');
    expect(started.sessionId).toBe('sess_progress');
    expect(started.payload.reason).toBe('auto');
    const finished = JSON.parse(JSON.stringify(SessionEvent.compactionFinished('sess_progress')));
    expect(finished.eventType).toBe('compaction_finished');
    expect(finished.sessionId).toBe('sess_progress');
    expect(finished.payload ?? null).toBeNull();
  });

  it('test_session_event_compaction_failed_contract', () => {
    const event = SessionEvent.compactionFailed('sess_abc', 'summaryFailed');
    expect(event.eventType).toBe('compaction_failed');
    expect(event.sessionId).toBe('sess_abc');

    const json = JSON.parse(JSON.stringify(event));
    expect(json.eventType).toBe('compaction_failed');
    expect(json.payload.reason).toBe('summaryFailed');
  });

  it('test_session_event_compaction_completed_contract', () => {
    const event = SessionEvent.compactionCompleted('sess_abc', 289_508, 92_140);
    expect(event.eventType).toBe('compaction_completed');
    expect(event.sessionId).toBe('sess_abc');

    const json = JSON.parse(JSON.stringify(event));
    expect(json.eventType).toBe('compaction_completed');
    expect(json.payload.tokensBefore).toBe(289_508);
    expect(json.payload.tokensAfter).toBe(92_140);

    const empty = JSON.parse(JSON.stringify(SessionEvent.compactionCompleted('sess_abc', null, null)));
    expect(empty.payload.tokensBefore).toBeNull();
    expect(empty.payload.tokensAfter).toBeNull();
  });

  it('test_session_event_context_trimmed_contract', () => {
    const event = SessionEvent.contextTrimmed('sess_abc', 5, 1234);
    expect(event.eventType).toBe('context_trimmed');
    const json = JSON.parse(JSON.stringify(event));
    expect(json.eventType).toBe('context_trimmed');
    expect(json.payload.droppedMessages).toBe(5);
    expect(json.payload.estimatedDroppedTokens).toBe(1234);

    const withoutEstimate = JSON.parse(JSON.stringify(SessionEvent.contextTrimmed('sess_abc', 3, null)));
    expect(withoutEstimate.payload.droppedMessages).toBe(3);
    expect('estimatedDroppedTokens' in withoutEstimate.payload).toBe(false);
  });

  it('test_session_event_payload_absent_for_legacy_events', () => {
    const event = SessionEvent.streamComplete('sess_abc', 'msg_def', 100);
    const json = JSON.stringify(event);
    expect(json).not.toContain('"payload"');
    const legacy = '{"sessionId":"s","eventType":"stream_complete","timestamp":1}';
    const parsed = JSON.parse(legacy) as SessionEventWire;
    expect(parsed.payload).toBeUndefined();
  });

  it('test_session_event_save_error', () => {
    const event = SessionEvent.saveError('sess_abc', '数据库写入失败');

    expect(event.eventType).toBe(SESSION_EVENT_TYPE.SAVE_ERROR);
    expect(event.error).toBe('数据库写入失败');
  });

  it('test_event_phase_constants', () => {
    expect(EVENT_PHASE.START).toBe('start');
    expect(EVENT_PHASE.CHUNK).toBe('chunk');
    expect(EVENT_PHASE.END).toBe('end');
    expect(EVENT_PHASE.ERROR).toBe('error');
  });

  it('test_event_types_constants', () => {
    expect(EVENT_TYPE.THINKING).toBe('thinking');
    expect(EVENT_TYPE.CONTENT).toBe('content');
    expect(EVENT_TYPE.TOOL_CALL).toBe('tool_call');
    expect(EVENT_TYPE.IMAGE_GEN).toBe('image_gen');
    expect(EVENT_TYPE.RAG).toBe('rag');
    expect(EVENT_TYPE.MEMORY).toBe('memory');
    expect(EVENT_TYPE.WEB_SEARCH).toBe('web_search');
    expect(EVENT_TYPE.ANKI_CARDS).toBe('anki_cards');
    expect(EVENT_TYPE.GENERATIVE_UI).toBe('generative_ui');
    expect(EVENT_TYPE.VARIANT_START).toBe('variant_start');
    expect(EVENT_TYPE.VARIANT_END).toBe('variant_end');
  });

  it('test_session_event_type_constants', () => {
    expect(SESSION_EVENT_TYPE.STREAM_START).toBe('stream_start');
    expect(SESSION_EVENT_TYPE.STREAM_COMPLETE).toBe('stream_complete');
    expect(SESSION_EVENT_TYPE.STREAM_ERROR).toBe('stream_error');
    expect(SESSION_EVENT_TYPE.STREAM_CANCELLED).toBe('stream_cancelled');
    expect(SESSION_EVENT_TYPE.SAVE_COMPLETE).toBe('save_complete');
    expect(SESSION_EVENT_TYPE.SAVE_ERROR).toBe('save_error');
  });

  it('test_backend_event_deserialization', () => {
    const json = '{"sequenceId":5,"type":"content","phase":"chunk","blockId":"blk_123","chunk":"Hello World"}';

    const event = JSON.parse(json) as BackendEventWire;

    expect(event.sequenceId).toBe(5);
    expect(event.type).toBe('content');
    expect(event.phase).toBe('chunk');
    expect(event.blockId).toBe('blk_123');
    expect(event.chunk).toBe('Hello World');
    expect(event.messageId).toBeUndefined();
    expect(event.variantId).toBeUndefined();
  });

  it('test_backend_event_deserialization_with_variant', () => {
    const json = '{"sequenceId":10,"type":"content","phase":"chunk","blockId":"blk_123","chunk":"Hello","variantId":"var_001"}';

    const event = JSON.parse(json) as BackendEventWire;

    expect(event.sequenceId).toBe(10);
    expect(event.variantId).toBe('var_001');
  });

  it('test_session_event_deserialization', () => {
    const json = '{"sessionId":"sess_123","eventType":"stream_complete","messageId":"msg_456","durationMs":1500,"timestamp":1701619200000}';

    const event = JSON.parse(json) as SessionEventWire;

    expect(event.sessionId).toBe('sess_123');
    expect(event.eventType).toBe('stream_complete');
    expect(event.messageId).toBe('msg_456');
    expect(event.durationMs).toBe(1500);
    expect(event.timestamp).toBe(1701619200000);
  });

  it('test_sequence_id_strictly_increasing', () => {
    const event1 = BackendEvent.start(0, EVENT_TYPE.CONTENT, 'msg_1', null, null, null);
    const event2 = BackendEvent.chunk(1, EVENT_TYPE.CONTENT, 'blk_1', 'a', null);
    const event3 = BackendEvent.chunk(2, EVENT_TYPE.CONTENT, 'blk_1', 'b', null);
    const event4 = BackendEvent.end(3, EVENT_TYPE.CONTENT, 'blk_1', null, null);

    expect(event1.sequenceId).toBe(0);
    expect(event2.sequenceId).toBe(1);
    expect(event3.sequenceId).toBe(2);
    expect(event4.sequenceId).toBe(3);

    expect(event1.sequenceId).toBeLessThan(event2.sequenceId);
    expect(event2.sequenceId).toBeLessThan(event3.sequenceId);
    expect(event3.sequenceId).toBeLessThan(event4.sequenceId);
  });

  it('test_variant_event_serialization', () => {
    const event = BackendEvent.variantStart(0, 'msg_001', 'var_001', 'gpt-4');
    const json = JSON.stringify(event);

    expect(json).toContain('"sequenceId":0');
    expect(json).toContain('"type":"variant_start"');
    expect(json).toContain('"variantId":"var_001"');
    expect(json).toContain('"modelId":"gpt-4"');
    expect(json).toContain('"messageId":"msg_001"');

    const event2 = BackendEvent.variantEnd(5, 'var_001', 'success', null, null);
    const json2 = JSON.stringify(event2);

    expect(json2).toContain('"sequenceId":5');
    expect(json2).toContain('"type":"variant_end"');
    expect(json2).toContain('"status":"success"');
    expect(json2).not.toContain('"error"');
    expect(json2).not.toContain('"usage"');
  });

  // ========== G01-a: ExecutionEventSink ==========

  it('noop_sink_emitter_all_paths_do_not_panic', () => {
    const emitter = ChatV2EventEmitter.newHeadless('test_noop_all_paths').withStreamGeneration(7);

    emitter.emitStart(EVENT_TYPE.CONTENT, 'msg_1', 'blk_1', null, null);
    emitter.emitStartWithMeta(EVENT_TYPE.THINKING, 'msg_1', 'blk_2', null, null, 3, 'round_1');
    emitter.emitChunk(EVENT_TYPE.CONTENT, 'blk_1', 'chunk', null);
    emitter.emitChunkWithMeta(EVENT_TYPE.CONTENT, 'blk_1', 'chunk', null, 3, 'round_1');
    emitter.emitEnd(EVENT_TYPE.CONTENT, 'blk_1', null, null);
    emitter.emitEndWithMeta(EVENT_TYPE.CONTENT, 'blk_1', null, null, 3, null);
    emitter.emitError(EVENT_TYPE.TOOL_CALL, 'blk_1', 'boom', null);
    emitter.emitErrorWithMeta(EVENT_TYPE.TOOL_CALL, 'blk_1', 'boom', null, 3, null);
    emitter.emitSkillInjectionAudit('msg_1', { k: 'v' }, null, null, null);
    emitter.emitContentChunk('blk_1', 'content', null);
    emitter.emitThinkingChunk('blk_2', 'thinking', null);
    emitter.emitToolCallStart('msg_1', 'blk_3', 'builtin:rag', { query: 'x' }, 'tc_1', null);
    emitter.emitToolCallPreparing('msg_1', 'tc_1', 'builtin:rag', 'blk_3');
    emitter.emitToolCallPreparingWithMeta('msg_1', 'tc_1', 'builtin:rag', 'blk_3', null, 3, null);
    emitter.emitToolCallPreparingWithVariant('msg_1', 'tc_1', 'builtin:rag', 'blk_3', 'var_1');

    emitter.emitVariantStart('msg_1', 'var_1', 'gpt-4');
    emitter.emitVariantEnd('var_1', 'success', null, null);

    emitter.emitStreamStart('msg_1', 'gpt-4');
    emitter.emitStreamReconnect('msg_1', 1, 2);
    emitter.emitStreamComplete('msg_1', 1500);
    emitter.emitStreamCompleteWithUsage('msg_1', 1500, null);
    emitter.emitStreamError('msg_1', 'network down');
    emitter.emitStreamCancelled('msg_1');
    emitter.emitSaveComplete();
    emitter.emitSaveError('db write failed');
    emitter.emitSummaryUpdated('title', 'description');
    emitter.emitCompactionFailed('summaryFailed');
    emitter.emitContextTrimmed(2, 128);
  });

  it('noop_sink_window_accessors', () => {
    const emitter = ChatV2EventEmitter.newHeadless('test_noop_window');
    expect(emitter.tryWindow()).toBeNull();
    expect(emitter.sinkRef().window()).toBeNull();
  });

  it('noop_sink_window_panics_on_window', () => {
    const emitter = ChatV2EventEmitter.newHeadless('test_noop_window_panic');
    expect(() => emitter.window()).toThrow(/windowless emitter/);
  });

  it('noop_sink_does_not_increment_failure_count', () => {
    const before = emitFailureCount();
    const emitter = ChatV2EventEmitter.newHeadless('test_noop_failure_count');
    emitter.emitContentChunk('blk_1', 'data', null);
    emitter.emitStreamComplete('msg_1', 10);
    expect(emitFailureCount()).toBe(before);
  });

  it('noop_sink_sequence_ids_still_advance', () => {
    const emitter = ChatV2EventEmitter.newHeadless('test_noop_seq');
    const start = emitter.currentSequenceId();
    emitter.emitContentChunk('blk_1', 'a', null);
    emitter.emitContentChunk('blk_1', 'b', null);
    expect(emitter.currentSequenceId()).toBe(start + 2);
  });

  it('recording_sink_captures_block_events', () => {
    const sink = new RecordingSink();
    const emitter = ChatV2EventEmitter.withSink(sink, 'test_recording_block');
    emitter.registerBlockEventMeta('blk_meta', 'var_9', 42, 'round_7');

    emitter.emitStart(EVENT_TYPE.CONTENT, 'msg_1', 'blk_1', null, null);
    emitter.emitChunk(EVENT_TYPE.CONTENT, 'blk_1', 'hello', null);
    emitter.emitChunk(EVENT_TYPE.CONTENT, 'blk_meta', 'meta', null);
    emitter.emitEnd(EVENT_TYPE.CONTENT, 'blk_1', null, null);

    const captured = sink.blockEvents;
    expect(captured).toHaveLength(4);
    for (const [channel, event] of captured) {
      expect(channel).toBe('chat_v2_event_test_recording_block');
      expect(event.sessionId).toBe('test_recording_block');
    }
    for (let index = 1; index < captured.length; index += 1) {
      expect(captured[index - 1]![1].sequenceId).toBeLessThan(captured[index]![1].sequenceId);
    }
    const metaEvent = captured[2]![1];
    expect(metaEvent.variantId).toBe('var_9');
    expect(metaEvent.skillStateVersion).toBe(42);
    expect(metaEvent.roundId).toBe('round_7');
  });

  it('recording_sink_captures_session_events', () => {
    const sink = new RecordingSink();
    const emitter = ChatV2EventEmitter.withSink(sink, 'test_recording_session').withStreamGeneration(73);

    emitter.emitStreamStart('msg_1', null);
    emitter.emitStreamComplete('msg_1', 100);

    const captured = sink.sessionEvents;
    expect(captured).toHaveLength(2);
    for (const [channel, event] of captured) {
      expect(channel).toBe('chat_v2_session_test_recording_session');
      expect(event.streamGeneration).toBe(73);
    }
    const firstSeq = captured[0]![1].sequenceId!;
    const secondSeq = captured[1]![1].sequenceId!;
    expect(firstSeq).toBeLessThan(secondSeq);
  });

  // ========== 流式 chunk 合批 ==========

  it('chunk_batching_merges_and_end_flushes_in_order', () => {
    const { emitter, recorded } = batchingEmitter('test_batch_merge');

    emitter.emitChunk(EVENT_TYPE.CONTENT, 'blk_1', 'Hello ', null);
    emitter.emitChunk(EVENT_TYPE.CONTENT, 'blk_1', 'world', null);
    expect(recorded).toHaveLength(0);

    emitter.emitEnd(EVENT_TYPE.CONTENT, 'blk_1', null, null);

    expect(recorded).toHaveLength(2);
    expect(recorded[0]![1].type).toBe(EVENT_TYPE.CONTENT);
    expect(recorded[0]![1].phase).toBe('chunk');
    expect(recorded[0]![1].chunk).toBe('Hello world');
    expect(recorded[1]![1].phase).toBe('end');
    expect(recorded[0]![1].sequenceId).toBeLessThan(recorded[1]![1].sequenceId);
  });

  it('chunk_batching_key_switch_flushes_previous_pending', () => {
    const { emitter, recorded } = batchingEmitter('test_batch_switch');

    emitter.emitChunk(EVENT_TYPE.CONTENT, 'blk_a', 'a1', null);
    emitter.emitChunk(EVENT_TYPE.THINKING, 'blk_b', 't1', null);
    emitter.emitChunk(EVENT_TYPE.CONTENT, 'blk_a', 'a2', null);
    emitter.emitEnd(EVENT_TYPE.CONTENT, 'blk_a', null, null);

    const chunks = recorded.map(([, event]) => event).filter(event => event.phase === 'chunk');
    expect(chunks).toHaveLength(3);
    expect(chunks[0]!.blockId).toBe('blk_a');
    expect(chunks[0]!.chunk).toBe('a1');
    expect(chunks[1]!.blockId).toBe('blk_b');
    expect(chunks[1]!.chunk).toBe('t1');
    expect(chunks[2]!.blockId).toBe('blk_a');
    expect(chunks[2]!.chunk).toBe('a2');
    for (let index = 1; index < recorded.length; index += 1) {
      expect(recorded[index - 1]![1].sequenceId).toBeLessThan(recorded[index]![1].sequenceId);
    }
  });

  it('chunk_batching_key_switch_expiry_opens_next_window', () => {
    const { emitter, recorded } = batchingEmitter('test_batch_switch_expiry');
    emitter.setChunkWindowOpen(true);

    emitter.emitContentChunk('blk_a', 'first', null);
    emitter.emitThinkingChunk('blk_b', 'second', null);
    emitter.finishChunkWindow();
    expect(emitter.chunkWindowOpen()).toBe(false);
    expect(recorded).toHaveLength(2);

    emitter.emitThinkingChunk('blk_b', 'third', null);
    expect(emitter.chunkWindowOpen()).toBe(true);
    emitter.emitEnd(EVENT_TYPE.THINKING, 'blk_b', null, null);
    expect(recorded[2]![1].chunk).toBe('third');
    expect(recorded[3]![1].phase).toBe(EVENT_PHASE.END);
  });

  it('chunk_batching_empty_window_expiry_opens_next_window', () => {
    const { emitter, recorded } = batchingEmitter('test_batch_empty_expiry');
    emitter.setChunkWindowOpen(true);
    emitter.emitContentChunk('blk_a', 'first', null);
    emitter.emitEnd(EVENT_TYPE.CONTENT, 'blk_a', null, null);
    expect(emitter.pendingChunkCount()).toBe(0);

    emitter.finishChunkWindow();
    expect(emitter.chunkWindowOpen()).toBe(false);
    emitter.emitContentChunk('blk_b', 'next', null);
    expect(emitter.chunkWindowOpen()).toBe(true);
    emitter.emitEnd(EVENT_TYPE.CONTENT, 'blk_b', null, null);
    expect(recorded).toHaveLength(4);
    expect(recorded[2]![1].chunk).toBe('next');
  });

  it('chunk_batching_interleaved_variants_coalesce_independently', () => {
    const { emitter, recorded } = batchingEmitter('test_batch_interleaved');
    emitter.setChunkWindowOpen(true);
    for (let index = 0; index < 50; index += 1) {
      emitter.emitContentChunk('blk_a', 'a', 'variant_a');
      emitter.emitContentChunk('blk_b', 'b', 'variant_b');
    }
    expect(recorded).toHaveLength(0);
    emitter.emitVariantEnd('variant_a', 'success', null, null);

    expect(recorded).toHaveLength(3);
    expect(recorded[0]![1].variantId).toBe('variant_a');
    expect(recorded[0]![1].chunk).toBe('a'.repeat(50));
    expect(recorded[1]![1].variantId).toBe('variant_b');
    expect(recorded[1]![1].chunk).toBe('b'.repeat(50));
    expect(recorded[2]![1].type).toBe(EVENT_TYPE.VARIANT_END);
    for (let index = 1; index < recorded.length; index += 1) {
      expect(recorded[index]![1].sequenceId).toBe(recorded[index - 1]![1].sequenceId + 1);
    }
  });

  it('chunk_batching_concurrent_variants_preserve_every_delta', () => {
    const { emitter, recorded } = batchingEmitter('test_batch_concurrent');
    emitter.setChunkWindowOpen(true);
    for (let index = 0; index < 200; index += 1) {
      emitter.emitContentChunk('blk_a', 'a', 'variant_a');
      emitter.emitContentChunk('blk_b', 'b', 'variant_b');
    }
    emitter.emitStreamComplete('msg_1', 1);
    expect(recorded).toHaveLength(2);
    for (const [variant, chunk] of [['variant_a', 'a'], ['variant_b', 'b']] as const) {
      const event = recorded.find(([, candidate]) => candidate.variantId === variant);
      expect(event).toBeDefined();
      expect(event![1].chunk).toBe(chunk.repeat(200));
    }
  });

  it('chunk_batching_flush_holds_ordering_lock_through_delivery', () => {
    const delivered: Array<[string, number]> = [];
    let pendingDuringChunk = -1;
    let emitter!: ChatV2EventEmitter;
    const sink: ExecutionEventSink = {
      emitBlockEvent(_channel, event) {
        if (event.phase === EVENT_PHASE.CHUNK) pendingDuringChunk = emitter.pendingChunkCount();
        delivered.push([event.phase, event.sequenceId]);
      },
      emitSessionEvent() {
        // Session events are not part of this ordering assertion.
      },
      window() {
        return null;
      },
    };
    emitter = ChatV2EventEmitter.withSinkAndBatching(sink, 'test_batch_delivery_lock', true);
    emitter.setChunkWindowOpen(true);
    emitter.emitContentChunk('blk_a', 'tail', null);
    emitter.emitEnd(EVENT_TYPE.CONTENT, 'blk_a', null, null);

    // Rust holds the batcher lock through sink delivery; Node's synchronous
    // analogue is that the pending buffer is already drained when the chunk
    // reaches the sink, and end can only follow it.
    expect(pendingDuringChunk).toBe(0);
    expect(delivered.map(([phase]) => phase)).toEqual([EVENT_PHASE.CHUNK, EVENT_PHASE.END]);
    expect(delivered[1]![1]).toBe(delivered[0]![1] + 1);
  });

  it('chunk_batching_preparing_and_variant_start_are_barriers', () => {
    const { emitter, recorded } = batchingEmitter('test_batch_all_barriers');
    emitter.setChunkWindowOpen(true);
    emitter.emitContentChunk('blk_a', 'one', null);
    emitter.emitToolCallPreparing('msg_1', 'tool_1', 'tool', 'blk_tool');
    emitter.emitContentChunk('blk_a', 'two', null);
    emitter.emitToolCallPreparingWithVariant('msg_1', 'tool_2', 'tool', 'blk_tool_2', 'variant_a');
    emitter.emitContentChunk('blk_a', 'three', null);
    emitter.emitToolCallPreparingWithMeta('msg_1', 'tool_3', 'tool', 'blk_tool_3', 'variant_a', 2, 'round_1');
    emitter.emitContentChunk('blk_a', 'four', null);
    emitter.emitVariantStart('msg_1', 'variant_b', 'model_b');
    expect(recorded).toHaveLength(8);
    for (let index = 0; index < recorded.length; index += 2) {
      expect(recorded[index]![1].phase).toBe(EVENT_PHASE.CHUNK);
      expect(recorded[index + 1]![1].phase).not.toBe(EVENT_PHASE.CHUNK);
      expect(recorded[index + 1]![1].sequenceId).toBe(recorded[index]![1].sequenceId + 1);
    }
  });

  it('chunk_batching_start_event_flushes_pending', () => {
    const { emitter, recorded } = batchingEmitter('test_batch_start_flush');

    emitter.emitChunk(EVENT_TYPE.CONTENT, 'blk_1', 'partial', null);
    emitter.emitStart(EVENT_TYPE.TOOL_CALL, 'msg_1', 'blk_2', null, null);

    expect(recorded).toHaveLength(2);
    expect(recorded[0]![1].phase).toBe('chunk');
    expect(recorded[0]![1].chunk).toBe('partial');
    expect(recorded[1]![1].phase).toBe('start');
  });

  it('chunk_batching_session_event_flushes_pending', () => {
    const { emitter, recorded } = batchingEmitter('test_batch_session_flush');

    emitter.emitChunk(EVENT_TYPE.THINKING, 'blk_1', 'tail', null);
    emitter.emitStreamComplete('msg_1', 10);

    expect(recorded).toHaveLength(1);
    expect(recorded[0]![1].phase).toBe('chunk');
    expect(recorded[0]![1].chunk).toBe('tail');
  });

  it('chunk_batching_cancel_delivers_all_variants_before_terminal_event', () => {
    class OrderedSink implements ExecutionEventSink {
      values: string[] = [];

      emitBlockEvent(_channel: string, event: BackendEventWire): void {
        this.values.push(`${event.variantId!}:${event.chunk!}`);
      }

      emitSessionEvent(_channel: string, event: SessionEventWire): void {
        this.values.push(event.eventType);
      }

      window(): null {
        return null;
      }
    }
    const sink = new OrderedSink();
    const emitter = ChatV2EventEmitter.withSinkAndBatching(sink, 'test_batch_cancel_order', true);
    emitter.setChunkWindowOpen(true);
    emitter.emitContentChunk('blk_a', 'tail-a', 'variant_a');
    emitter.emitThinkingChunk('blk_b', 'tail-b', 'variant_b');
    emitter.emitStreamCancelled('msg_1');
    expect(sink.values).toEqual([
      'variant_a:tail-a',
      'variant_b:tail-b',
      SESSION_EVENT_TYPE.STREAM_CANCELLED,
    ]);
  });

  it('chunk_batching_drop_flushes_pending_tail', () => {
    const { emitter, recorded } = batchingEmitter('test_batch_drop');
    emitter.emitChunk(EVENT_TYPE.CONTENT, 'blk_1', 'orphan', null);
    expect(recorded).toHaveLength(0);
    // Rust flushes from Drop; Node has no deterministic destructor hook, so the
    // emitter's explicit disposal performs the same tail flush.
    emitter.dispose();
    expect(recorded).toHaveLength(1);
    expect(recorded[0]![1].phase).toBe('chunk');
    expect(recorded[0]![1].chunk).toBe('orphan');
    expect(emitter.chunkWindowOpen()).toBe(false);
  });

  it('chunk_batching_non_batchable_type_passes_through_immediately', () => {
    const { emitter, recorded } = batchingEmitter('test_batch_passthrough');

    emitter.emitChunk(EVENT_TYPE.CONTENT, 'blk_1', 'c1', null);
    emitter.emitChunk(EVENT_TYPE.TOOL_CALL_PREPARING, 'blk_2', '{}', null);

    expect(recorded).toHaveLength(2);
    expect(recorded[0]![1].type).toBe(EVENT_TYPE.CONTENT);
    expect(recorded[0]![1].chunk).toBe('c1');
    expect(recorded[1]![1].type).toBe(EVENT_TYPE.TOOL_CALL_PREPARING);
  });

  it('chunk_batching_window_expiry_flushes', () => {
    vi.useFakeTimers();
    const { emitter, recorded } = batchingEmitter('test_batch_window');

    emitter.emitChunk(EVENT_TYPE.CONTENT, 'blk_1', 'slow', null);
    expect(recorded).toHaveLength(0);

    vi.advanceTimersByTime(150);

    expect(recorded).toHaveLength(1);
    expect(recorded[0]![1].chunk).toBe('slow');
  });

  it('chunk_batching_coalesces_many_deltas_into_one', () => {
    const { emitter, recorded } = batchingEmitter('test_batch_count');

    for (let index = 0; index < 50; index += 1) {
      emitter.emitChunk(EVENT_TYPE.CONTENT, 'blk_1', `t${index}`, null);
    }
    emitter.emitEnd(EVENT_TYPE.CONTENT, 'blk_1', null, null);

    expect(recorded).toHaveLength(2);
    const merged = recorded[0]![1].chunk!;
    const expected = Array.from({ length: 50 }, (_, index) => `t${index}`).join('');
    expect(merged).toBe(expected);
  });

  it('chunk_batching_size_cap_flushes_immediately', () => {
    const { emitter, recorded } = batchingEmitter('test_batch_sizecap');

    const big = 'x'.repeat(4097);
    emitter.emitChunk(EVENT_TYPE.CONTENT, 'blk_1', big, null);

    expect(recorded).toHaveLength(1);
    expect(recorded[0]![1].chunk!.length).toBe(big.length);
  });
});
