import type { StoreApi } from 'zustand';
import type { ChatStore } from '../../core/types';
import type { AdapterManagerImpl } from '../../adapters/AdapterManager';

interface SessionPreheatDependencies {
  getStore(sessionId: string): StoreApi<ChatStore>;
  adapterManager: Pick<AdapterManagerImpl, 'getOrCreate' | 'release'>;
}

async function loadDefaultDependencies(): Promise<SessionPreheatDependencies> {
  const [{ sessionManager }, { adapterManager }] = await Promise.all([
    import('../../core/session/sessionManager'),
    import('../../adapters/AdapterManager'),
  ]);
  return {
    getStore: (sessionId) => sessionManager.getOrCreate(sessionId),
    adapterManager,
  };
}

export function shouldPreheatSubagentSession(
  sessionId: string | null | undefined,
  isCollapsed: boolean,
): sessionId is string {
  return !!sessionId && !isCollapsed;
}

/**
 * Temporarily acquire an adapter long enough to finish setup and initial load.
 * The rendered ChatContainer owns its own lease; this speculative lease is
 * always released in finally, including when the component unmounts while the
 * asynchronous acquisition is still pending.
 */
export async function preheatSubagentSession(
  sessionId: string,
  isCancelled: () => boolean,
  dependencies?: SessionPreheatDependencies,
): Promise<void> {
  const deps = dependencies ?? await loadDefaultDependencies();
  if (isCancelled()) return;

  const store = deps.getStore(sessionId);
  const acquisition = await deps.adapterManager.getOrCreate(sessionId, store);
  try {
    if (isCancelled()) return;
    const state = store.getState();
    if (!state.isDataLoaded) {
      await state.loadSession(sessionId);
    }
  } finally {
    deps.adapterManager.release(sessionId, acquisition.lease);
  }
}

