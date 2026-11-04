import React from 'react';
import {
  InkBoardDraftJournalStore,
  indexedDbInkBoardDraftStorage,
} from '../../../src/features/ink/boardDrafts';
import type { InkBoardDraftRecord } from '../../../src/features/ink/boardDrafts';
import { indexedDbInkDraftStorage } from '../../../src/features/ink/drafts';
import type { InkDraftRecord } from '../../../src/features/ink/drafts';
import {
  INK_BOARD_DELTAS_STORE,
  INK_DRAFT_DB_NAME,
  INK_DRAFT_PAGES_STORE,
  openInkDraftDatabase,
} from '../../../src/features/ink/inkDraftDatabase';
import {
  INK_DRAFT_DELTA_FIXTURE,
  INK_DRAFT_DOCUMENT_ID,
  INK_DRAFT_PAGES_FIXTURE,
  INK_DRAFT_PAGE_ID,
  INK_DRAFT_SEQ1_FIXTURE,
  INK_DRAFT_SEQ2_FIXTURE,
  INK_DRAFT_SEQ3_CONFLICT_FIXTURE,
  INK_DRAFT_SEQ3_FIXTURE,
  INK_DRAFT_SEQ3_NEW_OWNER_FIXTURE,
  INK_DRAFT_SEQ4_OLD_OWNER_FIXTURE,
  INK_DRAFT_STORAGE_KEY,
} from './draftDatabaseFixtures';
import type { InkDraftDatabaseSnapshot } from './draftDatabaseFixtures';

export type InkBoardDraftRejectionReason = 'ownership' | 'stale';

export type InkBoardDraftOperationOutcome = {
  label: string;
  rejected: boolean;
  errorName: string | null;
  reason: InkBoardDraftRejectionReason | null;
  error: string | null;
};

export type InkBoardDraftClaimResult = {
  owner: string;
  sequence_floor: number;
  draft?: InkBoardDraftRecord;
};

export type InkBoardDraftScenarioResult = {
  read: InkBoardDraftRecord | null;
  pages: InkDraftRecord | null;
  persists: InkBoardDraftOperationOutcome[];
  reads?: (InkBoardDraftRecord | null)[];
  discards?: InkBoardDraftOperationOutcome[];
  claims?: InkBoardDraftClaimResult[];
  claimAttempts?: InkBoardDraftOperationOutcome[];
  rawSnapshots?: { document_id: string; value: unknown }[];
  storedRaw?: unknown;
};

type DatabaseTracking = {
  originalOpen: IDBFactory['open'];
  waitForNextSuccess: () => Promise<IDBDatabase>;
  closeTracked: () => void;
};

let tracking: DatabaseTracking | null = null;

/**
 * Wraps `indexedDB.open` only to observe successful connections for teardown.
 * Requests, upgrade handlers, and events still come from the real IDBFactory.
 */
const ensureTracking = (): DatabaseTracking => {
  if (tracking) return tracking;
  const factory = indexedDB;
  const originalOpen = factory.open.bind(factory);
  const tracked: IDBDatabase[] = [];
  const listeners = new Set<(database: IDBDatabase) => void>();
  const wrappedOpen = ((name: string, version?: number) => {
    const request = originalOpen(name, version);
    request.addEventListener('success', () => {
      const database = request.result;
      tracked.push(database);
      for (const listener of listeners) listener(database);
    });
    return request;
  }) as IDBFactory['open'];
  Object.defineProperty(factory, 'open', { configurable: true, value: wrappedOpen });
  tracking = {
    originalOpen,
    waitForNextSuccess: () => new Promise<IDBDatabase>((resolve) => {
      const listener = (database: IDBDatabase) => {
        listeners.delete(listener);
        resolve(database);
      };
      listeners.add(listener);
    }),
    closeTracked: () => {
      for (const database of tracked.splice(0)) {
        try {
          database.close();
        } catch {
          // The connection was already closed.
        }
      }
    },
  };
  return tracking;
};

const openRaw = (
  open: IDBFactory['open'],
  version: number,
  upgrade?: (database: IDBDatabase) => void,
): Promise<IDBDatabase> => new Promise((resolve, reject) => {
  const request = open(INK_DRAFT_DB_NAME, version);
  request.onupgradeneeded = () => upgrade?.(request.result);
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error ?? new Error('Raw ink draft database open failed.'));
  request.onblocked = () => reject(new Error('Raw ink draft database open blocked.'));
});

const writeRecord = (database: IDBDatabase, storeName: string, record: unknown): Promise<void> =>
  new Promise((resolve, reject) => {
    const transaction = database.transaction(storeName, 'readwrite');
    transaction.objectStore(storeName).put(record);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error(`Could not write ${storeName}.`));
    transaction.onabort = () => reject(transaction.error ?? new Error(`Writing ${storeName} was aborted.`));
  });

const readRecord = (database: IDBDatabase, storeName: string, key: IDBValidKey): Promise<unknown> =>
  new Promise((resolve, reject) => {
    const transaction = database.transaction(storeName, 'readonly');
    const request = transaction.objectStore(storeName).get(key);
    let value: unknown;
    request.onsuccess = () => {
      value = request.result;
    };
    request.onerror = () => reject(request.error ?? new Error(`Could not read ${storeName}.`));
    transaction.oncomplete = () => resolve(value);
    transaction.onerror = () => reject(transaction.error ?? new Error(`Could not read ${storeName}.`));
    transaction.onabort = () => reject(transaction.error ?? new Error(`Reading ${storeName} was aborted.`));
  });

const deleteInkDraftDatabase = (): Promise<void> =>
  new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(INK_DRAFT_DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error('Could not delete the ink draft database.'));
  });

type ClaimKey = { document_id: string };

type ClaimApi = {
  claim(key: ClaimKey, owner: string): Promise<InkBoardDraftClaimResult>;
};

type DiscardWithOwner = (
  key: ClaimKey,
  throughSequence: number,
  owner?: string,
) => Promise<void>;

const describeRejection = (
  cause: unknown,
): Pick<InkBoardDraftOperationOutcome, 'errorName' | 'reason' | 'error'> => {
  if (cause && typeof cause === 'object') {
    const record = cause as Record<string, unknown>;
    const rawReason = record.reason ?? record.kind ?? record.code;
    return {
      errorName: typeof record.name === 'string' ? record.name : null,
      reason: rawReason === 'ownership' || rawReason === 'stale' ? rawReason : null,
      error: cause instanceof Error ? cause.message : String(cause),
    };
  }
  return { errorName: null, reason: null, error: String(cause) };
};

/**
 * Attempts a journal persist and records the observable outcome. A rejected
 * stale/owner-mismatched write must not stop the scenario before the read that
 * proves the durable value is unchanged.
 */
const attemptPersist = async (
  journal: InkBoardDraftJournalStore,
  label: string,
  record: InkBoardDraftRecord,
): Promise<InkBoardDraftOperationOutcome> => {
  try {
    await journal.persist(record);
    return { label, rejected: false, errorName: null, reason: null, error: null };
  } catch (cause) {
    return { label, rejected: true, ...describeRejection(cause) };
  }
};

const attemptDiscard = async (
  journal: InkBoardDraftJournalStore,
  label: string,
  key: ClaimKey,
  throughSequence: number,
  owner?: string,
): Promise<InkBoardDraftOperationOutcome> => {
  try {
    await (journal.discard as unknown as DiscardWithOwner).call(
      journal,
      key,
      throughSequence,
      owner,
    );
    return { label, rejected: false, errorName: null, reason: null, error: null };
  } catch (cause) {
    return { label, rejected: true, ...describeRejection(cause) };
  }
};

const attemptClaim = async (
  journal: InkBoardDraftJournalStore,
  label: string,
  key: ClaimKey,
  owner: string,
): Promise<InkBoardDraftOperationOutcome> => {
  try {
    await claimJournal(journal, key, owner);
    return { label, rejected: false, errorName: null, reason: null, error: null };
  } catch (cause) {
    return { label, rejected: true, ...describeRejection(cause) };
  }
};

const claimJournal = (
  journal: InkBoardDraftJournalStore,
  key: ClaimKey,
  owner: string,
): Promise<InkBoardDraftClaimResult> => (
  (journal as unknown as ClaimApi).claim(key, owner)
);

const claimStorage = (
  key: ClaimKey,
  owner: string,
): Promise<InkBoardDraftClaimResult> => (
  (indexedDbInkBoardDraftStorage as unknown as ClaimApi).claim(key, owner)
);

const seedRawDraft = async (record: InkBoardDraftRecord): Promise<void> => {
  const database = await openInkDraftDatabase();
  try {
    await writeRecord(database, INK_BOARD_DELTAS_STORE, record);
  } finally {
    database.close();
  }
};

const seedRawValue = async (
  documentId: string,
  value: unknown,
): Promise<void> => {
  const database = await openInkDraftDatabase();
  try {
    await writeRecord(database, INK_BOARD_DELTAS_STORE, { ...(value as object), document_id: documentId });
  } finally {
    database.close();
  }
};

const readRawBoard = async (documentId: string): Promise<unknown> => {
  const database = await openInkDraftDatabase();
  try {
    return await readRecord(database, INK_BOARD_DELTAS_STORE, documentId);
  } finally {
    database.close();
  }
};

const withRectWidth = (
  documentId: string,
  sequence: number,
  width: unknown,
): InkBoardDraftRecord => {
  const chunk = INK_DRAFT_SEQ3_FIXTURE.changed[0];
  const object = chunk.objects[0];
  const content = object.content as unknown as {
    rect: Record<string, unknown>;
  } & Record<string, unknown>;
  return {
    ...INK_DRAFT_SEQ3_FIXTURE,
    document_id: documentId,
    sequence,
    updated_at: sequence,
    changed: [{
      ...chunk,
      chunk_id: 'fixture-board-chunk-invalid-nonfinite',
      objects: [{
        ...object,
        content: {
          ...content,
          rect: { ...content.rect, width },
        },
      }],
    }],
  } as unknown as InkBoardDraftRecord;
};

type HarnessState =
  | 'idle'
  | 'preparing'
  | 'prepared'
  | 'prepare-error'
  | 'opening'
  | 'opened'
  | 'open-error'
  | 'holding-pending'
  | 'holding'
  | 'holding-error'
  | 'opening-blocked'
  | 'blocked-rejected'
  | 'blocked-unexpected-success'
  | 'releasing'
  | 'late-success'
  | 'release-error'
  | 'deleting'
  | 'deleted'
  | 'delete-blocked'
  | 'delete-error'
  | 'cleaning'
  | 'cleaned'
  | 'cleanup-error'
  | 'scenario-running'
  | 'scenario-done'
  | 'scenario-error';

export function InkDraftDatabaseHarness() {
  const detection = ensureTracking();
  const held = React.useRef<IDBDatabase | null>(null);
  const [state, setState] = React.useState<HarnessState>('idle');
  const [error, setError] = React.useState('');
  const [snapshot, setSnapshot] = React.useState<InkDraftDatabaseSnapshot | null>(null);
  const [scenario, setScenario] = React.useState<InkBoardDraftScenarioResult | null>(null);

  React.useEffect(() => () => {
    held.current?.close();
    detection.closeTracked();
  }, [detection]);

  const fail = (next: HarnessState, cause: unknown) => {
    setError(cause instanceof Error ? cause.message : String(cause));
    setState(next);
  };

  const prepare = async () => {
    setError('');
    setState('preparing');
    let database: IDBDatabase | null = null;
    try {
      database = await openRaw(detection.originalOpen, 1, (upgraded) => {
        if (!upgraded.objectStoreNames.contains(INK_DRAFT_PAGES_STORE)) {
          upgraded.createObjectStore(INK_DRAFT_PAGES_STORE, { keyPath: 'key' });
        }
      });
      await writeRecord(database, INK_DRAFT_PAGES_STORE, { ...INK_DRAFT_PAGES_FIXTURE, key: INK_DRAFT_STORAGE_KEY });
      setState('prepared');
    } catch (cause) {
      fail('prepare-error', cause);
    } finally {
      database?.close();
    }
  };

  const open = async () => {
    setError('');
    setState('opening');
    let database: IDBDatabase | null = null;
    try {
      database = await openInkDraftDatabase();
      const oldPage = await readRecord(
        database,
        INK_DRAFT_PAGES_STORE,
        INK_DRAFT_STORAGE_KEY,
      ) as ({ key: string } & InkDraftRecord) | undefined;
      await writeRecord(database, INK_BOARD_DELTAS_STORE, INK_DRAFT_DELTA_FIXTURE);
      const delta = await readRecord(
        database,
        INK_BOARD_DELTAS_STORE,
        INK_DRAFT_DELTA_FIXTURE.document_id,
      ) as InkBoardDraftRecord | undefined;
      const databases = await indexedDB.databases();
      setSnapshot({
        name: database.name,
        version: database.version,
        objectStoreNames: Array.from(database.objectStoreNames).sort(),
        databaseNames: databases
          .map((entry) => entry.name)
          .filter((name): name is string => typeof name === 'string')
          .sort(),
        oldPage,
        delta,
      });
      setState('opened');
    } catch (cause) {
      fail('open-error', cause);
    } finally {
      database?.close();
    }
  };

  const hold = async () => {
    setError('');
    setState('holding-pending');
    try {
      held.current = await openRaw(detection.originalOpen, 1);
      setState('holding');
    } catch (cause) {
      fail('holding-error', cause);
    }
  };

  const openBlocked = async () => {
    setError('');
    setState('opening-blocked');
    try {
      const database = await openInkDraftDatabase();
      database.close();
      setState('blocked-unexpected-success');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setState('blocked-rejected');
    }
  };

  const release = async () => {
    setError('');
    if (!held.current) {
      fail('release-error', new Error('No held v1 connection to release.'));
      return;
    }
    setState('releasing');
    const nextSuccess = detection.waitForNextSuccess();
    try {
      held.current.close();
      held.current = null;
      // The leaked connection stays open on purpose so the spec can observe it.
      await nextSuccess;
      setState('late-success');
    } catch (cause) {
      fail('release-error', cause);
    }
  };

  const remove = () => {
    setError('');
    setState('deleting');
    const request = indexedDB.deleteDatabase(INK_DRAFT_DB_NAME);
    request.onsuccess = () => setState('deleted');
    request.onerror = () => fail('delete-error', request.error ?? new Error('Could not delete the ink draft database.'));
    request.onblocked = () => setState('delete-blocked');
  };

  const runStaleOverwriteScenario = async () => {
    setError('');
    setScenario(null);
    setState('scenario-running');
    try {
      const first = new InkBoardDraftJournalStore(indexedDbInkBoardDraftStorage);
      const second = new InkBoardDraftJournalStore(indexedDbInkBoardDraftStorage);
      const persists = [
        await attemptPersist(first, 'newer', INK_DRAFT_SEQ3_FIXTURE),
        await attemptPersist(second, 'stale', INK_DRAFT_SEQ1_FIXTURE),
      ];
      const read = await first.read({ document_id: INK_DRAFT_SEQ3_FIXTURE.document_id });
      setScenario({ read: read ?? null, pages: null, persists });
      setState('scenario-done');
    } catch (cause) {
      fail('scenario-error', cause);
    }
  };

  const runLateResurrectScenario = async () => {
    setError('');
    setScenario(null);
    setState('scenario-running');
    try {
      const database = await openInkDraftDatabase();
      try {
        await writeRecord(database, INK_DRAFT_PAGES_STORE, {
          ...INK_DRAFT_PAGES_FIXTURE,
          key: INK_DRAFT_STORAGE_KEY,
        });
      } finally {
        database.close();
      }

      const first = new InkBoardDraftJournalStore(indexedDbInkBoardDraftStorage);
      const late = new InkBoardDraftJournalStore(indexedDbInkBoardDraftStorage);
      const key = { document_id: INK_DRAFT_SEQ3_FIXTURE.document_id };
      const persists = [
        await attemptPersist(first, 'committed', INK_DRAFT_SEQ3_FIXTURE),
      ];
      await first.discard(key, 3);
      persists.push(await attemptPersist(late, 'late', INK_DRAFT_SEQ2_FIXTURE));

      const read = await first.read(key);
      const pages = await indexedDbInkDraftStorage.read({
        document_id: INK_DRAFT_DOCUMENT_ID,
        page_id: INK_DRAFT_PAGE_ID,
      });
      setScenario({ read: read ?? null, pages: pages ?? null, persists });
      setState('scenario-done');
    } catch (cause) {
      fail('scenario-error', cause);
    }
  };

  const runEqualSequenceScenario = async () => {
    setError('');
    setScenario(null);
    setState('scenario-running');
    try {
      const journal = new InkBoardDraftJournalStore(indexedDbInkBoardDraftStorage);
      const key = { document_id: INK_DRAFT_SEQ3_FIXTURE.document_id };
      const persists = [
        await attemptPersist(journal, 'newer', INK_DRAFT_SEQ3_FIXTURE),
        await attemptPersist(journal, 'retry-same', { ...INK_DRAFT_SEQ3_FIXTURE }),
        await attemptPersist(journal, 'equal-different', INK_DRAFT_SEQ3_CONFLICT_FIXTURE),
      ];
      const read = await journal.read(key);
      setScenario({ read: read ?? null, pages: null, persists });
      setState('scenario-done');
    } catch (cause) {
      fail('scenario-error', cause);
    }
  };

  const runOwnerScenario = async () => {
    setError('');
    setScenario(null);
    setState('scenario-running');
    try {
      const database = await openInkDraftDatabase();
      try {
        await writeRecord(database, INK_BOARD_DELTAS_STORE, INK_DRAFT_SEQ3_NEW_OWNER_FIXTURE);
      } finally {
        database.close();
      }

      const journal = new InkBoardDraftJournalStore(indexedDbInkBoardDraftStorage);
      const persists = [
        await attemptPersist(journal, 'old-owner-newer-sequence', INK_DRAFT_SEQ4_OLD_OWNER_FIXTURE),
      ];
      const read = await journal.read({ document_id: INK_DRAFT_SEQ3_NEW_OWNER_FIXTURE.document_id });
      setScenario({ read: read ?? null, pages: null, persists });
      setState('scenario-done');
    } catch (cause) {
      fail('scenario-error', cause);
    }
  };

  const runClaimExistingScenario = async () => {
    setError('');
    setScenario(null);
    setState('scenario-running');
    try {
      const key = { document_id: INK_DRAFT_SEQ3_NEW_OWNER_FIXTURE.document_id };
      await seedRawDraft(INK_DRAFT_SEQ3_NEW_OWNER_FIXTURE);
      const journal = new InkBoardDraftJournalStore(indexedDbInkBoardDraftStorage);
      const claims = [await claimJournal(journal, key, 'claim-owner')];
      const persists = [
        await attemptPersist(journal, 'previous-owner-after-claim', {
          ...INK_DRAFT_SEQ4_OLD_OWNER_FIXTURE,
          owner: 'new-session',
        }),
        await attemptPersist(journal, 'claim-owner-write', {
          ...INK_DRAFT_SEQ3_FIXTURE,
          sequence: 4,
          owner: 'claim-owner',
          updated_at: 4,
        }),
      ];
      const read = await journal.read(key);
      setScenario({ read: read ?? null, pages: null, persists, claims });
      setState('scenario-done');
    } catch (cause) {
      fail('scenario-error', cause);
    }
  };

  const runClaimMissingScenario = async () => {
    setError('');
    setScenario(null);
    setState('scenario-running');
    try {
      const key = { document_id: INK_DRAFT_SEQ3_FIXTURE.document_id };
      const journal = new InkBoardDraftJournalStore(indexedDbInkBoardDraftStorage);
      const claims = [await claimStorage(key, 'owner-a')];
      const persists = [
        await attemptPersist(journal, 'unowned-before-owner', { ...INK_DRAFT_SEQ1_FIXTURE }),
        await attemptPersist(journal, 'owner-a-first-write', {
          ...INK_DRAFT_SEQ1_FIXTURE,
          owner: 'owner-a',
        }),
      ];
      claims.push(await claimStorage(key, 'owner-b'));
      persists.push(await attemptPersist(journal, 'owner-a-after-reclaim', {
        ...INK_DRAFT_SEQ2_FIXTURE,
        owner: 'owner-a',
      }));
      persists.push(await attemptPersist(journal, 'owner-b-after-reclaim', {
        ...INK_DRAFT_SEQ2_FIXTURE,
        owner: 'owner-b',
      }));
      const read = await journal.read(key);
      setScenario({ read: read ?? null, pages: null, persists, claims });
      setState('scenario-done');
    } catch (cause) {
      fail('scenario-error', cause);
    }
  };

  const runClaimLegacyScenario = async () => {
    setError('');
    setScenario(null);
    setState('scenario-running');
    try {
      const key = { document_id: INK_DRAFT_SEQ3_FIXTURE.document_id };
      await seedRawDraft(INK_DRAFT_SEQ3_FIXTURE);
      const journal = new InkBoardDraftJournalStore(indexedDbInkBoardDraftStorage);
      const unclaimed = await journal.read(key);
      const storedRaw = await readRawBoard(key.document_id);
      const persists = [
        await attemptPersist(journal, 'owner-before-claim', INK_DRAFT_SEQ4_OLD_OWNER_FIXTURE),
      ];
      const claims = [await claimJournal(journal, key, 'claimer')];
      persists.push(await attemptPersist(journal, 'unowned-after-claim', {
        ...INK_DRAFT_SEQ3_FIXTURE,
        sequence: 4,
        updated_at: 4,
      }));
      persists.push(await attemptPersist(journal, 'claimer-write', {
        ...INK_DRAFT_SEQ3_FIXTURE,
        sequence: 4,
        owner: 'claimer',
        updated_at: 4,
      }));
      const read = await journal.read(key);
      setScenario({
        read: read ?? null,
        pages: null,
        persists,
        claims,
        reads: [unclaimed ?? null],
        storedRaw,
      });
      setState('scenario-done');
    } catch (cause) {
      fail('scenario-error', cause);
    }
  };

  const runDiscardOwnerScenario = async () => {
    setError('');
    setScenario(null);
    setState('scenario-running');
    try {
      const key = { document_id: INK_DRAFT_SEQ3_FIXTURE.document_id };
      const journal = new InkBoardDraftJournalStore(indexedDbInkBoardDraftStorage);
      const claims = [await claimJournal(journal, key, 'owner-a')];
      const persists = [
        await attemptPersist(journal, 'owner-a-seq5', {
          ...INK_DRAFT_SEQ3_FIXTURE,
          sequence: 5,
          owner: 'owner-a',
          updated_at: 5,
        }),
      ];
      const discards = [
        await attemptDiscard(journal, 'wrong-owner-through3', key, 3, 'owner-b'),
        await attemptDiscard(journal, 'owner-a-through3', key, 3, 'owner-a'),
      ];
      const preserved = await journal.read(key);
      discards.push(await attemptDiscard(journal, 'owner-a-through5', key, 5, 'owner-a'));
      const discarded = await journal.read(key);
      claims.push(await claimJournal(journal, key, 'owner-b'));
      persists.push(await attemptPersist(journal, 'owner-a-after-discard', {
        ...INK_DRAFT_SEQ3_FIXTURE,
        sequence: 6,
        owner: 'owner-a',
        updated_at: 6,
      }));
      persists.push(await attemptPersist(journal, 'owner-b-after-discard', {
        ...INK_DRAFT_SEQ3_FIXTURE,
        sequence: 6,
        owner: 'owner-b',
        updated_at: 6,
      }));
      const read = await journal.read(key);
      setScenario({
        read: read ?? null,
        pages: null,
        persists,
        discards,
        claims,
        reads: [preserved ?? null, discarded ?? null],
      });
      setState('scenario-done');
    } catch (cause) {
      fail('scenario-error', cause);
    }
  };

  const runCorruptEnvelopeScenario = async () => {
    setError('');
    setScenario(null);
    setState('scenario-running');
    try {
      const idMismatchKey = 'fixture-corrupt-envelope-a';
      const innerDocumentId = 'fixture-corrupt-envelope-b';
      const ownerMismatchKey = 'fixture-corrupt-envelope-c';
      const innerDraft = {
        ...INK_DRAFT_SEQ3_FIXTURE,
        document_id: innerDocumentId,
        owner: 'inner-owner',
      };
      const badIdEnvelope = {
        kind: 'draft',
        document_id: idMismatchKey,
        owner: 'outer-owner',
        draft: {
          ...INK_DRAFT_SEQ3_FIXTURE,
          document_id: innerDocumentId,
          owner: 'outer-owner',
        },
      };
      const badOwnerEnvelope = {
        kind: 'draft',
        document_id: ownerMismatchKey,
        owner: 'envelope-owner',
        draft: {
          ...INK_DRAFT_SEQ3_FIXTURE,
          document_id: ownerMismatchKey,
          owner: 'draft-owner',
        },
      };
      await seedRawValue(idMismatchKey, badIdEnvelope);
      await seedRawValue(innerDocumentId, innerDraft);
      await seedRawValue(ownerMismatchKey, badOwnerEnvelope);

      const journal = new InkBoardDraftJournalStore(indexedDbInkBoardDraftStorage);
      const claimAttempts = [
        await attemptClaim(
          journal,
          'envelope-id-mismatch',
          { document_id: idMismatchKey },
          'claim-owner',
        ),
        await attemptClaim(
          journal,
          'envelope-owner-mismatch',
          { document_id: ownerMismatchKey },
          'claim-owner',
        ),
      ];
      const rawSnapshots = [
        { document_id: idMismatchKey, value: await readRawBoard(idMismatchKey) },
        { document_id: innerDocumentId, value: await readRawBoard(innerDocumentId) },
        { document_id: ownerMismatchKey, value: await readRawBoard(ownerMismatchKey) },
      ];
      const readInner = await journal.read({ document_id: innerDocumentId });
      setScenario({
        read: readInner ?? null,
        pages: null,
        persists: [],
        claimAttempts,
        rawSnapshots,
      });
      setState('scenario-done');
    } catch (cause) {
      fail('scenario-error', cause);
    }
  };

  const runNonFiniteScenario = async () => {
    setError('');
    setScenario(null);
    setState('scenario-running');
    try {
      const badStoredDocumentId = 'fixture-nonfinite-stored';
      const nanNullDocumentId = 'fixture-nonfinite-nan-null';
      const badInputDocumentId = 'fixture-nonfinite-input';
      await seedRawValue(
        badStoredDocumentId,
        withRectWidth(badStoredDocumentId, 3, Number.NaN),
      );
      await seedRawValue(
        nanNullDocumentId,
        withRectWidth(nanNullDocumentId, 3, Number.NaN),
      );
      await seedRawValue(
        badInputDocumentId,
        withRectWidth(badInputDocumentId, 3, 4),
      );

      const journal = new InkBoardDraftJournalStore(indexedDbInkBoardDraftStorage);
      const persists = [
        await attemptPersist(
          journal,
          'nan-stored-valid-input',
          withRectWidth(badStoredDocumentId, 4, 5),
        ),
        await attemptPersist(
          journal,
          'nan-stored-null-input',
          withRectWidth(nanNullDocumentId, 3, null),
        ),
        await attemptPersist(
          journal,
          'infinite-input',
          withRectWidth(badInputDocumentId, 4, Number.POSITIVE_INFINITY),
        ),
      ];
      const readInput = await journal.read({ document_id: badInputDocumentId });
      setScenario({
        read: readInput ?? null,
        pages: null,
        persists,
      });
      setState('scenario-done');
    } catch (cause) {
      fail('scenario-error', cause);
    }
  };

  const runConcurrentSequenceScenario = async () => {
    setError('');
    setScenario(null);
    setState('scenario-running');
    try {
      const documentId = 'fixture-concurrent-sequence-document';
      const key = { document_id: documentId };
      const journalThree = new InkBoardDraftJournalStore(indexedDbInkBoardDraftStorage);
      const journalFour = new InkBoardDraftJournalStore(indexedDbInkBoardDraftStorage);
      const four = attemptPersist(journalFour, 'concurrent-4', {
        ...INK_DRAFT_SEQ3_FIXTURE,
        document_id: documentId,
        sequence: 4,
        updated_at: 4,
        changed: [{
          ...INK_DRAFT_SEQ3_FIXTURE.changed[0],
          chunk_id: 'fixture-board-chunk-concurrent-four',
        }],
      });
      const three = attemptPersist(journalThree, 'concurrent-3', {
        ...INK_DRAFT_SEQ3_FIXTURE,
        document_id: documentId,
        sequence: 3,
        updated_at: 3,
        changed: [{
          ...INK_DRAFT_SEQ3_FIXTURE.changed[0],
          chunk_id: 'fixture-board-chunk-concurrent-three',
        }],
      });
      const persists = await Promise.all([three, four]);
      const read = await journalThree.read(key);
      setScenario({ read: read ?? null, pages: null, persists });
      setState('scenario-done');
    } catch (cause) {
      fail('scenario-error', cause);
    }
  };

  const runResourceBoundaryScenario = async () => {
    setError('');
    setScenario(null);
    setState('scenario-running');
    try {
      const cycleDocumentId = 'fixture-resource-cycle';
      const depthDocumentId = 'fixture-resource-depth';
      await seedRawValue(cycleDocumentId, {
        ...INK_DRAFT_SEQ3_FIXTURE,
        document_id: cycleDocumentId,
      });
      await seedRawValue(depthDocumentId, {
        ...INK_DRAFT_SEQ3_FIXTURE,
        document_id: depthDocumentId,
      });

      const journal = new InkBoardDraftJournalStore(indexedDbInkBoardDraftStorage);
      const cycleChunk = {
        ...INK_DRAFT_SEQ3_FIXTURE.changed[0],
        chunk_id: 'fixture-board-chunk-cycle',
      } as Record<string, unknown>;
      cycleChunk.self = cycleChunk;
      const cycleRecord = {
        ...INK_DRAFT_SEQ3_FIXTURE,
        document_id: cycleDocumentId,
        sequence: 4,
        updated_at: 4,
        changed: [cycleChunk],
      } as unknown as InkBoardDraftRecord;

      let deep: Record<string, unknown> = {};
      for (let index = 0; index < 70; index += 1) deep = { next: deep };
      const depthRecord = {
        ...INK_DRAFT_SEQ3_FIXTURE,
        document_id: depthDocumentId,
        sequence: 4,
        updated_at: 4,
        changed: [{
          ...INK_DRAFT_SEQ3_FIXTURE.changed[0],
          chunk_id: 'fixture-board-chunk-depth',
          deep,
        }],
      } as unknown as InkBoardDraftRecord;

      const persists = [
        await attemptPersist(journal, 'cyclic-extra-field', cycleRecord),
        await attemptPersist(journal, 'deep-extra-field', depthRecord),
      ];
      const rawSnapshots = [
        { document_id: cycleDocumentId, value: await readRawBoard(cycleDocumentId) },
        { document_id: depthDocumentId, value: await readRawBoard(depthDocumentId) },
      ];
      setScenario({
        read: null,
        pages: null,
        persists,
        rawSnapshots,
      });
      setState('scenario-done');
    } catch (cause) {
      fail('scenario-error', cause);
    }
  };

  const cleanup = async () => {
    setError('');
    setState('cleaning');
    try {
      held.current?.close();
      held.current = null;
      detection.closeTracked();
      await deleteInkDraftDatabase();
      setState('cleaned');
    } catch (cause) {
      fail('cleanup-error', cause);
    }
  };

  return (
    <div>
      <div
        data-testid="ink-draft-db-status"
        data-state={state}
        data-error={error}
        data-snapshot={snapshot ? JSON.stringify(snapshot) : ''}
        data-result={scenario ? JSON.stringify(scenario) : ''}
      >
        {state}{error ? `: ${error}` : ''}
      </div>
      <button data-testid="ink-draft-db-prepare" onClick={prepare}>Prepare v1 database</button>
      <button data-testid="ink-draft-db-open" onClick={open}>Open v2</button>
      <button data-testid="ink-draft-db-hold" onClick={hold}>Hold v1 connection</button>
      <button data-testid="ink-draft-db-open-blocked" onClick={openBlocked}>Open v2 while blocked</button>
      <button data-testid="ink-draft-db-release" onClick={release}>Release v1 connection</button>
      <button data-testid="ink-draft-db-delete" onClick={remove}>Delete database</button>
      <button data-testid="ink-draft-db-scenario-stale" onClick={runStaleOverwriteScenario}>Persist newer then stale</button>
      <button data-testid="ink-draft-db-scenario-late" onClick={runLateResurrectScenario}>Discard then late persist</button>
      <button data-testid="ink-draft-db-scenario-equal" onClick={runEqualSequenceScenario}>Equal sequence retry and conflict</button>
      <button data-testid="ink-draft-db-scenario-owner" onClick={runOwnerScenario}>Reject stale owner</button>
      <button data-testid="ink-draft-db-scenario-claim-existing" onClick={runClaimExistingScenario}>Claim existing draft</button>
      <button data-testid="ink-draft-db-scenario-claim-missing" onClick={runClaimMissingScenario}>Claim missing draft</button>
      <button data-testid="ink-draft-db-scenario-claim-legacy" onClick={runClaimLegacyScenario}>Claim legacy draft</button>
      <button data-testid="ink-draft-db-scenario-discard-owner" onClick={runDiscardOwnerScenario}>Discard owner fence</button>
      <button data-testid="ink-draft-db-scenario-corrupt-envelope" onClick={runCorruptEnvelopeScenario}>Corrupt envelope</button>
      <button data-testid="ink-draft-db-scenario-nonfinite" onClick={runNonFiniteScenario}>Reject non-finite</button>
      <button data-testid="ink-draft-db-scenario-concurrent" onClick={runConcurrentSequenceScenario}>Concurrent sequences</button>
      <button data-testid="ink-draft-db-scenario-resource-boundary" onClick={runResourceBoundaryScenario}>Cyclic and deep payloads</button>
      <button data-testid="ink-draft-db-cleanup" onClick={cleanup}>Clean up</button>
    </div>
  );
}
