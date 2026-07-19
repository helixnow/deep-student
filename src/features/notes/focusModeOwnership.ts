export interface NotesFocusModeEventDetail {
  ownerId?: string;
  scopeId?: string;
  enabled?: boolean;
}

export function updateFocusModeOwners(
  current: ReadonlySet<string>,
  detail: NotesFocusModeEventDetail | null | undefined,
  expectedScopeId: string,
): Set<string> {
  const next = new Set(current);
  if (detail?.scopeId !== expectedScopeId) return next;
  const ownerId = detail?.ownerId?.trim();
  if (!ownerId) return next;

  if (detail?.enabled) next.add(ownerId);
  else next.delete(ownerId);
  return next;
}
