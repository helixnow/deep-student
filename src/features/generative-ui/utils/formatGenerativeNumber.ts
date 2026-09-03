/**
 * Locale-aware numeric display for generative-ui stat values.
 * The model still sends raw number/string; the renderer formats numbers.
 */

/** Optional +/-, integer or decimal; rejects extras like `12px`, `1e3`, `0x10`. */
const NUMERIC_STRING_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)$/;

function resolveLocale(): string {
  if (typeof navigator !== 'undefined' && navigator.language) {
    return navigator.language;
  }
  return 'en';
}

export function formatGenerativeNumber(value: number, locale?: string): string {
  if (!Number.isFinite(value)) {
    return String(value);
  }
  return new Intl.NumberFormat(locale ?? resolveLocale(), { maximumFractionDigits: 2 }).format(value);
}

export function formatGenerativeStatValue(value: string | number, locale?: string): string {
  if (typeof value === 'number') {
    return formatGenerativeNumber(value, locale);
  }

  const trimmed = value.trim();
  if (NUMERIC_STRING_RE.test(trimmed)) {
    const parsed = Number(trimmed);
    if (Number.isFinite(parsed)) {
      return formatGenerativeNumber(parsed, locale);
    }
  }

  return value;
}
