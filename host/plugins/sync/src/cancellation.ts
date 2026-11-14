let activeController: AbortController | null = null;

/** commands_sync.rs:2801-2824: cooperative cancellation slot for the running sync. */
export function installSyncCancelSlot(controller: AbortController): void {
  activeController = controller;
}

export function clearSyncCancelSlot(controller: AbortController): void {
  if (activeController === controller) activeController = null;
}

export function cancelActiveSync(): boolean {
  if (activeController === null) return false;
  activeController.abort();
  return true;
}

/**
 * Runs a sync command until the sync plugin stops. kernel/API.md §2.5: a Tauri command keeps running when its page
 * reloads or its window closes, so an abandoned invoke (`'reloaded'` / `'window-closed'`) is ignored; only the kernel
 * stopping the command (`CommandStoppedError`) or the plugin being disposed cancels the run.
 */
export async function runUntilPluginStops<T>(call: AbortSignal, plugin: AbortSignal, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const stop = () => controller.abort();
  const onCall = () => { if (call.reason instanceof Error && call.reason.name === 'CommandStoppedError') stop(); };
  if (call.aborted) onCall(); else call.addEventListener('abort', onCall, { once: true });
  if (plugin.aborted) stop(); else plugin.addEventListener('abort', stop, { once: true });
  try { return await run(controller.signal); }
  finally {
    call.removeEventListener('abort', onCall);
    plugin.removeEventListener('abort', stop);
  }
}

/**
 * Runs a sync started through the reflected service (backup's governance-tool). The kernel does not wait for service
 * calls when the sync plugin unloads, so the run stops when either its caller's signal aborts or the plugin is disposed.
 */
export async function runUntilCallerOrPluginStops<T>(caller: AbortSignal | null | undefined, plugin: AbortSignal, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const stop = () => controller.abort();
  const sources = caller ? [caller, plugin] : [plugin];
  for (const source of sources) { if (source.aborted) stop(); else source.addEventListener('abort', stop, { once: true }); }
  try { return await run(controller.signal); }
  finally { for (const source of sources) source.removeEventListener('abort', stop); }
}
