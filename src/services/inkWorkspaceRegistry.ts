export interface InkWorkspaceExitGuard {
  isDirty(): boolean;
  flush(): Promise<boolean>;
}

const workspaces = new Map<string, Set<InkWorkspaceExitGuard>>();

function resourceId(value: string | null): string {
  return value?.trim().split('/').filter(Boolean).at(-1) ?? '';
}

export function registerInkWorkspaceExitGuard(documentId: string, guard: InkWorkspaceExitGuard): () => void {
  const id = resourceId(documentId);
  const registered = workspaces.get(id) ?? new Set<InkWorkspaceExitGuard>();
  registered.add(guard);
  workspaces.set(id, registered);
  return () => {
    registered.delete(guard);
    if (!registered.size && workspaces.get(id) === registered) workspaces.delete(id);
  };
}

export function hasInkWorkspace(documentId: string | null): boolean {
  return Boolean(workspaces.get(resourceId(documentId))?.size);
}

export async function flushInkWorkspace(documentId: string | null): Promise<boolean> {
  const registered = workspaces.get(resourceId(documentId));
  if (!registered?.size) return true;
  const guards = [...registered];
  try {
    for (const guard of guards) {
      if (!await guard.flush()) return false;
    }
    return workspaces.get(resourceId(documentId)) === registered
      && registered.size === guards.length
      && guards.every((guard) => registered.has(guard) && !guard.isDirty());
  } catch {
    return false;
  }
}
