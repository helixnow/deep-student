import { useWindowStore } from '../../core/windowStore';
import { setWindowDirty } from '../../core/windowCloseGuard';

export interface NotebookHostState {
  writing: boolean;
  busy: boolean;
  isDirty(): boolean;
  flush(): Promise<boolean>;
}

export type NotebookHostStateChange = (state: NotebookHostState | null) => void;

export interface NotebookHostPageProps {
  isActive?: boolean;
  onHostStateChange?: NotebookHostStateChange;
}

type Host = {
  readState: () => NotebookHostState | null;
  detachedSafe: boolean;
  saving: boolean;
  closePromise?: Promise<boolean>;
};

const hosts = new Map<string, Host>();

function canSuspendHost(host: Host): boolean {
  if (host.saving) return false;
  if (host.detachedSafe) return true;
  try {
    const state = host.readState();
    return Boolean(state && !state.writing && !state.busy && !state.isDirty());
  } catch {
    return false;
  }
}

function publishDirty(windowId: string, host: Host): void {
  setWindowDirty(windowId, Boolean(useWindowStore.getState().windows[windowId]) && !canSuspendHost(host));
}

export function registerNotebookHost(windowId: string, readState: Host['readState']): () => void {
  const host: Host = { readState, detachedSafe: false, saving: false };
  hosts.set(windowId, host);
  publishDirty(windowId, host);
  return () => {
    if (hosts.get(windowId) !== host) return;
    const detachedSafe = canSuspendHost(host);
    host.readState = () => null;
    host.detachedSafe = detachedSafe;
    publishDirty(windowId, host);
  };
}

export function notifyNotebookHostChanged(windowId: string): void {
  const host = hosts.get(windowId);
  if (host) publishDirty(windowId, host);
}

function notebookWindowIds(): string[] {
  return Object.values(useWindowStore.getState().windows)
    .filter((window) => window.typeId === 'notebook')
    .map((window) => window.id);
}

export function canSuspendNotebook(): boolean {
  const windowIds = notebookWindowIds();
  return windowIds.length > 0 && windowIds.every((windowId) => {
    const host = hosts.get(windowId);
    return Boolean(host && canSuspendHost(host));
  });
}

async function closeHost(windowId: string, host: Host): Promise<boolean> {
  if (host.closePromise) return host.closePromise;
  if (host.detachedSafe) return true;
  let state: NotebookHostState | null;
  let dirty: boolean;
  try {
    state = host.readState();
    if (!state || state.busy) return false;
    dirty = state.isDirty();
  } catch {
    return false;
  }
  if (!state.writing && !dirty) return true;

  host.saving = true;
  publishDirty(windowId, host);
  const closePromise = Promise.resolve().then(async () => {
    try {
      if (await state.flush() !== true) return false;
      return hosts.get(windowId) === host
        && host.readState() === state
        && !state.busy
        && !state.isDirty();
    } catch {
      return false;
    }
  }).finally(() => {
    host.saving = false;
    if (host.closePromise === closePromise) host.closePromise = undefined;
    if (hosts.get(windowId) === host) publishDirty(windowId, host);
  });
  host.closePromise = closePromise;
  return closePromise;
}

export async function canCloseNotebook(): Promise<boolean> {
  const windowIds = notebookWindowIds();
  if (windowIds.length === 0) return false;
  for (const windowId of windowIds) {
    const host = hosts.get(windowId);
    if (!host || !await closeHost(windowId, host)) return false;
  }
  return true;
}

useWindowStore.subscribe((state) => {
  for (const windowId of hosts.keys()) {
    if (state.windows[windowId]) continue;
    hosts.delete(windowId);
    setWindowDirty(windowId, false);
  }
});
