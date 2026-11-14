import { describe, expect, it } from 'vitest';
import { streamTranslate } from '../src/transport.ts';
import type { ApiConfig } from '../../llm/api.ts';

describe('translation pipeline model wrap-token outlet', () => {
  for (const done of [true, false]) {
    it(`filters split wrappers and flushes text on ${done ? 'Done' : 'Incomplete'}`, async () => {
      const chunks: string[] = [];
      const frames = ['<|im_', 'start|>assistant\n', '译文', '<|im_end|>'];
      const config = { id: 'wrap', name: 'wrap', model: 'Qwen3', providerType: 'qwen', providerScope: 'qwen',
        apiProtocol: 'openai_chat_completions', baseUrl: 'https://provider.invalid/v1', modelAdapter: 'general',
        maxOutputTokens: 8192, maxTokensLimit: null, temperature: 0.7, headers: null,
        reasoningEffort: null, verbosity: null, thinkingBudget: null, enableThinking: null,
        thinkingEnabled: false, supportsReasoning: false, isReasoning: false } as ApiConfig;
      const status = await streamTranslate({ config, apiKey: 'key',
        systemPrompt: 'translate', userPrompt: 'text', streamEvent: 'wrap', onChunk: text => chunks.push(text),
        control: { consumePendingCancel: async () => false, subscribeCancelStream: async () => new AbortController().signal,
          clearCancelStream: async () => {}, clearCancelArtifacts: async () => {} },
        runtime: { now: Date.now, sleep: async () => {}, fetch: async () => new Response(
          frames.map(content => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`).join('') + (done ? 'data: [DONE]\n\n' : '')) },
      });
      expect(status).toBe(done ? 'completed' : 'incomplete');
      expect(chunks.join('')).toBe('译文');
      expect(chunks.every(Boolean)).toBe(true);
    });
  }
});
