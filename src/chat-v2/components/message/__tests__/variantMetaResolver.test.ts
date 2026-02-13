import { describe, expect, it } from 'vitest';
import { resolveSingleVariantDisplayMeta } from '../variantMetaResolver';
import type { Message, Variant } from '@/chat-v2/core/types/message';
import type { TokenUsage } from '@/chat-v2/core/types/common';

function createUsage(totalTokens: number): TokenUsage {
  return {
    promptTokens: totalTokens / 2,
    completionTokens: totalTokens / 2,
    totalTokens,
    source: 'api',
  };
}

function createVariant(partial?: Partial<Variant>): Variant {
  return {
    id: 'var_1',
    modelId: 'openai/gpt-4o-mini',
    blockIds: [],
    status: 'success',
    createdAt: Date.now(),
    ...partial,
  };
}

function createMessage(partial?: Partial<Message>): Message {
  return {
    id: 'msg_1',
    role: 'assistant',
    blockIds: [],
    timestamp: Date.now(),
    ...partial,
  };
}

describe('resolveSingleVariantDisplayMeta', () => {
  it('fallbacks to single variant usage and model when meta is empty', () => {
    const variant = createVariant({ usage: createUsage(120) });
    const message = createMessage({
      _meta: undefined,
      variants: [variant],
      activeVariantId: variant.id,
    });

    const resolved = resolveSingleVariantDisplayMeta(message, [variant]);

    expect(resolved.resolvedModelId).toBe('openai/gpt-4o-mini');
    expect(resolved.resolvedUsage?.totalTokens).toBe(120);
  });

  it('prefers message meta when present', () => {
    const variant = createVariant({ usage: createUsage(50) });
    const message = createMessage({
      _meta: {
        modelId: 'anthropic/claude-sonnet',
        usage: createUsage(300),
      },
      variants: [variant],
      activeVariantId: variant.id,
    });

    const resolved = resolveSingleVariantDisplayMeta(message, [variant]);

    expect(resolved.resolvedModelId).toBe('anthropic/claude-sonnet');
    expect(resolved.resolvedUsage?.totalTokens).toBe(300);
  });
});
