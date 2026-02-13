/**
 * i18n utility for non-component code (hooks, stores, services)
 *
 * Since hooks and stores cannot use useTranslation hook directly,
 * this utility provides a way to get translations in non-React contexts.
 */

import i18n from '../i18n';

/**
 * Get translation for a key
 * @param key - Translation key (e.g., 'errors.unknown', 'status.completed')
 * @param options - Interpolation options
 * @param ns - Namespace (default: 'common')
 */
export function t(key: string, options?: Record<string, unknown>, ns = 'common'): string {
  return i18n.t(key, { ns, ...options });
}

export default t;
