/**
 * User-facing error normalization for Chat V2 Tauri adapter paths.
 */

import i18n from 'i18next';
import { formatUserFacingError } from '@/utils/errorUtils';

const STREAM_LOAD_FAILED_KEY = 'chatV2:error.loadFailed';
const STREAM_LOAD_FAILED_FALLBACK = 'Load failed';

export function isActiveStreamConflict(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /active stream/i.test(message);
}

function isNoModelConfiguredError(error: unknown, code?: unknown): boolean {
  if (code === 'NO_MODEL_CONFIGURED' || code === 'MODEL_NOT_CONFIGURED') return true;
  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return (
    raw.includes('没有可用的文本或多模态生成模型') ||
    /no available (?:text or multimodal|chat) (?:generation )?model/i.test(raw)
  );
}

/**
 * Normalize a stream_error payload into a stable, user-facing terminal message.
 * When `error` is absent, falls back to the same i18n key used by the adapter.
 */
export function normalizeStreamTerminalError(error: unknown, code?: unknown): string {
  if (code === 'CONTEXT_WINDOW_EXCEEDED' || (typeof error === 'string' && error.includes('context budget exceeded after safe trimming'))) {
    return i18n.t('chatV2:error.contextWindowExceeded');
  }
  if (isNoModelConfiguredError(error, code)) {
    return i18n.t('chatV2:readiness.retry_after_setup');
  }
  if (error) {
    const cleaned =
      typeof error === 'string'
        ? error.replace(/^\s*LLM\s+error:\s*/i, '').trim()
        : error;
    return formatUserFacingError(
      cleaned || error,
      STREAM_LOAD_FAILED_KEY,
      STREAM_LOAD_FAILED_FALLBACK,
    );
  }
  return i18n.t(STREAM_LOAD_FAILED_KEY);
}
