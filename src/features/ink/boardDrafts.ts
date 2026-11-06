import { INK_BOARD_DELTAS_STORE, openInkDraftDatabase } from './inkDraftDatabase';
import { INK_BOARD_SCHEMA_VERSION, type InkBoardChunk } from './types';

/**
 * IndexedDB-backed board draft journal.
 *
 * Only object/chunk deltas are stored. Every sequence/owner decision happens
 * inside one IndexedDB `readwrite` transaction: read current, decide, put.
 */

const STORE_NAME = INK_BOARD_DELTAS_STORE;

export interface InkBoardDraftKey {
  document_id: string;
}

export interface InkBoardDraftRecord extends InkBoardDraftKey {
  page_id: string;
  base_revision: string;
  /** Monotonic per document; a write only lands when it is strictly newer. */
  sequence: number;
  changed: InkBoardChunk[];
  deleted: string[];
  updated_at: number;
  save_state?: 'conflict' | 'offline';
  /** Session owner. Optional only for unclaimed legacy records. */
  owner?: string;
}

interface InkBoardDraftTombstone extends InkBoardDraftKey {
  sequence: number;
  deleted: true;
}

export interface InkBoardDraftClaim {
  owner: string;
  sequence_floor: number;
  draft?: InkBoardDraftRecord;
}

export class DraftWriteRejectedError extends Error {
  readonly reason: 'ownership' | 'stale';

  constructor(reason: 'ownership' | 'stale', message?: string) {
    super(message ?? (reason === 'ownership'
      ? 'Board draft is owned by another session.'
      : 'Board draft sequence is not newer than the stored draft.'));
    this.name = 'DraftWriteRejectedError';
    this.reason = reason;
  }
}

export class DraftStorageCorruptError extends Error {
  constructor(message = 'Board draft storage contains invalid data.') {
    super(message);
    this.name = 'DraftStorageCorruptError';
  }
}

type StoredInkBoardDraft =
  | { kind: 'draft'; document_id: string; owner?: string; draft: InkBoardDraftRecord }
  | { kind: 'tombstone'; document_id: string; owner?: string; tombstone: InkBoardDraftTombstone };

export interface InkBoardDraftStorage {
  read(key: InkBoardDraftKey): Promise<InkBoardDraftRecord | undefined>;
  /**
   * Atomic monotonic write. Implementations must perform the read/compare/put
   * in one storage operation, not a read followed by a separate write.
   */
  write(record: InkBoardDraftRecord): Promise<void>;
  /** Must keep the sequence watermark and reject when the record is owned. */
  remove(key: InkBoardDraftKey): Promise<void>;
  removeIfSequenceAtMost?(key: InkBoardDraftKey, sequence: number, owner?: string): Promise<void>;
  /** Highest sequence the document has reached, tombstone included; 0 when absent. */
  readSequenceFloor?(key: InkBoardDraftKey): Promise<number>;
  /** Atomic owner adoption. Required; there is no read/write fallback. */
  claim(key: InkBoardDraftKey, owner: string): Promise<InkBoardDraftClaim>;
}

export interface InkBoardDraftJournal {
  read(key: InkBoardDraftKey): Promise<InkBoardDraftRecord | undefined>;
  claim(key: InkBoardDraftKey, owner: string): Promise<InkBoardDraftClaim>;
  persist(record: InkBoardDraftRecord): Promise<void>;
  discard(key: InkBoardDraftKey, throughSequence: number, owner?: string): Promise<void>;
  readSequenceFloor(key: InkBoardDraftKey): Promise<number>;
}

function isValidSequence(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function assertValidSequence(value: unknown, message: string): number {
  if (!isValidSequence(value)) throw new DraftStorageCorruptError(message);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

const MAX_VALIDATION_DEPTH = 64;
// 12 visited nodes per sample at the 2M board-sample budget.
const MAX_VALIDATION_NODES = 24_000_000;

function hasOnlyFiniteNumbers(value: unknown): boolean {
  const ancestors = new WeakSet<object>();
  let nodes = 0;

  const walk = (node: unknown, depth: number): boolean => {
    nodes += 1;
    if (nodes > MAX_VALIDATION_NODES) return false;
    if (typeof node === 'number') return Number.isFinite(node);
    if (typeof node !== 'object' || node === null) return true;
    if (depth > MAX_VALIDATION_DEPTH) return false;

    if (Array.isArray(node)) {
      if (ancestors.has(node)) return false;
      ancestors.add(node);
      let valid = true;
      for (const item of node) {
        if (!walk(item, depth + 1)) {
          valid = false;
          break;
        }
      }
      ancestors.delete(node);
      return valid;
    }

    if (isRecord(node)) {
      if (ancestors.has(node)) return false;
      ancestors.add(node);
      let valid = true;
      for (const item of Object.values(node)) {
        if (!walk(item, depth + 1)) {
          valid = false;
          break;
        }
      }
      ancestors.delete(node);
      return valid;
    }

    return true;
  };

  return walk(value, 0);
}

function isPointShape(value: unknown): boolean {
  return isRecord(value) && isFiniteNumber(value.x) && isFiniteNumber(value.y);
}

function isRectShape(value: unknown): boolean {
  return isRecord(value)
    && isFiniteNumber(value.x)
    && isFiniteNumber(value.y)
    && isFiniteNumber(value.width)
    && isFiniteNumber(value.height);
}

function isContentShape(value: unknown): boolean {
  if (!isRecord(value) || typeof value.kind !== 'string') return false;

  if (value.kind === 'stroke') {
    const samples = value.samples;
    const style = value.style;
    return Array.isArray(samples)
      && samples.every((sample) => isRecord(sample)
        && isFiniteNumber(sample.x)
        && isFiniteNumber(sample.y)
        && isFiniteNumber(sample.pressure)
        && (sample.elapsed_ms === undefined || isFiniteNumber(sample.elapsed_ms)))
      && isRecord(style)
      && (style.tool === 'pen' || style.tool === 'highlighter')
      && typeof style.color === 'string'
      && isFiniteNumber(style.width)
      && typeof style.pressure_enabled === 'boolean';
  }

  if (value.kind === 'text') {
    return isRectShape(value.rect)
      && typeof value.text === 'string'
      && isFiniteNumber(value.font_size)
      && typeof value.color === 'string';
  }

  if (value.kind === 'rect' || value.kind === 'ellipse' || value.kind === 'region_highlight') {
    return isRectShape(value.rect)
      && typeof value.color === 'string'
      && isFiniteNumber(value.width);
  }

  if (value.kind === 'arrow') {
    return isPointShape(value.from)
      && isPointShape(value.to)
      && typeof value.color === 'string'
      && isFiniteNumber(value.width);
  }

  return false;
}

function isChunkShape(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const objects = value.objects;
  return value.schema_version === INK_BOARD_SCHEMA_VERSION
    && typeof value.chunk_id === 'string'
    && Array.isArray(objects)
    && objects.every((object) => isRecord(object)
      && typeof object.id === 'string'
      && (object.author === 'user' || object.author === 'ai')
      && isFiniteNumber(object.created_at)
      && isFiniteNumber(object.z_index)
      && isContentShape(object.content))
    && hasOnlyFiniteNumbers(value);
}

function isChangedShape(value: unknown): value is InkBoardChunk[] {
  return Array.isArray(value) && value.every(isChunkShape);
}

function isDraftRecord(value: unknown): value is InkBoardDraftRecord {
  if (!isRecord(value)) return false;
  return typeof value.document_id === 'string'
    && typeof value.page_id === 'string'
    && typeof value.base_revision === 'string'
    && isValidSequence(value.sequence)
    && isFiniteNumber(value.updated_at)
    && (value.owner === undefined || typeof value.owner === 'string')
    && (value.save_state === undefined
      || value.save_state === 'conflict'
      || value.save_state === 'offline')
    && isChangedShape(value.changed)
    && Array.isArray(value.deleted)
    && value.deleted.every((id) => typeof id === 'string');
}

function isTombstone(value: unknown): value is InkBoardDraftTombstone {
  if (!isRecord(value)) return false;
  return typeof value.document_id === 'string'
    && isValidSequence(value.sequence)
    && value.deleted === true;
}

function assertValidDraft(record: InkBoardDraftRecord): void {
  if (!isDraftRecord(record)) {
    throw new DraftStorageCorruptError('Board draft record is invalid or contains non-finite numbers.');
  }
}

function decodeStored(
  value: unknown,
  expectedDocumentId: string,
): StoredInkBoardDraft | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new DraftStorageCorruptError('Board draft storage contains a non-record value.');
  }
  const candidate = value;

  if (candidate.kind === 'draft') {
    if (candidate.document_id !== expectedDocumentId) {
      throw new DraftStorageCorruptError('Board draft envelope key does not match its document_id.');
    }
    if (!isDraftRecord(candidate.draft)) {
      throw new DraftStorageCorruptError('Board draft envelope has an invalid draft.');
    }
    if (candidate.draft.document_id !== expectedDocumentId) {
      throw new DraftStorageCorruptError('Board draft inner document_id does not match its key.');
    }
    const envelopeOwner = candidate.owner;
    if (envelopeOwner !== undefined && typeof envelopeOwner !== 'string') {
      throw new DraftStorageCorruptError('Board draft envelope has an invalid owner.');
    }
    if (envelopeOwner !== candidate.draft.owner) {
      throw new DraftStorageCorruptError('Board draft envelope owner does not match the draft owner.');
    }
    return {
      kind: 'draft',
      document_id: expectedDocumentId,
      ...(typeof envelopeOwner === 'string' ? { owner: envelopeOwner } : {}),
      draft: candidate.draft,
    };
  }

  if (candidate.kind === 'tombstone') {
    if (candidate.document_id !== expectedDocumentId) {
      throw new DraftStorageCorruptError('Board draft tombstone key does not match its document_id.');
    }
    if (!isTombstone(candidate.tombstone)) {
      throw new DraftStorageCorruptError('Board draft envelope has an invalid tombstone.');
    }
    if (candidate.tombstone.document_id !== expectedDocumentId) {
      throw new DraftStorageCorruptError('Board draft tombstone document_id does not match its key.');
    }
    const owner = candidate.owner;
    if (owner !== undefined && typeof owner !== 'string') {
      throw new DraftStorageCorruptError('Board draft envelope has an invalid owner.');
    }
    return {
      kind: 'tombstone',
      document_id: expectedDocumentId,
      ...(typeof owner === 'string' ? { owner } : {}),
      tombstone: candidate.tombstone,
    };
  }

  if (candidate.kind !== undefined) {
    throw new DraftStorageCorruptError('Board draft envelope has an unknown kind.');
  }

  // Legacy canonical draft stored before the internal envelope existed.
  if (!isDraftRecord(candidate)) {
    throw new DraftStorageCorruptError('Board draft storage contains an unrecognized record.');
  }
  if (candidate.document_id !== expectedDocumentId) {
    throw new DraftStorageCorruptError('Board draft legacy document_id does not match its key.');
  }
  return {
    kind: 'draft',
    document_id: expectedDocumentId,
    ...(candidate.owner !== undefined ? { owner: candidate.owner } : {}),
    draft: candidate,
  };
}

function encodeDraft(record: InkBoardDraftRecord): StoredInkBoardDraft {
  return {
    kind: 'draft',
    document_id: record.document_id,
    ...(record.owner !== undefined ? { owner: record.owner } : {}),
    draft: record,
  };
}

function encodeTombstone(
  documentId: string,
  sequence: number,
  owner?: string,
): StoredInkBoardDraft {
  return {
    kind: 'tombstone',
    document_id: documentId,
    ...(owner !== undefined ? { owner } : {}),
    tombstone: { document_id: documentId, sequence, deleted: true },
  };
}

function storedSequence(stored: StoredInkBoardDraft | undefined): number | undefined {
  if (!stored) return undefined;
  return stored.kind === 'draft' ? stored.draft.sequence : stored.tombstone.sequence;
}

function storedOwner(stored: StoredInkBoardDraft | undefined): string | undefined {
  return stored?.owner;
}

function sameDraftPayload(a: InkBoardDraftRecord, b: InkBoardDraftRecord): boolean {
  return a.document_id === b.document_id
    && a.page_id === b.page_id
    && a.base_revision === b.base_revision
    && a.sequence === b.sequence
    && a.updated_at === b.updated_at
    && a.owner === b.owner
    && a.save_state === b.save_state
    && JSON.stringify(a.changed) === JSON.stringify(b.changed)
    && JSON.stringify(a.deleted) === JSON.stringify(b.deleted);
}

function openDatabase(): Promise<IDBDatabase> {
  return openInkDraftDatabase();
}

async function runTransaction<T>(
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const database = await openDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, mode);
      const request = operation(transaction.objectStore(STORE_NAME));
      let result: T | undefined;
      request.onsuccess = () => { result = request.result; };
      request.onerror = () => reject(request.error ?? new Error('Board draft storage operation failed.'));
      transaction.oncomplete = () => resolve(result as T);
      transaction.onerror = () => reject(transaction.error ?? new Error('Board draft storage transaction failed.'));
      transaction.onabort = () => reject(transaction.error ?? new Error('Board draft storage transaction aborted.'));
    });
  } finally {
    database.close();
  }
}

/**
 * Atomic read/decide/write. A throw from `update` aborts the transaction and
 * rejects with the original error; it can never complete as a false success.
 */
async function runAtomicUpdate(
  documentId: string,
  update: (store: IDBObjectStore, current: StoredInkBoardDraft | undefined) => void,
): Promise<void> {
  const database = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.get(documentId);
      let failed = false;
      let failure: unknown;
      const fail = (cause: unknown) => {
        failed = true;
        failure = cause;
        try {
          transaction.abort();
        } catch {
          // The transaction already aborted or completed.
        }
      };
      request.onsuccess = () => {
        try {
          update(store, decodeStored(request.result, documentId));
        } catch (cause) {
          fail(cause);
        }
      };
      request.onerror = () => fail(request.error ?? new Error('Board draft storage operation failed.'));
      transaction.oncomplete = () => {
        if (failed) reject(failure);
        else resolve();
      };
      transaction.onerror = () => {
        reject(failed ? failure : transaction.error ?? new Error('Board draft storage transaction failed.'));
      };
      transaction.onabort = () => {
        reject(failed ? failure : transaction.error ?? new Error('Board draft storage transaction aborted.'));
      };
    });
  } finally {
    database.close();
  }
}

export const indexedDbInkBoardDraftStorage: InkBoardDraftStorage = {
  async read(key) {
    const value = await runTransaction<unknown>(
      'readonly',
      (store) => store.get(key.document_id),
    );
    const stored = decodeStored(value, key.document_id);
    return stored?.kind === 'draft' ? stored.draft : undefined;
  },
  async readSequenceFloor(key) {
    const value = await runTransaction<unknown>(
      'readonly',
      (store) => store.get(key.document_id),
    );
    return storedSequence(decodeStored(value, key.document_id)) ?? 0;
  },
  async claim(key, owner) {
    let claimed: InkBoardDraftClaim | undefined;
    await runAtomicUpdate(key.document_id, (store, current) => {
      if (!current) {
        store.put(encodeTombstone(key.document_id, 0, owner));
        claimed = { owner, sequence_floor: 0 };
        return;
      }
      if (current.kind === 'tombstone') {
        store.put(encodeTombstone(key.document_id, current.tombstone.sequence, owner));
        claimed = { owner, sequence_floor: current.tombstone.sequence };
        return;
      }
      const draft = { ...current.draft, owner };
      store.put(encodeDraft(draft));
      claimed = { owner, sequence_floor: draft.sequence, draft };
    });
    if (!claimed) throw new Error('Board draft claim did not complete.');
    return claimed;
  },
  async write(record) {
    assertValidDraft(record);
    await runAtomicUpdate(record.document_id, (store, current) => {
      const currentOwner = storedOwner(current);
      if (current) {
        if (currentOwner !== record.owner) throw new DraftWriteRejectedError('ownership');
      } else if (record.owner !== undefined) {
        throw new DraftWriteRejectedError('ownership', 'A new owner must be established through claim().');
      }

      if (current) {
        const currentSequence = storedSequence(current) as number;
        if (record.sequence < currentSequence) throw new DraftWriteRejectedError('stale');
        if (record.sequence === currentSequence) {
          if (current.kind === 'draft' && sameDraftPayload(current.draft, record)) return;
          throw new DraftWriteRejectedError('stale');
        }
      }
      store.put(encodeDraft(record));
    });
  },
  async remove(key) {
    await runAtomicUpdate(key.document_id, (store, current) => {
      if (!current) return;
      if (storedOwner(current) !== undefined) {
        throw new DraftWriteRejectedError('ownership', 'An owned board draft must be discarded by its owner.');
      }
      if (current.kind === 'tombstone') return;
      store.put(encodeTombstone(key.document_id, current.draft.sequence));
    });
  },
  async removeIfSequenceAtMost(key, sequence, owner) {
    assertValidSequence(sequence, 'Board draft discard sequence must be a safe integer >= 0.');
    await runAtomicUpdate(key.document_id, (store, current) => {
      if (!current) {
        store.put(encodeTombstone(key.document_id, sequence, owner));
        return;
      }
      const currentOwner = storedOwner(current);
      if (currentOwner !== owner) throw new DraftWriteRejectedError('ownership');
      const currentSequence = storedSequence(current) as number;
      if (currentSequence > sequence) return;
      store.put(encodeTombstone(
        key.document_id,
        Math.max(sequence, currentSequence),
        currentOwner,
      ));
    });
  },
};

export class InkBoardDraftJournalStore implements InkBoardDraftJournal {
  constructor(private readonly storage: InkBoardDraftStorage = indexedDbInkBoardDraftStorage) {}

  read(key: InkBoardDraftKey): Promise<InkBoardDraftRecord | undefined> {
    return this.storage.read(key);
  }

  claim(key: InkBoardDraftKey, owner: string): Promise<InkBoardDraftClaim> {
    return this.storage.claim(key, owner);
  }

  persist(record: InkBoardDraftRecord): Promise<void> {
    return this.storage.write(record);
  }

  async discard(key: InkBoardDraftKey, throughSequence: number, owner?: string): Promise<void> {
    const removeThrough = this.storage.removeIfSequenceAtMost;
    if (!removeThrough) throw new Error('Board draft storage does not support atomic discard.');
    await removeThrough.call(this.storage, key, throughSequence, owner);
  }

  async readSequenceFloor(key: InkBoardDraftKey): Promise<number> {
    const readFloor = this.storage.readSequenceFloor;
    if (readFloor) return readFloor.call(this.storage, key);
    const current = await this.storage.read(key);
    return current?.sequence ?? 0;
  }
}

export const inkBoardDraftJournal: InkBoardDraftJournal = new InkBoardDraftJournalStore();
