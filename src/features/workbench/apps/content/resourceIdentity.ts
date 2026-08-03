/**
 * Workbench resource windows use the leaf DSTU id as their canonical identity.
 * Callers may still pass `/id` or a full DSTU path; adapters must not let those
 * aliases split dirty state, deletion handling, or duplicate-window checks.
 */
export function normalizeResourceInstanceKey(
  value: string | null | undefined,
): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const segments = trimmed.split('/').filter(Boolean);
  return segments[segments.length - 1]?.trim() || null;
}

export function sameResourceInstance(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  const normalizedLeft = normalizeResourceInstanceKey(left);
  return normalizedLeft !== null && normalizedLeft === normalizeResourceInstanceKey(right);
}
