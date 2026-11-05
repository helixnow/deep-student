import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { inkApi, InkApiError, type InkChangedEvent } from './api';
import { inkDraftJournal, type InkDraftRecord } from './drafts';
import { hasDirtyInkEditor } from './editorSession';
import type { InkManifest, InkPage, InkPageRef, InkRuling } from './types';

export type InkSaveStatus = 'loading' | 'saved' | 'pending' | 'saving' | 'conflict' | 'offline' | 'storage-error';

export interface InkDocumentSnapshot {
  status: 'loading' | 'ready' | 'error';
  saveStatus: InkSaveStatus;
  manifest?: InkManifest;
  pageRef?: InkPageRef;
  page?: InkPage;
  error?: unknown;
  remoteReloadSequence: number;
}

export interface InkDocumentState extends InkDocumentSnapshot {
  getSnapshot(): InkDocumentSnapshot;
  savePage(page: InkPage, expectedRevision?: string): Promise<void>;
  selectPage(pageId: string): Promise<void>;
  appendPage(width: number, height: number, ruling: InkRuling): Promise<void>;
  rename(title: string): Promise<void>;
  reloadRemote(): Promise<void>;
  retrySave(): Promise<void>;
  retryDraftStorage(): Promise<void>;
  persistDraft(): Promise<InkDraftRecord | undefined>;
  flush(): Promise<void>;
  setActiveStroke(active: boolean): void;
}

interface CachedInkPage {
  page: InkPage;
  sequence: number;
  savedSequence: number;
  draft?: InkDraftRecord;
  operation?: { id: string; sequence: number; revision: string };
}

interface InkDocumentSession {
  documentId: string;
  status: InkDocumentSnapshot['status'];
  manifest?: InkManifest;
  baseRevision: string;
  pages: Map<string, CachedInkPage>;
  selectedPageId?: string;
  requestedPageId?: string;
  selectionRequest: number;
  loadRequest: number;
  editVersion: number;
  epoch: number;
  remoteReloadSequence: number;
  conflict: boolean;
  offline: boolean;
  storageError: boolean;
  saving: boolean;
  activeStroke: boolean;
  active: boolean;
  error?: unknown;
  ready?: Promise<void>;
  operation?: Promise<void>;
}

const documentSaveQueues = new Map<string, Promise<void>>();
const documentExitQueues = new Map<string, Promise<void>>();
const documentDraftQueues = new Map<string, Promise<void>>();
const documentSequences = new Map<string, number>();
const pendingSaveOperationIds = new Map<string, Set<string>>();

const operationId = (): string => globalThis.crypto?.randomUUID?.()
  ?? `ink-${Date.now()}-${Math.random().toString(36).slice(2)}`;

function serialize(queue: Map<string, Promise<void>>, documentId: string, task: () => Promise<void>): Promise<void> {
  const previous = queue.get(documentId) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(task);
  const queued = next.finally(() => {
    if (queue.get(documentId) === queued) queue.delete(documentId);
  });
  queue.set(documentId, queued);
  return queued;
}

export function enqueueInkDocumentExit(documentId: string, exit: () => Promise<void>): Promise<void> {
  return serialize(documentExitQueues, documentId, exit);
}

function nextSequence(documentId: string): number {
  const sequence = (documentSequences.get(documentId) ?? 0) + 1;
  documentSequences.set(documentId, sequence);
  return sequence;
}

function isDirty(entry: CachedInkPage): boolean {
  return entry.sequence > entry.savedSequence;
}

function dirtyPages(session: InkDocumentSession): CachedInkPage[] {
  return (session.manifest?.pages ?? []).flatMap(({ page_id }) => {
    const entry = session.pages.get(page_id);
    return entry && isDirty(entry) ? [entry] : [];
  });
}

function saveStatus(session: InkDocumentSession): InkSaveStatus {
  if (session.storageError) return 'storage-error';
  if (session.conflict) return 'conflict';
  if (session.status === 'loading') return 'loading';
  if (session.saving) return 'saving';
  if (!dirtyPages(session).length) return 'saved';
  return session.offline ? 'offline' : 'pending';
}

function snapshot(session: InkDocumentSession): InkDocumentSnapshot {
  return {
    status: session.status,
    saveStatus: saveStatus(session),
    manifest: session.manifest,
    pageRef: session.manifest?.pages.find(({ page_id }) => page_id === session.selectedPageId),
    page: session.pages.get(session.selectedPageId ?? '')?.page,
    error: session.error,
    remoteReloadSequence: session.remoteReloadSequence,
  };
}

function isConflict(error: unknown): boolean {
  return error instanceof InkApiError
    && (error.code === 'REVISION_CONFLICT' || error.code === 'OPERATION_STATE_UNKNOWN');
}

async function ownOperation<T>(documentId: string, id: string, task: () => Promise<T>): Promise<T> {
  const ids = pendingSaveOperationIds.get(documentId) ?? new Set<string>();
  ids.add(id);
  pendingSaveOperationIds.set(documentId, ids);
  try {
    return await task();
  } finally {
    ids.delete(id);
    if (!ids.size) pendingSaveOperationIds.delete(documentId);
  }
}

function draftRecord(session: InkDocumentSession, entry: CachedInkPage): InkDraftRecord {
  return {
    document_id: session.documentId,
    page_id: entry.page.page_id,
    base_revision: session.conflict ? entry.draft?.base_revision ?? session.baseRevision : session.baseRevision,
    sequence: entry.sequence,
    page: entry.page,
    updated_at: Date.now(),
    ...(session.conflict ? { save_state: 'conflict' as const } : session.offline ? { save_state: 'offline' as const } : {}),
  };
}

async function persistPageDraft(session: InkDocumentSession, entry: CachedInkPage): Promise<InkDraftRecord | undefined> {
  let persisted: InkDraftRecord | undefined;
  await serialize(documentDraftQueues, session.documentId, async () => {
    if (!isDirty(entry) || session.pages.get(entry.page.page_id) !== entry) return;
    const record = draftRecord(session, entry);
    const previous = entry.draft;
    if (previous?.sequence === record.sequence && previous.base_revision === record.base_revision && previous.save_state === record.save_state) {
      persisted = previous;
      return;
    }
    const stored = await inkDraftJournal.read(record);
    if (stored && stored.sequence > record.sequence) {
      session.conflict = true;
      throw new InkApiError({ code: 'REVISION_CONFLICT', message: 'A newer ink draft exists.', retryable: false });
    }
    await inkDraftJournal.persist(record);
    entry.draft = record;
    persisted = record;
  });
  return persisted;
}

async function persistSessionDrafts(session: InkDocumentSession, durableOnly = false): Promise<InkDraftRecord | undefined> {
  let last: InkDraftRecord | undefined;
  try {
    for (const entry of session.pages.values()) {
      if (isDirty(entry)) {
        if (!durableOnly || entry.draft) last = await persistPageDraft(session, entry) ?? last;
      } else if (entry.draft) {
        await discardPageDraft(session, entry, entry.savedSequence);
      }
    }
    session.storageError = false;
  } catch (error) {
    if (!isConflict(error)) session.storageError = true;
    session.error = error;
    throw error;
  }
  return last;
}

async function discardPageDraft(session: InkDocumentSession, entry: CachedInkPage, sequence: number): Promise<void> {
  await serialize(documentDraftQueues, session.documentId, async () => {
    await inkDraftJournal.discard({ document_id: session.documentId, page_id: entry.page.page_id }, sequence);
    if (entry.draft && entry.draft.sequence <= sequence) entry.draft = undefined;
  });
}

export function useInkDocument(documentId: string, requestedPageId?: string): InkDocumentState {
  const session = useMemo<InkDocumentSession>(() => ({
    documentId,
    status: 'loading',
    baseRevision: '',
    pages: new Map(),
    selectionRequest: 0,
    loadRequest: 0,
    editVersion: 0,
    epoch: 0,
    remoteReloadSequence: 0,
    conflict: false,
    offline: false,
    storageError: false,
    saving: false,
    activeStroke: false,
    active: false,
  }), [documentId]);
  session.requestedPageId = requestedPageId;
  const currentSessionRef = useRef(session);
  currentSessionRef.current = session;
  const [state, setState] = useState<InkDocumentSnapshot>(() => snapshot(session));
  const publish = useCallback(() => {
    if (session.active && currentSessionRef.current === session) setState(snapshot(session));
  }, [session]);
  const getSnapshot = useCallback(() => snapshot(session), [session]);

  const loadRemote = useCallback(async (restoreDrafts: boolean, editVersion = session.editVersion) => {
    const request = ++session.loadRequest;
    await documentExitQueues.get(session.documentId)?.catch(() => undefined);
    await documentSaveQueues.get(session.documentId)?.catch(() => undefined);
    const manifest = await inkApi.get({ document_id: session.documentId });
    const pageId = session.selectedPageId ?? session.requestedPageId ?? manifest.pages[0]?.page_id;
    if (!pageId || !manifest.pages.some(({ page_id }) => page_id === pageId)) throw new Error('The requested ink page does not exist.');
    await documentDraftQueues.get(session.documentId)?.catch(() => undefined);
    const [page, drafts] = await Promise.all([
      inkApi.getPage({ document_id: session.documentId, page_id: pageId }),
      restoreDrafts ? Promise.all(manifest.pages.map(({ page_id }) => inkDraftJournal.read({ document_id: session.documentId, page_id }))) : [],
    ]);
    if (request !== session.loadRequest) return;
    if (editVersion !== session.editVersion || session.activeStroke) {
      const error = new Error('Ink document changed during reload.');
      session.error = error;
      try { await persistSessionDrafts(session); } finally { publish(); }
      throw error;
    }
    session.manifest = manifest;
    session.baseRevision = manifest.revision;
    session.pages.clear();
    session.pages.set(pageId, { page, sequence: 0, savedSequence: 0 });
    session.selectedPageId = pageId;
    session.conflict = false;
    session.offline = false;
    session.storageError = false;
    for (const draft of drafts) {
      if (!draft) continue;
      const sequence = Math.max(1, draft.sequence);
      documentSequences.set(session.documentId, Math.max(documentSequences.get(session.documentId) ?? 0, sequence));
      session.pages.set(draft.page_id, { page: draft.page, sequence, savedSequence: 0, draft });
      session.conflict ||= draft.base_revision !== manifest.revision || draft.save_state === 'conflict';
      session.offline ||= draft.save_state === 'offline';
    }
    session.status = 'ready';
    session.error = undefined;
    publish();
  }, [publish, session]);

  const savePage = useCallback(async (page: InkPage, expectedRevision?: string) => {
    if (!session.manifest || page.page_id !== session.selectedPageId) return;
    if (expectedRevision !== undefined && session.baseRevision !== expectedRevision) throw new Error('Ink page revision changed before save');
    const entry = session.pages.get(page.page_id);
    if (!entry || entry.page === page) return;
    entry.page = page;
    entry.sequence = nextSequence(session.documentId);
    ++session.editVersion;
    publish();
  }, [publish, session]);

  const selectPage = useCallback(async (pageId: string) => {
    await session.ready;
    if (!session.manifest?.pages.some(({ page_id }) => page_id === pageId)) return;
    const request = ++session.selectionRequest;
    const epoch = session.epoch;
    if (!session.pages.has(pageId)) {
      const page = await inkApi.getPage({ document_id: session.documentId, page_id: pageId });
      if (epoch !== session.epoch) return;
      if (!session.pages.has(pageId)) session.pages.set(pageId, { page, sequence: 0, savedSequence: 0 });
    }
    if (request !== session.selectionRequest || epoch !== session.epoch) return;
    session.selectedPageId = pageId;
    publish();
  }, [publish, session]);

  const persistDraft = useCallback(async () => {
    try {
      return await persistSessionDrafts(session);
    } finally {
      publish();
    }
  }, [publish, session]);

  const flush = useCallback(async () => {
    const epoch = session.epoch;
    const queued = serialize(documentSaveQueues, session.documentId, async () => {
      await session.ready;
      if (epoch !== session.epoch || !session.manifest) throw new Error('Ink document changed before flush.');
      if (session.storageError) throw new Error('Ink recovery storage is unavailable.');
      if (session.conflict) {
        await persistSessionDrafts(session);
        throw new Error('Ink document has a conflicting draft.');
      }
      session.saving = true;
      publish();
      try {
        await persistSessionDrafts(session);
        while (true) {
          if (epoch !== session.epoch || session.conflict) throw new Error('Ink document changed during flush.');
          const entry = dirtyPages(session)[0];
          if (!entry) break;
          const record = await persistPageDraft(session, entry);
          if (epoch !== session.epoch || session.conflict) throw new Error('Ink document changed before save.');
          if (!record || record.sequence !== entry.sequence || record.base_revision !== session.baseRevision) continue;
          const page = record.page;
          const sequence = record.sequence;
          const revision = session.baseRevision;
          const operation = entry.operation?.sequence === sequence && entry.operation.revision === revision
            ? entry.operation : { id: operationId(), sequence, revision };
          entry.operation = operation;
          let manifest: InkManifest;
          try {
            manifest = await ownOperation(session.documentId, operation.id, () => inkApi.savePage({
              document_id: session.documentId,
              expected_revision: revision,
              operation_id: operation.id,
              page,
            }));
          } catch (error) {
            session.conflict ||= isConflict(error);
            session.offline = !session.conflict;
            throw error;
          }
          if (epoch !== session.epoch) throw new Error('Ink document changed during save.');
          session.manifest = manifest;
          session.baseRevision = manifest.revision;
          entry.savedSequence = sequence;
          entry.operation = undefined;
          try {
            await discardPageDraft(session, entry, sequence);
            await persistSessionDrafts(session);
          } catch (error) {
            if (!isConflict(error)) session.storageError = true;
            throw error;
          }
          publish();
        }
        session.offline = false;
        session.error = undefined;
        if (session.activeStroke) throw new Error('Ink editor has an unfinished gesture.');
      } catch (error) {
        session.error = error;
        await persistSessionDrafts(session);
        throw error;
      } finally {
        session.saving = false;
        publish();
      }
    });
    session.operation = queued;
    await queued;
  }, [publish, session]);

  const mutateManifest = useCallback(async (mutate: (revision: string, id: string) => Promise<InkManifest>, appended = false) => {
    const epoch = session.epoch;
    const selectionRequest = session.selectionRequest;
    const queued = serialize(documentSaveQueues, session.documentId, async () => {
      await session.ready;
      if (!session.manifest || epoch !== session.epoch || session.conflict || session.storageError) throw new Error('Ink document is not ready for this change.');
      const previous = session.manifest;
      try {
        const id = operationId();
        const manifest = await ownOperation(session.documentId, id, () => mutate(session.baseRevision, id));
        if (epoch !== session.epoch) return;
        session.manifest = manifest;
        session.baseRevision = manifest.revision;
        if (appended) {
          const pageRef = manifest.pages.find(({ page_id }) => !previous.pages.some((entry) => entry.page_id === page_id));
          if (pageRef) {
            session.pages.set(pageRef.page_id, { page: { schema_version: 1, page_id: pageRef.page_id, objects: [] }, sequence: 0, savedSequence: 0 });
            if (selectionRequest === session.selectionRequest) session.selectedPageId = pageRef.page_id;
          }
        }
        await persistSessionDrafts(session, true);
      } catch (error) {
        session.error = error;
        session.conflict ||= isConflict(error);
        if (session.conflict) await persistSessionDrafts(session);
        throw error;
      } finally {
        publish();
      }
    });
    session.operation = queued;
    await queued;
  }, [publish, session]);

  const appendPage = useCallback((width: number, height: number, ruling: InkRuling) => mutateManifest((expected_revision, operation_id) => inkApi.appendPage({
    document_id: session.documentId, expected_revision, operation_id, width, height, ruling,
  }), true), [mutateManifest, session]);

  const rename = useCallback(async (title: string) => {
    if (!title.trim()) return;
    await mutateManifest((expected_revision, operation_id) => inkApi.rename({
      document_id: session.documentId, expected_revision, operation_id, title: title.trim(),
    }));
  }, [mutateManifest, session]);

  const reloadRemote = useCallback(async () => {
    const editVersion = session.editVersion;
    await session.operation?.catch(() => undefined);
    const entries = [...session.pages.values()];
    ++session.epoch;
    ++session.selectionRequest;
    for (const entry of entries) await discardPageDraft(session, entry, entry.sequence);
    await loadRemote(false, editVersion);
    ++session.remoteReloadSequence;
    publish();
  }, [loadRemote, publish, session]);

  const retrySave = useCallback(async () => {
    if (session.conflict || session.storageError) return;
    await flush();
  }, [flush, session]);

  const retryDraftStorage = useCallback(async () => {
    if (!session.storageError) return;
    await persistDraft();
    if (!session.conflict) await flush();
  }, [flush, persistDraft, session]);

  useEffect(() => {
    session.active = true;
    session.ready = loadRemote(true).catch((error: unknown) => {
      if (!session.active) return;
      session.status = 'error';
      session.error = error;
      publish();
    });
    publish();
    return () => {
      session.active = false;
      ++session.loadRequest;
      void persistSessionDrafts(session).catch(() => undefined);
    };
  }, [loadRemote, publish, session]);

  useEffect(() => {
    if (requestedPageId && session.status === 'ready' && requestedPageId !== session.selectedPageId) {
      void selectPage(requestedPageId).catch((error: unknown) => { session.error = error; publish(); });
    }
  }, [publish, requestedPageId, selectPage, session, state.status]);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    void listen<InkChangedEvent>('ink:changed', async ({ payload }) => {
      if (cancelled || payload?.document_id !== session.documentId || !session.manifest) return;
      if (payload.operation_id && pendingSaveOperationIds.get(session.documentId)?.has(payload.operation_id)) return;
      const epoch = session.epoch;
      const baseRevision = session.baseRevision;
      const conflictIfDirty = async () => {
        if (!dirtyPages(session).length && !session.activeStroke && !session.saving && !hasDirtyInkEditor(session.documentId)) return false;
        session.conflict = true;
        try { await persistSessionDrafts(session); } finally { publish(); }
        return true;
      };
      try {
        const manifest = await inkApi.get({ document_id: session.documentId });
        if (cancelled || epoch !== session.epoch || baseRevision !== session.baseRevision || manifest.revision === session.baseRevision) return;
        if (await conflictIfDirty()) return;
        while (!cancelled && epoch === session.epoch) {
          const request = session.selectionRequest;
          const pageId = manifest.pages.some(({ page_id }) => page_id === session.selectedPageId) ? session.selectedPageId : manifest.pages[0]?.page_id;
          if (!pageId) return;
          const page = await inkApi.getPage({ document_id: session.documentId, page_id: pageId });
          if (cancelled || epoch !== session.epoch || baseRevision !== session.baseRevision || manifest.revision === session.baseRevision) return;
          if (await conflictIfDirty()) return;
          if (request !== session.selectionRequest) continue;
          session.manifest = manifest;
          session.baseRevision = manifest.revision;
          session.pages.clear();
          session.pages.set(pageId, { page, sequence: 0, savedSequence: 0 });
          session.selectedPageId = pageId;
          ++session.epoch;
          ++session.remoteReloadSequence;
          publish();
          return;
        }
      } catch {
        // Changed events are advisory; failed reads never replace local pages.
      }
    }).then((stop) => {
      if (cancelled) stop();
      else unlisten = stop;
    }).catch(() => undefined);
    return () => { cancelled = true; unlisten?.(); };
  }, [publish, session]);

  const setActiveStroke = useCallback((active: boolean) => { session.activeStroke = active; }, [session]);

  return { ...(currentSessionRef.current === session && state.manifest?.document_id === session.documentId ? state : snapshot(session)), getSnapshot, savePage, selectPage, appendPage, rename, reloadRemote, retrySave, retryDraftStorage, persistDraft, flush, setActiveStroke };
}
