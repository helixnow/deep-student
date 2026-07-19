/**
 * Chat V2 adapter error channel — lightweight user/dev error surfacing.
 *
 * user: showGlobalNotification + optional per-session error flag (retryable)
 * dev:  debugLog only (no toast / no flag)
 *
 * Keeps failure visibility out of the black-box console.error hot path without
 * changing happy-path behavior.
 */

import i18n from 'i18next';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { debugLog } from '@/debug-panel/debugMasterSwitch';
import { getErrorMessage } from '@/utils/errorUtils';

export type AdapterErrorLevel = 'user' | 'dev';

export type AdapterErrorCode =
  | 'listener_registration_failed'
  | 'listener_retry_failed'
  | 'session_load_failed'
  | 'stream_error'
  | 'session_save_failed'
  | 'abort_failed'
  | 'block_event_failed'
  | 'session_event_failed'
  | 'stream_cleanup_failed'
  | 'setup_failed';

export interface AdapterErrorFlag {
  code: AdapterErrorCode;
  sessionId: string;
  message: string;
  title?: string;
  retryable: boolean;
  at: number;
  causeMessage?: string;
}

export type AdapterErrorStoreApi = {
  setState: (partial: Record<string, unknown>) => void;
};

export interface ReportAdapterErrorOptions {
  code: AdapterErrorCode;
  level: AdapterErrorLevel;
  sessionId: string;
  /** Already-localized user-facing message */
  message: string;
  title?: string;
  cause?: unknown;
  retryable?: boolean;
  retry?: () => void | Promise<void>;
  notificationType?: 'error' | 'warning' | 'info';
  /** When false, still set the flag but skip the toast. Default true for user. */
  notify?: boolean;
  storeApi?: AdapterErrorStoreApi | null;
}

const LOG_PREFIX = '[ChatV2:AdapterError]';
const flagsBySession = new Map<string, AdapterErrorFlag>();

export function getAdapterErrorFlag(sessionId: string): AdapterErrorFlag | null {
  return flagsBySession.get(sessionId) ?? null;
}

/**
 * Clear the per-session user error flag.
 * When `codes` is provided, only clear if the current flag matches one of them.
 */
export function clearAdapterErrorFlag(
  sessionId: string,
  storeApi?: AdapterErrorStoreApi | null,
  codes?: AdapterErrorCode[],
): void {
  const current = flagsBySession.get(sessionId);
  if (!current) {
    return;
  }
  if (codes && !codes.includes(current.code)) {
    return;
  }
  flagsBySession.delete(sessionId);
  try {
    storeApi?.setState({ adapterError: null });
  } catch {
    // store may be torn down
  }
}

/**
 * Report an adapter error. Returns the stored user flag, or null for dev-level.
 */
export function reportAdapterError(options: ReportAdapterErrorOptions): AdapterErrorFlag | null {
  const causeMessage =
    options.cause !== undefined && options.cause !== null
      ? getErrorMessage(options.cause)
      : undefined;

  if (options.level === 'dev') {
    debugLog.error(LOG_PREFIX, options.code, options.message, causeMessage ?? '');
    return null;
  }

  const flag: AdapterErrorFlag = {
    code: options.code,
    sessionId: options.sessionId,
    message: options.message,
    title: options.title,
    retryable: Boolean(options.retryable),
    at: Date.now(),
    causeMessage,
  };
  flagsBySession.set(options.sessionId, flag);

  try {
    options.storeApi?.setState({ adapterError: flag });
  } catch {
    // ignore store write failures
  }

  if (options.notify !== false) {
    const action =
      options.retryable && options.retry
        ? {
            label: i18n.t('chatV2:error.retry', { defaultValue: 'Retry' }),
            onClick: () => {
              void Promise.resolve(options.retry?.()).catch((err) => {
                debugLog.error(LOG_PREFIX, 'retry action failed', getErrorMessage(err));
              });
            },
          }
        : undefined;

    showGlobalNotification(
      options.notificationType ?? 'error',
      options.message,
      options.title,
      action ? { action } : undefined,
    );
  }

  return flag;
}
