import type { InkPage } from './types';

const DB_NAME = 'deepstudent-ink-drafts';
const DB_VERSION = 1;
const STORE_NAME = 'pages';

export interface InkDraftKey {
  document_id: string;
  page_id: string;
}

export interface InkDraftRecord extends InkDraftKey {
  base_revision: string;
  sequence: number;
  page: InkPage;
  updated_at: number;
  save_state?: 'conflict' | 'offline';
}

export interface InkDraftStorage {
  read(key: InkDraftKey): Promise<InkDraftRecord | undefined>;
  write(record: InkDraftRecord): Promise<void>;
  remove(key: InkDraftKey): Promise<void>;
  removeIfSequenceAtMost?(key: InkDraftKey, sequence: number): Promise<void>;
}

export interface InkDraftJournal {
  read(key: InkDraftKey): Promise<InkDraftRecord | undefined>;
  persist(record: InkDraftRecord): Promise<void>;
  discard(key: InkDraftKey, throughSequence: number): Promise<void>;
}

function storageKey(key: InkDraftKey): string {
  return `${key.document_id}\u0000${key.page_id}`;
}

function openDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') return Promise.reject(new Error('IndexedDB is unavailable.'));
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) database.createObjectStore(STORE_NAME, { keyPath: 'key' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Could not open the ink draft store.'));
    request.onblocked = () => reject(new Error('The ink draft store is blocked.'));
  });
}

async function runTransaction<T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const database = await openDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, mode);
      const request = operation(transaction.objectStore(STORE_NAME));
      let result: T | undefined;
      request.onsuccess = () => { result = request.result; };
      request.onerror = () => reject(request.error ?? new Error('Ink draft storage operation failed.'));
      transaction.oncomplete = () => resolve(result as T);
      transaction.onerror = () => reject(transaction.error ?? new Error('Ink draft storage transaction failed.'));
      transaction.onabort = () => reject(transaction.error ?? new Error('Ink draft storage transaction aborted.'));
    });
  } finally {
    database.close();
  }
}

export const indexedDbInkDraftStorage: InkDraftStorage = {
  async read(key) {
    const record = await runTransaction<{ key: string } & InkDraftRecord | undefined>('readonly', (store) => store.get(storageKey(key)));
    if (!record) return undefined;
    const { key: _key, ...draft } = record;
    return draft;
  },
  async write(record) {
    await runTransaction<IDBValidKey>('readwrite', (store) => store.put({ ...record, key: storageKey(record) }));
  },
  async remove(key) {
    await runTransaction<undefined>('readwrite', (store) => store.delete(storageKey(key)));
  },
  async removeIfSequenceAtMost(key, sequence) {
    const database = await openDatabase();
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.get(storageKey(key));
        request.onsuccess = () => {
          const record = request.result as ({ sequence?: number } & InkDraftRecord) | undefined;
          if (record && record.sequence <= sequence) store.delete(storageKey(key));
        };
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error ?? new Error('Could not discard the saved ink draft.'));
        transaction.onabort = () => reject(transaction.error ?? new Error('Could not discard the saved ink draft.'));
      });
    } finally {
      database.close();
    }
  },
};

export class InkDraftJournalStore implements InkDraftJournal {
  constructor(private readonly storage: InkDraftStorage = indexedDbInkDraftStorage) {}

  read(key: InkDraftKey): Promise<InkDraftRecord | undefined> {
    return this.storage.read(key);
  }

  persist(record: InkDraftRecord): Promise<void> {
    return this.storage.write(record);
  }

  async discard(key: InkDraftKey, throughSequence: number): Promise<void> {
    if (this.storage.removeIfSequenceAtMost) {
      await this.storage.removeIfSequenceAtMost(key, throughSequence);
      return;
    }
    const current = await this.storage.read(key);
    if (current && current.sequence > throughSequence) return;
    await this.storage.remove(key);
  }
}

export const inkDraftJournal: InkDraftJournal = new InkDraftJournalStore();
