export type ResourceWorkspaceType = 'exam' | 'essay' | 'translation';

const activeResources = new Map<ResourceWorkspaceType, string | null>();
const openHandlers = new Map<ResourceWorkspaceType, Set<(resourceId: string) => void>>();
const pendingResources = new Map<ResourceWorkspaceType, string>();
interface ActiveResourceWaiter {
  resourceId: string;
  resolve: (active: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
}
const activeWaiters = new Map<ResourceWorkspaceType, Set<ActiveResourceWaiter>>();

export function registerResourceWorkspace(
  type: ResourceWorkspaceType,
  handler: (resourceId: string) => void,
): () => void {
  const handlers = openHandlers.get(type) ?? new Set<(resourceId: string) => void>();
  handlers.add(handler);
  openHandlers.set(type, handlers);
  const pending = pendingResources.get(type);
  if (pending) {
    pendingResources.delete(type);
    handler(pending);
  }
  return () => {
    handlers.delete(handler);
    if (handlers.size === 0) openHandlers.delete(type);
  };
}

export function requestResourceWorkspace(
  type: ResourceWorkspaceType,
  resourceId: string,
): void {
  const handlers = openHandlers.get(type);
  if (!handlers?.size) {
    pendingResources.set(type, resourceId);
    return;
  }
  for (const handler of handlers) handler(resourceId);
}

export function setResourceWorkspaceActive(
  type: ResourceWorkspaceType,
  resourceId: string | null,
): void {
  activeResources.set(type, resourceId);
  if (!resourceId) return;
  const waiters = activeWaiters.get(type);
  if (!waiters) return;
  for (const waiter of [...waiters]) {
    if (waiter.resourceId !== resourceId) continue;
    clearTimeout(waiter.timer);
    waiters.delete(waiter);
    waiter.resolve(true);
  }
  if (waiters.size === 0) activeWaiters.delete(type);
}

export function getResourceWorkspaceActive(type: ResourceWorkspaceType): string | null {
  return activeResources.get(type) ?? null;
}

/** Wait until a single-resource workspace has actually committed the requested resource. */
export function waitForResourceWorkspaceActive(
  type: ResourceWorkspaceType,
  resourceId: string,
  timeoutMs = 5_000,
): Promise<boolean> {
  if (activeResources.get(type) === resourceId) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    const waiters = activeWaiters.get(type) ?? new Set<ActiveResourceWaiter>();
    let waiter: ActiveResourceWaiter;
    const timer = setTimeout(() => {
      waiters.delete(waiter);
      if (waiters.size === 0) activeWaiters.delete(type);
      resolve(false);
    }, timeoutMs);
    waiter = {
      resourceId,
      resolve,
      timer,
    };
    waiters.add(waiter);
    activeWaiters.set(type, waiters);
    if (activeResources.get(type) === resourceId) {
      clearTimeout(waiter.timer);
      waiters.delete(waiter);
      if (waiters.size === 0) activeWaiters.delete(type);
      resolve(true);
    }
  });
}

export function clearResourceWorkspaceActive(
  type: ResourceWorkspaceType,
  resourceId?: string | null,
): void {
  if (resourceId !== undefined && activeResources.get(type) !== resourceId) return;
  activeResources.delete(type);
}
