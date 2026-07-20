/**
 * Tauri runtime detection (browser vs desktop shell).
 */

export function isTauriRuntimeAvailable(): boolean {
  return (
    typeof window !== 'undefined' &&
    (Boolean((window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__) ||
      Boolean((window as { __TAURI_IPC__?: unknown }).__TAURI_IPC__))
  );
}
