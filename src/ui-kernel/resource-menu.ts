/**
 * `resource.contextMenu` rows that declare `scopes` (contracts/content.ts) only show on those surfaces: every surface
 * evaluates every row, so the kernel puts the scope check in front of the row's own `visible`.
 */
export function scopeResourceMenuRow<T>(value: T): T {
  if (!value || typeof value !== 'object') return value;
  const row = value as { scopes?: unknown; visible?: unknown };
  if (!Array.isArray(row.scopes) || typeof row.visible !== 'function') return value;
  const scopes = new Set<unknown>(row.scopes);
  const visible = row.visible as (context: unknown) => boolean;
  return {
    ...value,
    visible: (context: { scope?: unknown } | null | undefined) => scopes.has(context?.scope) && visible.call(value, context),
  };
}
