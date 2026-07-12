export type ResourceWorkspaceType = 'exam' | 'essay';

const activeResources = new Map<ResourceWorkspaceType, string | null>();
const openHandlers = new Map<ResourceWorkspaceType, Set<(resourceId: string) => void>>();
const pendingResources = new Map<ResourceWorkspaceType, string>();

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
}

export function getResourceWorkspaceActive(type: ResourceWorkspaceType): string | null {
  return activeResources.get(type) ?? null;
}

export function clearResourceWorkspaceActive(
  type: ResourceWorkspaceType,
  resourceId?: string | null,
): void {
  if (resourceId !== undefined && activeResources.get(type) !== resourceId) return;
  activeResources.delete(type);
}
