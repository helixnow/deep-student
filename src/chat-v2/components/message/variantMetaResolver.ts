import type { Message, Variant } from '@/chat-v2/core/types/message';
import type { TokenUsage } from '@/chat-v2/core/types/common';

export interface SingleVariantDisplayMeta {
  resolvedModelId?: string;
  resolvedUsage?: TokenUsage;
}

export function resolveSingleVariantDisplayMeta(
  message: Message | undefined,
  variants: Variant[]
): SingleVariantDisplayMeta {
  if (!message) {
    return {};
  }

  const fallbackVariant =
    variants.find((v) => v.id === message.activeVariantId) ?? variants[0];

  return {
    resolvedModelId: message._meta?.modelId ?? fallbackVariant?.modelId,
    resolvedUsage: message._meta?.usage ?? fallbackVariant?.usage,
  };
}
