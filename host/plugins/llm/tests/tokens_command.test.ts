import { describe, expect, it } from 'vitest';
import { createTestHost } from './host.ts';
import plugin from '../index.ts';

describe('commands.rs:316 desktop estimate_tokens', () => {
  it('estimate_tokens_with_model_short_text_matches_exact_encoding through the command contract', async () => {
    const host = await createTestHost({ plugins: [plugin], provide: { settings: {}, secrets: {} } });
    try {
      expect(await host.invoke('estimate_tokens', { request: { texts: ['hello world', '', '<|endoftext|>'] } }))
        .toEqual({ total: 3, per_message: [2, 0, 1], precise: true, tokenizer: 'tiktoken' });
      expect(await host.invoke('estimate_tokens', { request: { texts: ['你好，世界'], model: 'gpt-4o' } }))
        .toEqual({ total: 3, per_message: [3], precise: true, tokenizer: 'tiktoken' });
      expect(await host.invoke('estimate_tokens', { request: { texts: [] } }))
        .toEqual({ total: 0, per_message: [], precise: true, tokenizer: 'tiktoken' });
    } finally { await host.dispose(); }
  });
});
