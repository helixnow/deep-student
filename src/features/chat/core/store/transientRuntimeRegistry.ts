type StoreIdentity = object;
type RuntimeDisposer = () => void;

const transientRuntimeDisposers = new WeakMap<
  StoreIdentity,
  Map<string, RuntimeDisposer>
>();

export function registerTransientRuntime(
  storeIdentity: StoreIdentity,
  key: string,
  disposer: RuntimeDisposer,
): void {
  let disposers = transientRuntimeDisposers.get(storeIdentity);
  if (!disposers) {
    disposers = new Map();
    transientRuntimeDisposers.set(storeIdentity, disposers);
  }
  disposers.set(key, disposer);
}

export function resetTransientRuntimes(storeIdentity: StoreIdentity): void {
  const disposers = transientRuntimeDisposers.get(storeIdentity);
  if (!disposers) return;
  transientRuntimeDisposers.delete(storeIdentity);
  for (const dispose of disposers.values()) {
    dispose();
  }
}
