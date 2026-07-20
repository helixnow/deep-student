/**
 * User-facing error normalization for Chat V2 Tauri adapter paths.
 */

import i18n from 'i18next';
import { formatUserFacingError } from '@/utils/errorUtils';

const STREAM_LOAD_FAILED_KEY = 'chatV2:error.loadFailed';
const STREAM_LOAD_FAILED_FALLBACK = 'Load failed';

/**
 * Normalize a stream_error payload into a stable, user-facing terminal message.
 * When `error` is absent, falls back to the same i18n key used by the adapter.
 */
export function normalizeStreamTerminalError(error: unknown): string {
  if (error) {
    return formatUserFacingError(
      error,
      STREAM_LOAD_FAILED_KEY,
      STREAM_LOAD_FAILED_FALLBACK,
    );
  }
  return i18n.t(STREAM_LOAD_FAILED_KEY);
}
