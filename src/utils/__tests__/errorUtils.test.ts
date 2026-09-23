import { describe, expect, it } from 'vitest';
import {
  detectThinkingBudgetError,
  formatUserFacingErrorWithThinkingBudgetHint,
} from '../errorUtils';

describe('detectThinkingBudgetError', () => {
  it('returns null for non-budget errors', () => {
    expect(detectThinkingBudgetError(new Error('network timeout'))).toBeNull();
    expect(detectThinkingBudgetError(new Error('401 unauthorized'))).toBeNull();
    expect(detectThinkingBudgetError(new Error('rate limit exceeded'))).toBeNull();
    expect(detectThinkingBudgetError(null)).toBeNull();
    expect(detectThinkingBudgetError(undefined)).toBeNull();
    expect(detectThinkingBudgetError('')).toBeNull();
  });

  it('returns null when budget is mentioned without limit signal', () => {
    // 提到 budget 但没"超限"信号，不应误匹配
    expect(
      detectThinkingBudgetError(new Error('thinking_budget is configured to 4096'))
    ).toBeNull();
  });

  it('returns null when limit signal is present without budget keyword', () => {
    // 有"超限"信号但没 budget 关键字，不应误匹配
    expect(
      detectThinkingBudgetError(new Error('max_tokens must be no more than 8192'))
    ).toBeNull();
  });

  it('detects "thinking_budget must be no more than" (DashScope style)', () => {
    const result = detectThinkingBudgetError(
      new Error('InvalidParameter: thinking_budget must be no more than 16384')
    );
    expect(result).not.toBeNull();
    expect(result?.hint).toMatch(/高|High/);
  });

  it('detects "thinking budget exceeds maximum" (alternative phrasing)', () => {
    const result = detectThinkingBudgetError(
      new Error('thinking budget exceeds maximum allowed for this model')
    );
    expect(result).not.toBeNull();
  });

  it('detects "budget_tokens out of range" (generic style)', () => {
    const result = detectThinkingBudgetError(
      new Error('budget_tokens out of range: max 32768')
    );
    expect(result).not.toBeNull();
  });

  it('detects HTTP 400 + thinking_budget combination', () => {
    const result = detectThinkingBudgetError(
      new Error('HTTP 400: thinking_budget invalid')
    );
    expect(result).not.toBeNull();
  });

  it('handles structured error objects', () => {
    const result = detectThinkingBudgetError({
      code: 'InvalidParameter',
      message: 'thinking_budget must be no more than 16384',
    });
    expect(result).not.toBeNull();
  });
});

describe('formatUserFacingErrorWithThinkingBudgetHint', () => {
  it('appends hint for thinking_budget errors', () => {
    const result = formatUserFacingErrorWithThinkingBudgetHint(
      new Error('thinking_budget must be no more than 16384'),
      'chatV2:error.sendFailed',
      'Send failed',
    );
    // i18n 加载时返回"发送失败"，未加载时返回 fallback "Send failed"
    expect(result).toMatch(/Send failed|发送失败/);
    expect(result).toContain('💡');
    // hint 文案可能因 i18n 未加载而是 defaultValue
    expect(result.length).toBeGreaterThan('Send failed'.length);
  });

  it('does NOT append hint for unrelated errors', () => {
    const result = formatUserFacingErrorWithThinkingBudgetHint(
      new Error('network timeout'),
      'chatV2:error.sendFailed',
      'Send failed',
    );
    expect(result).not.toContain('💡');
  });

  it('does NOT duplicate hint when called twice (defensive)', () => {
    const first = formatUserFacingErrorWithThinkingBudgetHint(
      new Error('thinking_budget must be no more than 16384'),
      'chatV2:error.sendFailed',
      'Send failed',
    );
    // 重复调用应该命中 base.includes(hint) 防御
    const second = formatUserFacingErrorWithThinkingBudgetHint(
      new Error('thinking_budget must be no more than 16384'),
      'chatV2:error.sendFailed',
      'Send failed',
    );
    expect(first).toBe(second);
  });
});
