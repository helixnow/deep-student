import { createRoot, type Root } from 'react-dom/client';

const GLOBAL_REACT_ROOT_KEY = '__DSTU_REACT_ROOT__';

interface ReactRootEntry {
  container: HTMLElement;
  root: Root;
}

type ReactRootRegistry = typeof globalThis & {
  [GLOBAL_REACT_ROOT_KEY]?: ReactRootEntry;
};

function getRegistry(): ReactRootRegistry {
  return globalThis as ReactRootRegistry;
}

/**
 * Return the sole React root for this WebView.
 *
 * Vite can re-evaluate the application entry module after a Fast Refresh
 * boundary invalidates. Calling createRoot again on the same container leaves
 * both trees alive, so the root handle must outlive the module instance.
 */
export function getOrCreateReactRoot(container: HTMLElement): Root {
  const registry = getRegistry();
  const existing = registry[GLOBAL_REACT_ROOT_KEY];

  if (existing?.container === container) {
    return existing.root;
  }

  if (existing) {
    existing.root.unmount();
    delete registry[GLOBAL_REACT_ROOT_KEY];
  }

  if (container.hasChildNodes()) {
    if (import.meta.env.DEV && typeof window !== 'undefined') {
      // Migrating from an older dev entry can leave live roots whose handles
      // are already lost. Only a document reload can dispose their effects.
      window.location.reload();
      throw new Error('[main] Reloading to recover an unmanaged React root');
    }
    container.replaceChildren();
  }

  const root = createRoot(container);
  registry[GLOBAL_REACT_ROOT_KEY] = { container, root };
  return root;
}

/** Test-only cleanup; production callers should keep the root for the WebView lifetime. */
export function resetReactRootForTests(): void {
  const registry = getRegistry();
  const existing = registry[GLOBAL_REACT_ROOT_KEY];
  if (!existing) return;
  existing.root.unmount();
  delete registry[GLOBAL_REACT_ROOT_KEY];
}
