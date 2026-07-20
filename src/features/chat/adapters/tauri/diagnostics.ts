/**
 * Adapter diagnostic logging helpers.
 * Keeps log prefix / console binding out of the façade class body.
 */

import { debugLog } from '@/debug-panel/debugMasterSwitch';

export const LOG_PREFIX = '[ChatV2:TauriAdapter]';

/** Bound to the project debug master switch (same as former local `console`). */
export const adapterConsole = debugLog as Pick<
  typeof debugLog,
  'log' | 'warn' | 'error' | 'info' | 'debug'
>;

export interface StreamStartDiagInput {
  messageId: string;
  messageExists: boolean;
  hasStoreApi: boolean;
  storeApiType: string;
  hasStoreApiGetState: boolean;
  messageMapSize: number;
  messageOrder: string[];
  sessionStatus: string;
  sessionId: string;
  thisSessionId: string;
}

export function buildStreamStartDiagData(input: StreamStartDiagInput): StreamStartDiagInput {
  return { ...input };
}

export function emitChatAnkiDebugLifecycle(detail: {
  level: string;
  phase: string;
  summary: string;
  detail?: unknown;
}): void {
  try {
    window.dispatchEvent(new CustomEvent('chatanki-debug-lifecycle', { detail }));
  } catch {
    /* debug only */
  }
}
