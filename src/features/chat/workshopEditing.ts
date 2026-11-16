import { useSyncExternalStore } from 'react';

/**
 * 「正在修改：<名> v<版本>」 strips above a conversation's composer, set by the plugin workshop when the user opened
 * that conversation to change a work. Kept in memory for this app session only; the user can dismiss it.
 */
const labels = new Map<string, string>();
const listeners = new Set<() => void>();
const notify = () => { for (const listener of listeners) listener(); };

export function setWorkshopEditing(sessionId: string, label: string | null): void {
  if (label) labels.set(sessionId, label);
  else labels.delete(sessionId);
  notify();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

export function useWorkshopEditing(sessionId: string | undefined): string | undefined {
  return useSyncExternalStore(subscribe, () => (sessionId ? labels.get(sessionId) : undefined), () => undefined);
}
