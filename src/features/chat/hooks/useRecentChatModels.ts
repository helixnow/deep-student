import { useCallback, useMemo, useSyncExternalStore } from 'react';

const STORAGE_KEY = 'deep-student:chat:recent-models:v1';
const MAX_RECENT_MODELS = 8;
const EMPTY_RECENT_IDS: string[] = [];
const listeners = new Set<() => void>();
let recentIds = readRecentIds();

function readRecentIds(): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) as { version?: unknown; ids?: unknown } : null;
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.ids)) return [];
    return parsed.ids.filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
      .map((id) => id.trim())
      .filter((id, index, ids) => ids.indexOf(id) === index)
      .slice(0, MAX_RECENT_MODELS);
  } catch {
    return [];
  }
}

function notify(): void {
  listeners.forEach((listener) => listener());
}

function persist(): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, ids: recentIds }));
  } catch {
    // Private browsing, disabled storage, and quota errors must not block picking.
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1 && typeof window !== 'undefined') {
    window.addEventListener('storage', handleStorage);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && typeof window !== 'undefined') {
      window.removeEventListener('storage', handleStorage);
    }
  };
}

function handleStorage(event: StorageEvent): void {
  if (event.key !== STORAGE_KEY) return;
  recentIds = readRecentIds();
  notify();
}

function getSnapshot(): string[] {
  return recentIds;
}

export interface RecentChatModelResult<T extends { id: string }> {
  recentModels: T[];
  recentModelIds: readonly string[];
  recordSelection: (modelId: string | readonly string[]) => void;
}

/** Recent user selections are preferences, separate from defaults and favorites. */
export function useRecentChatModels<T extends { id: string }>(models: readonly T[]): RecentChatModelResult<T> {
  const ids = useSyncExternalStore(subscribe, getSnapshot, () => EMPTY_RECENT_IDS);
  const recentModels = useMemo(() => {
    const byId = new Map(models.map((model) => [model.id, model]));
    return ids.map((id) => byId.get(id)).filter((model): model is T => Boolean(model));
  }, [ids, models]);

  const recordSelection = useCallback((selection: string | readonly string[]) => {
    const selected = Array.isArray(selection) ? selection : [selection];
    const valid = selected.filter((id): id is string => typeof id === 'string' && id.trim().length > 0).map((id) => id.trim());
    if (valid.length === 0) return;
    recentIds = [...valid, ...recentIds].filter((id, index, all) => all.indexOf(id) === index).slice(0, MAX_RECENT_MODELS);
    persist();
    notify();
  }, []);

  return { recentModels, recentModelIds: ids, recordSelection };
}
