import { describe, expect, it } from 'vitest';
import { createTestHost } from './host.ts';
import plugin from '../index.ts';
import type { LlmStreamHooks } from '../api.ts';

describe('model2 stream event production service', () => {
  it('uses replacement hooks for actual deltas and preserves tool starts, argument deltas and completion parsing', async () => {
    const host = await createTestHost({ plugins: [plugin], provide: { settings: {}, secrets: {} } });
    try {
      const received: unknown[] = [];
      const old: LlmStreamHooks = { onContentChunk: text => received.push(['old', text]) };
      const replacement: LlmStreamHooks = { onContentChunk: text => received.push(['new', text]),
        onToolCallStart: (id, name) => received.push(['start', id, name]),
        onToolCallArgsDelta: (id, delta) => received.push(['args', id, delta]) };
      const service = host.ctx.llmStreamEvents;
      service.registerStreamHooks('s', old);
      const collector = service.create({ streamEvent: 's', requestId: 'r', sink: { emit: (name, payload) => received.push([name, payload]) }, requireTerminalSuccess: false, isCodex: false });
      collector.dispatch([{ type: 'ContentChunk', value: 'one' }]);
      service.registerStreamHooks('s', replacement);
      expect(service.unregisterStreamHooksIfOwner('s', old)).toBe(false);
      collector.dispatch([{ type: 'ContentChunk', value: 'two' },
        { type: 'ToolCall', value: { index: 0, id: 'call', function: { name: 'lookup', arguments: '' } } },
        { type: 'ToolCall', value: { index: 0, function: { arguments: '  ' } } }, { type: 'Done' }]);
      expect(received).toEqual([['old', 'one'], ['new', 'two'], ['start', 'call', 'lookup'], ['args', 'call', '  ']]);
      expect(collector.snapshot()).toMatchObject({ content: 'onetwo', terminalSuccess: true,
        toolCalls: [{ id: 'call', tool_name: 'lookup', args_json: {} }] });
      expect(service.unregisterStreamHooksIfOwner('s', replacement)).toBe(true);
    } finally { await host.dispose(); }
  });

  it('keeps malformed authoring arguments as truncation markers and emits legacy usage/search/safety events', async () => {
    const host = await createTestHost({ plugins: [plugin], provide: { settings: {}, secrets: {} } });
    try {
      const events: unknown[] = [];
      const collector = host.ctx.llmStreamEvents.create({ streamEvent: 'events', requestId: 'r', sink: { emit: (name, value) => events.push([name, value]) }, requireTerminalSuccess: true, isCodex: false });
      collector.dispatch([{ type: 'ReasoningChunk', value: 'think' }, { type: 'ContentChunk', value: 'text' },
        { type: 'ToolCall', value: { index: 3, function: { name: 'qbank_batch_import', arguments: '{"questions":[' } } },
        { type: 'ToolCall', value: { index: 4, function: { name: 'lookup', arguments: '{"q":"complete"' } } },
        { type: 'Usage', value: { prompt_tokens: 10 } },
        { type: 'WebSearchCall', value: { stage: 'completed', sources: [] } },
        { type: 'SafetyBlocked', value: { type: 'provider_error', message: 'quota' } }]);
      collector.finishPending();
      expect(collector.snapshot()).toMatchObject({ ended: true, usage: { prompt_tokens: 10 },
        toolCalls: [{ id: 'stream_call_3', tool_name: 'qbank_batch_import', args_json: { _truncation_error: true } },
          { id: 'stream_call_4', tool_name: 'lookup', args_json: { q: 'complete' } }] });
      expect(events).toContainEqual(['events_reasoning', { content: 'think', is_complete: false, chunk_id: 'r_reasoning_chunk_0' }]);
      expect(events).toContainEqual(['events', { content: 'text', is_complete: false, chunk_id: 'r_chunk_1' }]);
      expect(events).toContainEqual(['events_web_search', { sources: [], stage: 'completed', tool_name: 'web_search' }]);
      expect(events).toContainEqual(['events_error', { type: 'provider_error', message: 'LLM provider reported a stream failure', details: { type: 'provider_error', message: 'quota' } }]);
    } finally { await host.dispose(); }
  });
});
