/** Flashcards-domain events shared by the flashcards UI and Workbench adapters. */
export const FSRS_LIBRARY_REFRESH_EVENT = 'fsrs:library-refresh';
export const FSRS_STATS_REFRESH_EVENT = 'fsrs:stats-refresh';

const dueRefreshListeners = new Set<() => void>();

export function requestFlashcardsDueRefresh(): void {
  for (const listener of Array.from(dueRefreshListeners)) listener();
}

export function subscribeFlashcardsDueRefresh(listener: () => void): () => void {
  dueRefreshListeners.add(listener);
  return () => dueRefreshListeners.delete(listener);
}
