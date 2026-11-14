/**
 * Delivery from a panel module's log functions to its mounted component, inside the panel module (development builds
 * only, like the panels). Keeps the semantics of the `window` CustomEvents it replaces: listeners run synchronously in
 * subscription order, one removed during delivery is not called, and a throwing listener neither reaches the logger
 * nor stops the others (the error is reported like an uncaught listener error).
 */
export interface PanelFeed<T> {
  publish(detail: T): void;
  subscribe(listener: (detail: T) => void): () => void;
}

function reportListenerError(error: unknown): void {
  if (typeof globalThis.reportError === 'function') globalThis.reportError(error);
  else console.error(error);
}

export function createPanelFeed<T = void>(): PanelFeed<T> {
  const listeners = new Set<(detail: T) => void>();
  return {
    publish(detail) {
      for (const listener of [...listeners]) {
        if (!listeners.has(listener)) continue;
        try {
          listener(detail);
        } catch (error) {
          reportListenerError(error);
        }
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
