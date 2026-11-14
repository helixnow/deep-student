import { expectTypeOf, it } from 'vitest';
import type { WindowRef } from '../../../kernel/api.ts';
import type { ChatV2Emitter, ChatV2State } from '../../chat/api.ts';
import type { ChatPipelineExecution, CompactionOutcome, PipelineSendRequest, SendPipelinePort } from '../api.ts';

// Interface-first consumer checks, not runtime parity or a ported Rust test.
// Catch parameter-order/nullability/result drift while L04/L05/L06 wire their callers.
it('publishes the Rust send and headless calling conventions without replacing the cancellation token', () => {
  expectTypeOf<Parameters<SendPipelinePort['execute']>>().toEqualTypeOf<[
    WindowRef, PipelineSendRequest, AbortSignal, ChatV2State | null,
  ]>();
  expectTypeOf<ReturnType<SendPipelinePort['execute']>>().toEqualTypeOf<Promise<string>>();
  expectTypeOf<Parameters<ChatPipelineExecution['executeWithEmitter']>>().toEqualTypeOf<[
    ChatV2Emitter, PipelineSendRequest, AbortSignal, ChatV2State | null,
  ]>();
  expectTypeOf<ChatPipelineExecution['executeWithExistingUser']>().toEqualTypeOf<SendPipelinePort['execute']>();
});

it('preserves explicit multi-variant model IDs and nullable manual-compaction controls', () => {
  expectTypeOf<Parameters<ChatPipelineExecution['executeMultiVariant']>>().toEqualTypeOf<[
    WindowRef, PipelineSendRequest, string[], AbortSignal, ChatV2State | null,
  ]>();
  expectTypeOf<ReturnType<ChatPipelineExecution['executeVariantRetry']>>().toEqualTypeOf<Promise<void>>();
  expectTypeOf<Parameters<ChatPipelineExecution['runCompactionForSession']>>().toEqualTypeOf<[
    string, string | null, string, string[], number | null, boolean | null, AbortSignal | null,
  ]>();
  expectTypeOf<ReturnType<ChatPipelineExecution['runCompactionForSession']>>().toEqualTypeOf<Promise<CompactionOutcome>>();
});
