import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPipelineHost } from './chat-host.ts';
import type { BackendEvent } from '../../chat/api.ts';
let host: Awaited<ReturnType<typeof createPipelineHost>>;
beforeAll(async () => { host = await createPipelineHost(); }, 60_000);
afterAll(async () => { await host?.dispose(); });

describe('shared F4 model-special-tokens through production L03 adapters', () => {
  it('strips_torn_outer_wrappers: content/reasoning own independent filters and reset discards a partial attempt', () => {
    const events: BackendEvent[] = [];
    host.ctx.backendEvents.listen('chat_v2_event_wrap', value => events.push(value as BackendEvent));
    const emitter = host.ctx.chatPipeline.createSessionEventEmitter('wrap', { batching: false });
    const adapter = host.ctx.chatPipeline.createStreamingAdapter(host.ctx.chatPipeline.bindStreamingSink(emitter), 'msg_wrap', {
      enableThinking: true, modelConfig: { providerType: 'openai', model: 'Qwen3' },
    });
    adapter.onContentChunk('<|begin_of_');
    adapter.resetStreamState();
    adapter.onReasoningChunk('<|begin_of_box|>');
    adapter.onReasoningChunk('reasoning');
    adapter.onReasoningChunk('<|end_of_box|>');
    adapter.onContentChunk('<|begin_of_');
    adapter.onContentChunk('box|>answer<|end_of_box|>');
    adapter.onComplete();
    expect(events.filter(e => e.phase === 'chunk' && e.type === 'thinking').map(e => e.chunk).join('')).toBe('reasoning');
    expect(events.filter(e => e.phase === 'chunk' && e.type === 'content').map(e => e.chunk).join('')).toBe('answer');
    emitter.dispose();
  });
  it('disabled_policy_preserves_even_a_token_only_stream: unknown routes keep literal tokens', () => {
    const emitter = host.ctx.chatPipeline.createSessionEventEmitter('wrap_disabled', { batching: false });
    const adapter = host.ctx.chatPipeline.createStreamingAdapter(host.ctx.chatPipeline.bindStreamingSink(emitter), 'msg_literal', {
      enableThinking: false, modelConfig: { providerType: 'openai', model: 'gpt-4o' },
    });
    adapter.onContentChunk('<|begin_of_box|>');
    adapter.onComplete();
    expect(adapter.getAccumulatedContent()).toBe('<|begin_of_box|>');
    emitter.dispose();
  });
  it('strips_torn_outer_wrappers: variant adapter consumes the same shared policy', () => {
    const emitter = host.ctx.chatPipeline.createSessionEventEmitter('wrap_variant', { batching: false });
    const ctx = host.ctx.chatPipeline.createVariantStreamContext(emitter, 'var_wrap', 'GLM-4', 'msg_variant_wrap');
    const adapter = host.ctx.chatPipeline.createVariantStreamingAdapter(ctx, { enableThinking: true,
      modelConfig: { providerScope: 'bigmodel', model: 'custom' } });
    adapter.onReasoningChunk('<|begin_of_box|>think<|end_of_box|>');
    adapter.onContentChunk('<|begin_of_box|>reply<|end_of_box|>');
    adapter.onComplete();
    expect(ctx.getAccumulatedReasoning()).toBe('think');
    expect(ctx.getAccumulatedContent()).toBe('reply');
    emitter.dispose();
  });
});
