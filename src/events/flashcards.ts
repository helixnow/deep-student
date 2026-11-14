/** Flashcards-domain events shared by the flashcards UI and Workbench adapters. */
import { dispatchTypedEvent } from './registry';
export const FSRS_LIBRARY_REFRESH_EVENT = 'fsrs:library-refresh';
export const FSRS_STATS_REFRESH_EVENT = 'fsrs:stats-refresh';
export const FLASHCARDS_CHANGED_EVENT = 'ds:flashcards-changed';

const dueRefreshListeners = new Set<() => void>();

export function requestFlashcardsDueRefresh(): void {
  for (const listener of Array.from(dueRefreshListeners)) listener();
}

export function subscribeFlashcardsDueRefresh(listener: () => void): () => void {
  dueRefreshListeners.add(listener);
  return () => dueRefreshListeners.delete(listener);
}

/**
 * Broadcasts that flashcard library / due queue records changed (e.g. inline note card sync
 * or image occlusion card creation) so Today, Library, and Statistics refresh live.
 */
export function emitFlashcardsChanged(reason = 'unknown'): void {
  requestFlashcardsDueRefresh();
  dispatchTypedEvent(FSRS_LIBRARY_REFRESH_EVENT, { reason });
  dispatchTypedEvent(FSRS_STATS_REFRESH_EVENT, { reason });
  dispatchTypedEvent(FLASHCARDS_CHANGED_EVENT, { reason });
}
