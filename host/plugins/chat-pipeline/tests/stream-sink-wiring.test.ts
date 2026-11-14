import { describe, expect, it } from 'vitest';
import { createPipelineHost } from './chat-host.ts';
import type { BackendEvent } from '../../chat/api.ts';

describe('X5-03/04 production sink binding', () => {
  it('preserves_real_reasoning_content_alternation_as_distinct_blocks: real Host sink keeps metadata and batching', async () => {
    const host = await createPipelineHost();
    try {
      const pipeline = host.ctx.chatPipeline;
      const events: BackendEvent[] = [];
      host.ctx.backendEvents.listen('chat_v2_event_sink_wiring', value => events.push(value as BackendEvent));
      const emitter = pipeline.createSessionEventEmitter('sink_wiring', { streamGeneration: 3 });
      const adapter = pipeline.createStreamingAdapter(pipeline.bindStreamingSink(emitter), 'msg_sink', {
        enableThinking: true, skillStateVersion: 7, roundId: 'round_1',
      });
      adapter.onReasoningChunk('想');
      adapter.onReasoningChunk('一想');
      expect(events.map(e => e.phase)).toEqual(['start']);
      adapter.onContentChunk('中');
      adapter.onContentChunk('文');
      adapter.onComplete();
      expect(events.map(e => [e.type, e.phase])).toEqual([
        ['thinking', 'start'], ['thinking', 'chunk'], ['thinking', 'end'],
        ['content', 'start'], ['content', 'chunk'], ['content', 'end'],
      ]);
      expect(events.filter(e => e.phase === 'chunk').map(e => e.chunk)).toEqual(['想一想', '中文']);
      for (const event of events) {
        expect(event.skillStateVersion).toBe(7);
        expect(event.roundId).toBe('round_1');
        expect(event.variantId).toBeUndefined();
      }
      expect(events.at(-1)!.result).toEqual({ content: '中文' });
      adapter.resetStreamState();
      adapter.onToolCallStart('call_sink', 'builtin-note_read');
      adapter.onToolCallArgsDelta('call_sink', '{"id":"n"}');
      adapter.onToolCall({ role: 'assistant', content: '', tool_call: {
        id: 'call_sink', tool_name: 'builtin-note_read', args_json: { id: 'n' },
      } });
      expect(events.find(e => e.type === 'tool_call_preparing' && e.phase === 'start')).toMatchObject({
        payload: { toolCallId: 'call_sink', toolName: 'builtin-note_read', status: 'preparing' },
        skillStateVersion: 7, roundId: 'round_1',
      });
      expect(events.at(-1)).toMatchObject({ type: 'tool_call_preparing', phase: 'chunk', chunk: '{"id":"n"}' });
      adapter.onContentChunk('partial');
      adapter.onError('provider failed');
      expect(events.at(-1)).toMatchObject({ type: 'content', phase: 'error', error: 'provider failed', roundId: 'round_1' });
      emitter.dispose();
    } finally { await host.dispose(); }
  });

  it('preserves_real_reasoning_content_alternation_as_distinct_variant_blocks: context emits immediately with string variantId', async () => {
    const host = await createPipelineHost();
    try {
      const pipeline = host.ctx.chatPipeline;
      const events: BackendEvent[] = [];
      host.ctx.backendEvents.listen('chat_v2_event_variant_sink', value => events.push(value as BackendEvent));
      const emitter = pipeline.createSessionEventEmitter('variant_sink', { batching: false });
      const ctx = pipeline.createVariantStreamContext(emitter, 'var_1', 'model_1', 'msg_variants');
      const adapter = pipeline.createVariantStreamingAdapter(ctx, { enableThinking: true,
        skillStateVersion: 9, roundId: 'variant_round' });
      emitter.emitVariantStart(ctx.messageId, ctx.variantId, ctx.modelId);
      adapter.onContentChunk('first');
      expect(events.map(e => e.type)).toEqual(['variant_start', 'content', 'content']);
      expect(events.at(-1)!.chunk).toBe('first');
      expect(ctx.getInterleavedBlocks()[0]!.content).toBe('first');
      adapter.onToolCallStart('call_var', 'builtin-note_read');
      adapter.onToolCallArgsDelta('call_var', '图'.repeat(167));
      expect(events.at(-1)).toMatchObject({ variantId: 'var_1', skillStateVersion: 9,
        roundId: 'variant_round', phase: 'chunk', type: 'tool_call_preparing' });
      adapter.onComplete();
      ctx.emitStart('tool_call', 'blk_payload', { value: null });
      expect(events.at(-1)!.payload).toEqual({ value: null });
      ctx.emitError('tool_call', 'blk_payload', 'failed');
      expect(events.at(-1)).toMatchObject({ phase: 'error', error: 'failed', variantId: 'var_1' });
      emitter.emitVariantEnd('var_1', 'error', 'failed', null);
      expect(events.at(-1)).toMatchObject({ type: 'variant_end', status: 'error', variantId: 'var_1' });
      expect(events.every(e => e.variantId === 'var_1')).toBe(true);
      expect(events.map(e => e.sequenceId)).toEqual(events.map((_, index) => index));
      emitter.dispose();
    } finally { await host.dispose(); }
  });
});
