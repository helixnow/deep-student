/**
 * Locale-aware calendar-date display for generative-ui values.
 * The model still sends ISO-like strings; the renderer formats YYYY-MM-DD.
 */

const DATE_PREFIX_RE = /^(\d{4})-(\d{2})-(\d{2})/;

function resolveLocale(): string {
  if (typeof navigator !== 'undefined' && navigator.language) {
    return navigator.language;
  }
  return 'en';
}

/** Format a YYYY-MM-DD value (optional time suffix) with Intl medium date style. */
export function formatGenerativeDate(value: string, locale?: string): string {
  const match = DATE_PREFIX_RE.exec(value);
  if (!match) {
    return value;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  // Local date parts avoid TZ shift from UTC-midnight ISO parsing.
  const date = new Date(year, month - 1, day);
  return new Intl.DateTimeFormat(locale ?? resolveLocale(), { dateStyle: 'medium' }).format(date);
}
