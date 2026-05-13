import { describe, expect, it } from 'vitest';
import { deriveContextWindowUsage, formatContextTokenAmount } from '../contextWindowUsage';

describe('context window usage helpers', () => {
  it('derives used and remaining context window usage from completed token usage', () => {
    const usage = deriveContextWindowUsage(
      {
        promptTokens: 10_000,
        completionTokens: 2_500,
        totalTokens: 12_500,
        source: 'api',
        lastRoundPromptTokens: 12_500,
      },
      50_000
    );

    expect(usage).toEqual({
      usedTokens: 12_500,
      remainingTokens: 37_500,
      limitTokens: 50_000,
      usedPercent: 25,
      remainingPercent: 75,
      usedLabel: '12.5k',
      remainingLabel: '37.5k',
      source: 'api',
    });
  });

  it('clamps usage when the completed round exceeds the configured context limit', () => {
    const usage = deriveContextWindowUsage(
      {
        promptTokens: 55_000,
        completionTokens: 5_000,
        totalTokens: 60_000,
        source: 'mixed',
        lastRoundPromptTokens: 60_000,
      },
      50_000
    );

    expect(usage?.usedPercent).toBe(100);
    expect(usage?.remainingPercent).toBe(0);
    expect(usage?.remainingTokens).toBe(0);
  });

  it('formats token counts as compact k labels', () => {
    expect(formatContextTokenAmount(999)).toBe('999');
    expect(formatContextTokenAmount(1_000)).toBe('1k');
    expect(formatContextTokenAmount(12_500)).toBe('12.5k');
  });
});
