import type { ReactNode } from 'react';
import { useSyncExternalStore } from 'react';

/** P4 owns creations, progress and session actions; the manager only provides their mount points. */
export interface PluginManagerWorkshop {
  onCreate(): void;
  onModify(pluginId: string): void;
  onRollback?(pluginId: string): Promise<void>;
  creations: ReactNode;
}

let current: PluginManagerWorkshop | undefined;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};
const snapshot = () => current;

/** Root composition owns the real paired remote/session ports and revokes this binding with its owner. */
export function registerPluginManagerWorkshop(workshop: PluginManagerWorkshop): () => void {
  current = workshop;
  for (const listener of listeners) listener();
  return () => {
    if (current !== workshop) return;
    current = undefined;
    for (const listener of listeners) listener();
  };
}

export function usePluginManagerWorkshop(): PluginManagerWorkshop | undefined {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
