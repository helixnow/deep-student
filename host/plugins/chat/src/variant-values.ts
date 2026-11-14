/** Rust types.rs Variant, SharedContext and ChatMessage inherent operations. */
import { now } from '../../../platform/time/index.ts';
import type { ChatMessage, SharedContext, TokenUsage, Variant } from '../api.ts';
import { getVariant } from './variant-actions.ts';

export function generateVariantId(): string { return `var_${globalThis.crypto.randomUUID()}`; }
export function newVariant(modelId: string, configId: string | null = null, id?: string): Variant {
  return { id: id ?? generateVariantId(), modelId, ...(configId === null ? {} : { configId }),
    blockIds: [], status: 'pending', createdAt: now().millis };
}
export function setVariantStreaming(variant: Variant): void { variant.status = 'streaming'; }
export function setVariantSuccess(variant: Variant): void { variant.status = 'success'; }
export function setVariantError(variant: Variant, error: string): void { variant.status = 'error'; variant.error = error; }
export function setVariantCancelled(variant: Variant): void { variant.status = 'cancelled'; }
export function setVariantInterrupted(variant: Variant, error: string): void { variant.status = 'interrupted'; variant.error = error; }
export function canContinueVariant(variant: Variant): boolean { return variant.status === 'interrupted'; }
export function isVariantTerminal(variant: Variant): boolean { return ['success', 'error', 'cancelled', 'interrupted'].includes(variant.status); }
export function variantWithUsage(variant: Variant, usage: TokenUsage): Variant { return { ...variant, usage }; }
export function setVariantUsage(variant: Variant, usage: TokenUsage): void { variant.usage = usage; }
export function getVariantUsage(variant: Variant): TokenUsage | null { return variant.usage ?? null; }
export function addVariantBlock(variant: Variant, blockId: string): void { variant.blockIds.push(blockId); }
export function newSharedContext(): SharedContext { return {}; }
export function sharedContextHasSources(context: SharedContext): boolean {
  const keys = ['ragSources', 'memorySources', 'graphSources', 'webSearchSources', 'multimodalSources'] as const;
  return keys.some(key => (context[key]?.length ?? 0) > 0);
}
export function isMultiVariant(message: ChatMessage): boolean { return (message.variants?.length ?? 0) > 1; }
export function getActiveBlockIds(message: ChatMessage): string[] {
  return message.activeVariantId == null ? message.blockIds : getVariant(message, message.activeVariantId)?.blockIds ?? message.blockIds;
}
export function addVariant(message: ChatMessage, variant: Variant): void { (message.variants ??= []).push(variant); }
export function variantCount(message: ChatMessage): number { return message.variants?.length ?? 0; }
export function removeVariant(message: ChatMessage, variantId: string): boolean {
  if (message.variants == null) return false;
  const before = message.variants.length;
  message.variants = message.variants.filter(variant => variant.id !== variantId);
  return message.variants.length < before;
}
export function selectBestActiveVariant(message: ChatMessage): void {
  const variants = message.variants ?? [];
  const best = variants.find(variant => variant.status === 'success')
    ?? variants.find(variant => variant.status === 'cancelled') ?? variants[0];
  if (best !== undefined) message.activeVariantId = best.id;
}
