/**
 * Contribution points for code in lazily loaded chunks (Workbench apps, the Markdown pipeline, generative UI blocks).
 *
 * The owning plugin cannot import that code without pulling the chunk into startup. Instead the chunk announces its
 * contributions while it loads, and the plugin mirrors every announcement into the kernel with `ctx.ui.attach` — at
 * install time for earlier announcements, synchronously for later ones — so they exist before the chunk renders
 * anything and are revoked with the plugin. A window that never installs the owner (lightweight windows, tests without
 * a kernel) keeps the previous behaviour through `fallback`; announcements that reached `fallback` are moved into the
 * kernel when the owner attaches.
 *
 * This module must stay dependency-free: chunk-side contract modules import it from the startup closure.
 */
export interface LazyContributionPoint<T> {
  readonly name: string;
  /** Called by the lazily loaded module, once per value, in registration order. */
  announce(value: T): void;
  /**
   * Called by the owning plugin (normally through `ctx.ui.attach`); the returned function detaches it. A throwing
   * `register` rejects only that value and goes to `onError` (default: console).
   */
  attach(register: (value: T) => void, onError?: (error: unknown, value: T) => void): () => void;
  /** Everything announced so far, in order. */
  values(): readonly T[];
}

export function createLazyContributionPoint<T>(name: string, fallback?: (value: T) => (() => void) | void): LazyContributionPoint<T> {
  const announced: T[] = [];
  const fallbacks = new Map<T, () => void>();
  const sinks = new Map<(value: T) => void, ((error: unknown, value: T) => void) | undefined>();
  let attached = false;

  const deliver = (register: (value: T) => void, onError: ((error: unknown, value: T) => void) | undefined, value: T) => {
    try {
      register(value);
    } catch (error) {
      if (onError) onError(error, value);
      else console.error(`[ui-plugins] ${name}: contribution rejected`, error);
    }
  };

  return {
    name,
    announce(value) {
      announced.push(value);
      if (sinks.size) {
        for (const [sink, onError] of [...sinks]) deliver(sink, onError, value);
      } else if (!attached && fallback) {
        const revoke = fallback(value);
        if (revoke) fallbacks.set(value, revoke);
      }
    },
    attach(register, onError) {
      attached = true;
      for (const revoke of fallbacks.values()) revoke();
      fallbacks.clear();
      sinks.set(register, onError);
      for (const value of announced) deliver(register, onError, value);
      return () => { sinks.delete(register); };
    },
    values: () => announced,
  };
}
