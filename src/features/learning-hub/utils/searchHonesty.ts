/**
 * Learning Hub search honesty helpers.
 *
 * Keep placeholders / trash maps / truncation hints aligned with what the
 * frontend actually searches (name filter vs content index vs loaded page).
 */

import type { FinderViewKind } from '../learningHubContracts';

/** Align trash typeFilter → dstu.listDeleted resource type (load + search). */
export const TRASH_RESOURCE_TYPE_MAP: Record<string, string> = {
  note: 'notes',
  textbook: 'textbooks',
  exam: 'exams',
  essay: 'essays',
  translation: 'translations',
};

export interface SearchPlaceholderPath {
  viewKind: FinderViewKind;
  typeFilter?: string | null;
}

/**
 * i18n key under `learningHub` for the finder search placeholder.
 * Priority: recent → trash → favorites → typeFilter (smart folder) → default.
 */
export function getSearchPlaceholderKey(path: SearchPlaceholderPath): string {
  if (path.viewKind === 'recent') return 'finder.search.placeholderRecent';
  if (path.viewKind === 'trash') return 'finder.search.placeholderTrash';
  if (path.viewKind === 'favorites') return 'finder.search.placeholderFavorites';
  if (path.typeFilter) return 'finder.search.placeholderSmartFolder';
  return 'finder.search.placeholder';
}

export function matchesLiveName(node: { name: string }, query: string): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  return node.name.toLowerCase().includes(normalized);
}

export function isResultTruncated(count: number, limit: number): boolean {
  // Callers that cannot fetch limit + 1 must pass at most `limit`; in that
  // case we deliberately report false rather than falsely claiming truncation.
  return limit > 0 && count > limit;
}
