import { describe, expect, it } from 'vitest';
import {
  authoritativeContentResult, VariantStreamContext, VariantStreamingAdapter,
} from '../src/variant-adapter.ts';

let blockCounter = 0;
function adapterFor(enableThinking: boolean): [VariantStreamingAdapter, VariantStreamContext] {
  const ctx = new VariantStreamContext('var_test', 'model_test', 'msg_variant_test', {
    now: () => 1_000 + blockCounter,
  });
  const adapter = new VariantStreamingAdapter(ctx, {
    enableThinking,
    generateBlockId: () => `blk_variant_${++blockCounter}`,
    now: () => 1_000 + blockCounter,
  });
  return [adapter, ctx];
}

describe('chat_v2/pipeline/variant_adapter.rs::tests', () => {
  it('variant_content_end_result_carries_authoritative_text', () => {
    const result = authoritativeContentResult('complete variant tail');
    expect(result.content).toBe('complete variant tail');
  });

  it('retains_incremental_variant_text_when_adapter_drops_before_complete', () => {
    const [adapter, ctx] = adapterFor(true);
    for (const text of ['hello', ' ', '世界', '!']) adapter.onContentChunk(text);

    const blocks = ctx.getInterleavedBlocks();
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.content).toBe('hello 世界!');
    // No onComplete / finalizeAll: the dropped stream must keep its text.
    expect(ctx.getInterleavedBlocks()[0]!.content).toBe('hello 世界!');
    expect(blocks[0]!.blockIndex).toBe(0);
    expect(ctx.blockIds()).toEqual(ctx.getInterleavedBlockIds());
  });

  it('preserves_real_reasoning_content_alternation_as_distinct_variant_blocks', () => {
    const [adapter, ctx] = adapterFor(true);

    adapter.onReasoningChunk('reasoning-1');
    adapter.onContentChunk('content-1');
    adapter.onReasoningChunk('reasoning-2');
    adapter.onContentChunk('content-2');
    adapter.onComplete();

    const blocks = ctx.getInterleavedBlocks();
    expect(blocks.map(block => [block.blockType, block.content])).toEqual([
      ['thinking', 'reasoning-1'],
      ['content', 'content-1'],
      ['thinking', 'reasoning-2'],
      ['content', 'content-2'],
    ]);
    expect(ctx.blockIds()).toEqual(ctx.getInterleavedBlockIds());
  });

  it('preserves_real_reasoning_content_alternation_as_distinct_variant_blocks: tool hooks and round reset', () => {
    const [adapter, ctx] = adapterFor(true);
    adapter.onToolCallStart('call_1', 'builtin-note_read');
    adapter.onToolCallStart('call_1', 'builtin-note_read');
    expect(ctx.events.filter(event => event.phase === 'start')).toHaveLength(1);
    const delta = '图'.repeat(167); // 501 UTF-8 bytes, less than 500 UTF-16 units.
    adapter.onToolCallArgsDelta('call_1', delta);
    expect(ctx.events.at(-1)).toMatchObject({ phase: 'chunk', chunk: delta });
    adapter.onToolCall({ role: 'assistant', content: '', tool_call: {
      id: 'call_1', tool_name: 'builtin-note_read', args_json: { id: 'note' },
    } });
    expect(adapter.takeToolCalls()).toEqual([
      { id: 'call_1', name: 'builtin-note_read', arguments: { id: 'note' } },
    ]);
    expect(adapter.takeToolCalls()).toEqual([]);
    adapter.onUsage({ prompt_tokens: 12, completion_tokens: 3 });
    expect(ctx.getUsage()).toMatchObject({ promptTokens: 12, completionTokens: 3, totalTokens: 15 });
    adapter.onContentChunk('first');
    adapter.onComplete();
    const firstBlock = ctx.getInterleavedBlocks()[0]!;
    adapter.resetForNewRound();
    adapter.onContentChunk('second');
    adapter.onComplete();
    expect(ctx.getInterleavedBlocks().map(block => block.content)).toEqual(['first', 'second']);
    expect(ctx.getInterleavedBlocks()[1]!.id).not.toBe(firstBlock.id);
  });
});
