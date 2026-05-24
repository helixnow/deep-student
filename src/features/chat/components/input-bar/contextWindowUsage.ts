import type { TokenUsage } from '../../core/types/common';

export interface ContextWindowUsage {
  usedTokens: number;
  remainingTokens: number;
  limitTokens: number;
  usedPercent: number;
  remainingPercent: number;
  usedLabel: string;
  remainingLabel: string;
  source: TokenUsage['source'];
}

function normalizeTokenCount(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return Math.floor(value);
}

function normalizePercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, Math.round(value)));
}

export function formatContextTokenAmount(count: number): string {
  const normalized = normalizeTokenCount(count);
  if (normalized < 1000) return String(normalized);

  const value = normalized / 1000;
  const formatted = Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1);
  return `${formatted}k`;
}

export function deriveContextWindowUsage(
  usage: TokenUsage | undefined,
  limitTokens: number | undefined
): ContextWindowUsage | null {
  const limit = normalizeTokenCount(limitTokens);
  if (!usage || limit <= 0) return null;

  const used = normalizeTokenCount(
    usage.lastRoundPromptTokens ?? usage.promptTokens + usage.completionTokens
  );
  if (used <= 0) return null;

  const remaining = Math.max(0, limit - used);
  const usedPercent = normalizePercent((used / limit) * 100);
  const remainingPercent = normalizePercent(100 - usedPercent);

  return {
    usedTokens: used,
    remainingTokens: remaining,
    limitTokens: limit,
    usedPercent,
    remainingPercent,
    usedLabel: formatContextTokenAmount(used),
    remainingLabel: formatContextTokenAmount(remaining),
    source: usage.source,
  };
}
