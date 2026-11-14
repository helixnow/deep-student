import { expect, expectTypeOf, it } from 'vitest';
import type { Context } from '@deepseek-ai/cordis';
import {
  llmAdaptersService, llmCodexAuthService, llmMultimodalService, llmOcrService,
  type LlmAdapterService, type LlmCodexAuthService, type LlmMultimodalService, type LlmOcrService,
  type ProviderAdapter, type StreamEvent,
} from '../api.ts';

it('publishes the StreamEvent/ProviderAdapter Cordis boundary', () => {
  expectTypeOf<Context['llmAdapters']>().toEqualTypeOf<LlmAdapterService>();
  expectTypeOf<Context['llmOcr']>().toEqualTypeOf<LlmOcrService>();
  expectTypeOf<Context['llmMultimodal']>().toEqualTypeOf<LlmMultimodalService>();
  expectTypeOf<Context['llmCodexAuth']>().toEqualTypeOf<LlmCodexAuthService>();
  expectTypeOf<ReturnType<ProviderAdapter['parseStream']>>().toEqualTypeOf<StreamEvent[]>();
  expectTypeOf<{ type: 'Done' }>().toExtend<StreamEvent>();
  expectTypeOf<{ type: 'ReasoningChunk'; value: string }>().toExtend<StreamEvent>();
});

it('exports lowerCamelCase service descriptors', () => {
  expect(llmAdaptersService).toEqual({ name: 'llmAdapters', version: '1.0.0' });
  expect(llmOcrService).toEqual({ name: 'llmOcr', version: '1.0.0' });
  expect(llmMultimodalService).toEqual({ name: 'llmMultimodal', version: '1.0.0' });
  expect(llmCodexAuthService).toEqual({ name: 'llmCodexAuth', version: '1.0.0' });
});
