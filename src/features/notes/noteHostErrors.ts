import i18next from 'i18next';

/**
 * User-visible error text for the note host layer (editor/review/template hosts).
 * Resolved when the error is thrown so it follows the current UI language.
 */
export function noteHostError(key: string, fallback: string): string {
  const text = i18next.t(`notes:host.errors.${key}`, { defaultValue: fallback });
  // Before i18next initializes (early startup, isolated tests) t() yields undefined.
  return typeof text === 'string' && text ? text : fallback;
}
