/**
 * Rust: src/plugins/events.rs. Event names are kebab-case; payloads camelCase.
 */
import type { BackendEvents } from './api.ts';
import type { PluginState } from './plugin-types.ts';

export const STATE_CHANGED = 'plugin-state-changed';
export const QRCODE = 'plugin-qrcode';
export const ACTIVITY = 'plugin-activity';

export interface StateChangedPayload {
  pluginId: string;
  state: PluginState;
  error: string | null;
  ts: number;
}

export interface QrcodePayload {
  pluginId: string;
  pngBase64: string;
  status: string;
  ts: number;
}

export interface ActivityPayload {
  pluginId: string;
  kind: string;
  summary: string;
  ts: number;
}

export interface PluginEventSink {
  emitState(pluginId: string, state: PluginState, error: string | null): void;
  emitQrcode(pluginId: string, pngBase64: string, status: string): void;
  emitActivity(pluginId: string, kind: string, summary: string): void;
}

export interface PluginEventOptions {
  now?: () => number;
  /** Rust `tracing::warn`; required so emit failures are never silently dropped. */
  warn: (message: string) => void;
}

/**
 * Rust tolerates emit failures (warn only). BackendEvents.emit validates payloads and may throw,
 * so the adapter keeps the Rust contract instead of aborting a lifecycle transition.
 */
export function createPluginEventSink(
  events: Pick<BackendEvents, 'emit'>,
  options: PluginEventOptions,
): PluginEventSink {
  const now = options.now ?? (() => Date.now());
  const warn = options.warn;
  const emit = (event: string, payload: StateChangedPayload | QrcodePayload | ActivityPayload) => {
    try {
      events.emit(event, payload);
    } catch (error) {
      warn(`[plugins] emit ${event} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  return {
    emitState(pluginId, state, error) {
      emit(STATE_CHANGED, { pluginId, state, error, ts: now() });
    },
    emitQrcode(pluginId, pngBase64, status) {
      emit(QRCODE, { pluginId, pngBase64, status, ts: now() });
    },
    emitActivity(pluginId, kind, summary) {
      emit(ACTIVITY, { pluginId, kind, summary, ts: now() });
    },
  };
}
