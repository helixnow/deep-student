import i18n from '@/i18n';

/** Merge only the user's edits into a fresh DSTU props object, preserving concurrent edits. */
export function mergeNotePropEdits(
  baseline: Record<string, unknown>,
  edited: Record<string, unknown>,
  latest: Record<string, unknown>,
): Record<string, unknown> {
  let next = { ...latest };
  const has = (value: Record<string, unknown>, key: string) => Object.prototype.hasOwnProperty.call(value, key);
  const same = (a: Record<string, unknown>, b: Record<string, unknown>, key: string) =>
    has(a, key) === has(b, key) && Object.is(a[key], b[key]);
  for (const key of new Set([...Object.keys(baseline), ...Object.keys(edited)])) {
    if (same(baseline, edited, key)) continue;
    if (!same(baseline, latest, key) && !same(edited, latest, key)) {
      throw new Error(i18n.t('notes:learning.errors.concurrent_edit', { key }));
    }
    if (has(edited, key)) next = { ...next, [key]: edited[key] };
    else delete next[key];
  }
  return next;
}
