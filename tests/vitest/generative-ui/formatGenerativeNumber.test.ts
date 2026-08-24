import { describe, expect, it } from 'vitest';
import {
  formatGenerativeNumber,
  formatGenerativeStatValue,
} from '@/features/generative-ui/utils/formatGenerativeNumber';

function intlFormat(value: number, locale: string): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(value);
}

describe('formatGenerativeNumber', () => {
  it('formats a decimal with an explicit locale via Intl', () => {
    expect(formatGenerativeNumber(1234.5, 'en-US')).toBe(intlFormat(1234.5, 'en-US'));
  });

  it('formats an integer with an explicit locale', () => {
    expect(formatGenerativeNumber(42, 'en-US')).toBe(intlFormat(42, 'en-US'));
  });

  it('falls back to String(value) for NaN and Infinity', () => {
    expect(formatGenerativeNumber(Number.NaN, 'en-US')).toBe(String(Number.NaN));
    expect(formatGenerativeNumber(Number.POSITIVE_INFINITY, 'en-US')).toBe(
      String(Number.POSITIVE_INFINITY),
    );
    expect(formatGenerativeNumber(Number.NEGATIVE_INFINITY, 'en-US')).toBe(
      String(Number.NEGATIVE_INFINITY),
    );
  });
});

describe('formatGenerativeStatValue', () => {
  it('formats numeric values', () => {
    expect(formatGenerativeStatValue(42, 'en-US')).toBe(intlFormat(42, 'en-US'));
    expect(formatGenerativeStatValue(1234.5, 'en-US')).toBe(intlFormat(1234.5, 'en-US'));
  });

  it('leaves a non-numeric string unchanged', () => {
    expect(formatGenerativeStatValue('hello', 'en-US')).toBe('hello');
  });

  it('formats a finite numeric string', () => {
    expect(formatGenerativeStatValue('1000', 'en-US')).toBe(intlFormat(1000, 'en-US'));
  });

  it('does not parse extras like unit suffixes', () => {
    expect(formatGenerativeStatValue('12px', 'en-US')).toBe('12px');
  });

  it('falls back to String(value) for NaN and Infinity numbers', () => {
    expect(formatGenerativeStatValue(Number.NaN, 'en-US')).toBe(String(Number.NaN));
    expect(formatGenerativeStatValue(Number.POSITIVE_INFINITY, 'en-US')).toBe(
      String(Number.POSITIVE_INFINITY),
    );
  });
});
