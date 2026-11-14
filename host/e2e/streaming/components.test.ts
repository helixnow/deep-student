import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestHost } from '../../kernel/testing.ts';
import {
  BackendEventsSink, ChatV2Emitter, clearSessionSequenceCounter, EVENT_PHASE, EVENT_TYPE, SESSION_EVENT_TYPE,
} from '../../plugins/chat/api.ts';
import type { StreamEventSink } from '../../plugins/chat-pipeline/api.ts';
import { streamingHost } from './__fixtures__/host.ts';

describe('X5 reachable components (production sink binding; not the missing production tool loop)', () => {
  let fixture: Awaited<ReturnType<typeof streamingHost>>;
  let serial = 0;
  beforeAll(async () => { fixture = await streamingHost(); }, 60_000);
  afterAll(async () => { await fixture?.dispose(); });

  function setup() {
    const host = fixture.host;
    host.events.length = 0;
    const session = `sess_components_${++serial}`;
    let block = 0;
    const emitter = host.ctx.chatPipeline.createSessionEventEmitter(session, { streamGeneration: 7 });
    const adapter = host.ctx.chatPipeline.createStreamingAdapter(host.ctx.chatPipeline.bindStreamingSink(emitter), 'msg_x5', {
      enableThinking: true, skillStateVersion: 3, roundId: 'round_x5', generateBlockId: () => `blk_${++block}`,
    });
    const wire = () => JSON.parse(JSON.stringify(host.events)) as typeof host.events;
    const payloads = () => wire().map(e => e.payload as Record<string, any>);
    const labels = () => payloads().map(p => p.eventType ?? `${p.type}:${p.phase}`);
    const finish = () => { emitter.dispose(); clearSessionSequenceCounter(session); };
    return { host, session, emitter, adapter, wire, payloads, labels, finish };
  }

  it('content: Rust channel names, exact JSON fields, batching, independent sequence counters and terminal flush', () => {
    const f = setup();
    try {
      f.emitter.emitStreamStart('msg_x5', 'model_x5');
      f.adapter.onContentChunk('固定'); f.adapter.onContentChunk('回答'); f.adapter.onComplete();
      f.emitter.emitStreamComplete('msg_x5', 12);
      expect(f.labels()).toEqual(['stream_start', 'content:start', 'content:chunk', 'content:end', 'stream_complete']);
      const p = f.payloads();
      expect(p[0]).toEqual({ sessionId: f.session, eventType: 'stream_start', messageId: 'msg_x5',
        modelId: 'model_x5', timestamp: expect.any(Number), streamGeneration: 7, sequenceId: 0 });
      const base = { sessionId: f.session, skillStateVersion: 3, roundId: 'round_x5' };
      expect(p[1]).toEqual({ ...base, sequenceId: 0, type: 'content', phase: 'start', messageId: 'msg_x5', blockId: 'blk_1' });
      expect(p[2]).toEqual({ ...base, sequenceId: 1, type: 'content', phase: 'chunk', blockId: 'blk_1', chunk: '固定回答' });
      expect(p[3]).toEqual({ ...base, sequenceId: 2, type: 'content', phase: 'end', blockId: 'blk_1', result: { content: '固定回答' } });
      expect(p[4]).toEqual({ sessionId: f.session, eventType: 'stream_complete', messageId: 'msg_x5', durationMs: 12,
        timestamp: expect.any(Number), streamGeneration: 7, sequenceId: 1 });
      expect(f.wire().map(e => e.event)).toEqual([
        `chat_v2_session_${f.session}`, ...Array(3).fill(`chat_v2_event_${f.session}`), `chat_v2_session_${f.session}`,
      ]);
    } finally { f.finish(); }
  });

  it('reasoning/content alternation closes each segment before the next start', () => {
    const f = setup();
    try {
      f.adapter.onReasoningChunk('分析一'); f.adapter.onContentChunk('回答一');
      f.adapter.onReasoningChunk('分析二'); f.adapter.onContentChunk('回答二'); f.adapter.onComplete();
      expect(f.labels()).toEqual(['thinking', 'content', 'thinking', 'content'].flatMap(type =>
        [`${type}:start`, `${type}:chunk`, `${type}:end`]));
      expect(f.payloads().filter(p => p.type === 'content' && p.phase === 'end').map(p => p.result))
        .toEqual([{ content: '回答一' }, { content: '回答二' }]);
      expect(f.payloads().every((p, i) => p.sequenceId === i && p.skillStateVersion === 3 && p.roundId === 'round_x5')).toBe(true);
    } finally { f.finish(); }
  });

  it('tool preparation/collection is real; execution and second LLM round remain BLOCKED', () => {
    const f = setup();
    try {
      f.adapter.onToolCallStart('call_x5', 'builtin-read_file');
      f.adapter.onToolCallArgsDelta('call_x5', '{"path":"a"}');
      f.adapter.onToolCall({ role: 'assistant', content: '', tool_call: {
        id: 'call_x5', tool_name: 'builtin-read_file', args_json: { path: 'a' },
      } });
      expect(f.labels()).toEqual(['tool_call_preparing:start', 'tool_call_preparing:chunk']);
      expect(f.payloads()[0]).toMatchObject({ messageId: 'msg_x5', blockId: 'blk_1',
        payload: { toolCallId: 'call_x5', toolName: 'builtin-read_file', status: 'preparing' } });
      expect(f.payloads()[1]).toMatchObject({ chunk: '{"path":"a"}' });
      expect(f.adapter.takeToolCalls()).toEqual([{ id: 'call_x5', name: 'builtin-read_file', arguments: { path: 'a' } }]);
      expect(f.adapter.takeToolCalls()).toEqual([]);
    } finally { f.finish(); }
  });

  it('error closes active content with error; emitter flushes before stream_error, without success', () => {
    const f = setup();
    try {
      f.emitter.emitStreamStart('msg_x5', null); f.adapter.onContentChunk('部分'); f.adapter.onError('X5 error');
      f.emitter.emitStreamErrorWithDetails('msg_x5', 'X5 error', 'CONTEXT_WINDOW_EXCEEDED', { limit: 10 });
      expect(f.labels()).toEqual(['stream_start', 'content:start', 'content:chunk', 'content:error', 'stream_error']);
      expect(f.payloads()[3]).toMatchObject({ error: 'X5 error', blockId: 'blk_1' });
      expect(f.payloads()[4]).toMatchObject({ error: 'X5 error', payload: { code: 'CONTEXT_WINDOW_EXCEEDED', details: { limit: 10 } } });
      expect(f.adapter.getAccumulatedContent()).toBe('部分');
    } finally { f.finish(); }
  });

  it('real L02 cancellation registry aborts and emitter flushes partial content before cancellation', async () => {
    const f = setup();
    try {
      const signal = await f.host.ctx.llm.subscribeCancelStream(`chat_v2_event_${f.session}`);
      f.emitter.emitStreamStart('msg_x5', null); f.adapter.onContentChunk('取消前');
      await f.host.ctx.llm.requestCancelStream(`chat_v2_event_${f.session}`);
      expect(signal.aborted).toBe(true);
      // The Rust cancelled branch does not promise an end for every open block.
      // This explicit emitter call tests serialization/flush, NOT production cancellation wiring.
      f.emitter.emitStreamCancelled('msg_x5');
      expect(f.labels()).toEqual(['stream_start', 'content:start', 'content:chunk', 'stream_cancelled']);
      expect(f.payloads()[2]).toMatchObject({ chunk: '取消前' });
      expect(f.payloads()[3]).not.toHaveProperty('error');
      await f.host.ctx.llm.clearCancelArtifacts(`chat_v2_event_${f.session}`);
    } finally { f.finish(); }
  });

  it('reconnect/reset clears adapter accumulators and carries retry progress (not an automatic retry test)', () => {
    const f = setup();
    try {
      f.emitter.emitStreamStart('msg_x5', null); f.emitter.emitStreamReconnect('msg_x5', 1, 3);
      f.adapter.onUsage({ prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 });
      f.adapter.resetStreamState();
      expect(f.adapter.getApiUsage()).toBeNull();
      expect(f.adapter.getAccumulatedContent()).toBe('');
      f.adapter.onContentChunk('重试'); f.adapter.onComplete(); f.emitter.emitStreamComplete('msg_x5', 5);
      expect(f.labels()).toEqual(['stream_start', 'stream_reconnect', 'content:start', 'content:chunk', 'content:end', 'stream_complete']);
      expect(f.payloads()[1]).toMatchObject({ retryAttempt: 1, retryMax: 3, streamGeneration: 7, sequenceId: 1 });
    } finally { f.finish(); }
  });

  it('X5-03 variant production context emits immediately, brackets blocks and carries terminal usage', () => {
    const f = setup();
    try {
      const usage = { promptTokens: 2, completionTokens: 3, totalTokens: 5, source: 'api' as const };
      f.emitter.emitStreamStart('msg_x5', null); f.emitter.emitVariantStart('msg_x5', 'var_x5', 'model_x5');
      const context = f.host.ctx.chatPipeline.createVariantStreamContext(f.emitter, 'var_x5', 'model_x5', 'msg_x5');
      const adapter = f.host.ctx.chatPipeline.createVariantStreamingAdapter(context, {
        enableThinking: true, generateBlockId: () => 'blk_variant',
      });
      adapter.onContentChunk('变体');
      // No diagnostic events-array replay. The production context emits before completion.
      expect(f.labels()).toEqual(['stream_start', 'variant_start:start', 'content:start']);
      expect(context.getInterleavedBlocks()[0]?.content).toBe('变体');
      adapter.onComplete();
      f.emitter.emitVariantEnd('var_x5', 'success', null, usage);
      f.emitter.emitStreamCompleteWithUsage('msg_x5', 12, usage);
      expect(f.labels()).toEqual(['stream_start', 'variant_start:start', 'content:start', 'content:chunk',
        'content:end', 'variant_end:end', 'stream_complete']);
      expect(f.payloads().slice(1, -1).every(p => p.variantId === 'var_x5')).toBe(true);
      expect(f.payloads()[5]).toMatchObject({ status: 'success', usage });
      expect(f.payloads()[6]).toMatchObject({ usage });
    } finally { f.finish(); }
  });

  it('reproduces the unbound L03/L04 public sink mismatch rather than hiding it with test wiring', () => {
    const f = setup();
    try {
      const direct = f.host.ctx.chatPipeline.createStreamingAdapter(f.emitter as unknown as StreamEventSink, 'msg_x5', {
        enableThinking: true, skillStateVersion: 3, roundId: 'round_x5', generateBlockId: () => 'blk_direct',
      });
      direct.onContentChunk('direct');
      expect(f.payloads()[0]?.variantId).toEqual({ skillStateVersion: 3, roundId: 'round_x5' });
      expect(f.payloads()[0]).not.toHaveProperty('skillStateVersion');
      expect(() => direct.onToolCallStart('call_direct', 'builtin-read_file'))
        .toThrow(/emitToolCallPreparingStart/);
    } finally { f.finish(); }
  });

  it('X5-05 retry reset must reset the monotonic idle clock, like Rust touch_activity', () => {
    const f = setup();
    try {
      let monotonic = 100;
      let wall = 1_800_000_000_000;
      const adapter = fixture.host.ctx.chatPipeline.createStreamingAdapter(
        fixture.host.ctx.chatPipeline.bindStreamingSink(f.emitter),
        'msg_clock', { enableThinking: true, now: () => wall, elapsed: () => monotonic });
      adapter.resetStreamState();
      monotonic += 51;
      // Preserve the original Rust contract; the repaired production code must pass normally.
      expect(adapter.idleElapsedMs()).toBe(51);
      wall -= 1_000_000;
      expect(adapter.idleElapsedMs()).toBe(51);
      adapter.onContentChunk('x');
      monotonic += 20;
      expect(adapter.idleElapsedMs()).toBe(20);
    } finally { f.finish(); }
  });
});

it('publishes 36 distinct event names and 4 phases', () => {
  const names = [...Object.values(EVENT_TYPE), ...Object.values(SESSION_EVENT_TYPE)];
  expect(names).toHaveLength(36);
  expect(new Set(Object.values(EVENT_TYPE)).size).toBe(Object.keys(EVENT_TYPE).length);
  expect(new Set(Object.values(SESSION_EVENT_TYPE)).size).toBe(Object.keys(SESSION_EVENT_TYPE).length);
  expect(Object.keys(EVENT_PHASE)).toHaveLength(4);
});

it('structured tool result survives Host JSON transport unchanged, including explicit null', async () => {
  const host = await createTestHost();
  const emitter = new ChatV2Emitter(new BackendEventsSink(host.ctx.backendEvents), 'sess_tool_wire');
  try {
    emitter.emitToolCallStart('msg_x5', 'blk_tool', 'builtin-web_search', { query: '固定' }, null, null);
    emitter.emitEnd('tool_call', 'blk_tool', { ok: true, output: null }, null);
    const wire = JSON.parse(JSON.stringify(host.events));
    expect(wire[0].payload.payload).toEqual({ toolName: 'builtin-web_search', toolInput: { query: '固定' }, toolCallId: null });
    expect(wire[1].payload.result).toEqual({ ok: true, output: null });
  } finally { emitter.dispose(); clearSessionSequenceCounter('sess_tool_wire'); await host.dispose(); }
});
