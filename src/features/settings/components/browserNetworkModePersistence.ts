export type BrowserNetworkMode = 'local_whitelist' | 'full';

interface PersistBrowserNetworkModeOptions {
  previous: BrowserNetworkMode;
  next: BrowserNetworkMode;
  persist: (mode: BrowserNetworkMode) => Promise<boolean>;
  apply: (mode: BrowserNetworkMode) => void;
}

/** Apply optimistically, then restore the last persisted value on failure. */
export async function persistBrowserNetworkModeSelection({
  previous,
  next,
  persist,
  apply,
}: PersistBrowserNetworkModeOptions): Promise<boolean> {
  apply(next);
  const saved = await persist(next);
  if (!saved) apply(previous);
  return saved;
}
