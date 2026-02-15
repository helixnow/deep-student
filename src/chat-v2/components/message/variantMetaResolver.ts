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

  // 🔧 三轮修复：优先使用变体的 modelId（来自后端 variant_start，已解析为显示名称），
  // 再回退到 _meta.modelId（可能在消息创建时被设为配置 UUID，后由 stream_start 更新）
  return {
    resolvedModelId: fallbackVariant?.modelId || message._meta?.modelId,
    resolvedUsage: fallbackVariant?.usage ?? message._meta?.usage,
  };
}
