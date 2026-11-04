/**
 * Shared IndexedDB opener for ink drafts.
 *
 * Both the v1 paged drafts (`pages`) and the v2 board deltas (`board_deltas`)
 * live in the same existing database. Opening through this helper keeps a
 * single schema version: upgrading a v1 database creates the board store while
 * retaining the paged store, and neither feature may bump the version alone.
 */

export const INK_DRAFT_DB_NAME = 'deepstudent-ink-drafts';
export const INK_DRAFT_DB_VERSION = 2;
export const INK_DRAFT_PAGES_STORE = 'pages';
export const INK_BOARD_DELTAS_STORE = 'board_deltas';

export function openInkDraftDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') return Promise.reject(new Error('IndexedDB is unavailable.'));
  return new Promise((resolve, reject) => {
    let settled = false;
    const request = indexedDB.open(INK_DRAFT_DB_NAME, INK_DRAFT_DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(INK_DRAFT_PAGES_STORE)) {
        database.createObjectStore(INK_DRAFT_PAGES_STORE, { keyPath: 'key' });
      }
      if (!database.objectStoreNames.contains(INK_BOARD_DELTAS_STORE)) {
        database.createObjectStore(INK_BOARD_DELTAS_STORE, { keyPath: 'document_id' });
      }
    };
    request.onsuccess = () => {
      const database = request.result;
      if (settled) {
        database.close();
        return;
      }
      settled = true;
      database.onversionchange = () => database.close();
      resolve(database);
    };
    request.onerror = () => {
      settled = true;
      reject(request.error ?? new Error('Could not open the ink draft store.'));
    };
    request.onblocked = () => {
      settled = true;
      reject(new Error('The ink draft store is blocked.'));
    };
  });
}
