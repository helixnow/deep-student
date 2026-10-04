import { describe, expect, it } from 'vitest';
import { toGradingResponseLanguage } from './responseLanguage';

describe('toGradingResponseLanguage', () => {
  it('maps English UI locales to en-US', () => {
    expect(toGradingResponseLanguage('en-US')).toBe('en-US');
    expect(toGradingResponseLanguage('en')).toBe('en-US');
    expect(toGradingResponseLanguage('EN-gb')).toBe('en-US');
  });

  it('maps Chinese and unknown locales to zh-CN (legacy default)', () => {
    expect(toGradingResponseLanguage('zh-CN')).toBe('zh-CN');
    expect(toGradingResponseLanguage('zh')).toBe('zh-CN');
    expect(toGradingResponseLanguage(undefined)).toBe('zh-CN');
    expect(toGradingResponseLanguage('')).toBe('zh-CN');
  });
});
