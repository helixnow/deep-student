import { useEffect, type DependencyList } from 'react';

export type EventRegistryTarget = 'window' | 'document' | EventTarget;

export interface EventRegistryEntry {
  target: EventRegistryTarget;
  type: string;
  listener: EventListener;
  options?: boolean | AddEventListenerOptions;
}

const resolveTarget = (target: EventRegistryTarget): EventTarget | null => {
  if (target === 'window') {
    return typeof window !== 'undefined' ? window : null;
  }

  if (target === 'document') {
    return typeof document !== 'undefined' ? document : null;
  }

  return target;
};

export function useEventRegistry(entries: EventRegistryEntry[], deps: DependencyList): void {
  useEffect(() => {
    const cleanups: Array<() => void> = [];

    for (const entry of entries) {
      const resolvedTarget = resolveTarget(entry.target);
      if (!resolvedTarget) {
        continue;
      }

      resolvedTarget.addEventListener(entry.type, entry.listener, entry.options);
      cleanups.push(() => {
        resolvedTarget.removeEventListener(entry.type, entry.listener, entry.options);
      });
    }

    return () => {
      for (const cleanup of cleanups) {
        cleanup();
      }
    };
  }, deps);
}
