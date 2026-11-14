// Host transport for L07's ACR bridge (`workbench_bridge.rs`).
//
// Rust listens on the calling `Window` before emitting the request:
// `window.listen(response_event)` and `window.listen(progress_event)`; the
// `ListenerGuard` unlistens both ids on every exit path (workbench_bridge.rs
// :291-294, :331-387). The Host equivalent is F1's
// `BackendEvents.listenWindow(window, event, receive): disposer`, so each
// `listen()` here resolves the same `WindowRef` and returns that disposer.
// There is deliberately no app-scoped `acr:bridge-response` broadcast and no
// progress dropping: both would diverge from the Rust target semantics.
import type { BackendEvents, WindowRef } from '../../../kernel/api.ts';
import type { SettingsStore } from '../../../platform/settings/api.ts';
import type { FeatureFlagsService } from '../../../platform/storage/api.ts';
import type {
  BridgeEventBus, WorkbenchGateEnvironment,
} from '../../agent-skills/api.ts';

export type BridgeWindowRef = () => WindowRef | null;

/**
 * Maps kernel `BackendEvents` to L07's `BridgeEventBus` using window-targeted
 * listeners. The resolver runs for every `listen()` call because the bridge is
 * created once per plugin; Rust resolves `ctx.window_ref()` per bridge call too.
 */
export function backendEventBridge(
  events: BackendEvents,
  windowRef: BridgeWindowRef,
): BridgeEventBus {
  return {
    emit(event, payload) {
      const window = windowRef();
      if (window === null) {
        // The request path always subscribes first, which already rejects a
        // windowless call; this guard keeps cancel/emit from falling back to
        // an app-wide broadcast if the bus is used directly.
        throw new Error(
          'ACR bridge requires the calling frontend window (ExecutionContext.window_ref) before emitting');
      }
      events.emitTo({ kind: 'Window', label: window.window }, event, payload);
    },
    listen(event, handler) {
      const window = windowRef();
      if (window === null) {
        // Rust `ExecutionContext::window_ref()` panics when constructed
        // windowless; the Host equivalent is an explicit bridge error before
        // the request is emitted, never a silent app-level fallback.
        throw new Error(
          'ACR bridge requires the calling frontend window (ExecutionContext.window_ref) before subscribing');
      }
      return events.listenWindow(window, event, (payload) => handler(payload));
    },
  };
}

export interface CanvasGateEnvironmentOptions {
  settings?: SettingsStore;
  featureFlags?: FeatureFlagsService;
  app: { version: string; debug: boolean };
}

/** `resolve_workbench_gates` environment; null mirrors a missing AppState. */
export function canvasGateEnvironment(
  options: CanvasGateEnvironmentOptions,
): WorkbenchGateEnvironment | null {
  const { settings, featureFlags } = options;
  if (settings === undefined || featureFlags === undefined) return null;
  return {
    featureFlagEnabled(name) {
      const manager = featureFlags.load({
        getSetting: (key) => settings.get(key),
        saveSetting: (key, value) => { settings.save(key, value); },
      }, options.app.version, { debug: options.app.debug });
      return manager.isFeatureEnabled(name);
    },
    settings,
  };
}
