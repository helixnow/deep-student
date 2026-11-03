import { useCallback, useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { inkApi, InkApiError, type InkChangedEvent } from './api';
import { inkDraftJournal, type InkDraftRecord } from './drafts';
import { hasDirtyInkEditor } from './editorSession';
import type { InkManifest, InkPage, InkPageRef, InkRuling } from './types';

export type InkSaveStatus = 'loading' | 'saved' | 'saving' | 'conflict' | 'offline' | 'storage-error';

export interface InkDocumentState {
  status: 'loading' | 'ready' | 'error';
  saveStatus: InkSaveStatus;
  manifest?: InkManifest;
  pageRef?: InkPageRef;
  page?: InkPage;
  error?: unknown;
  savePage(page: InkPage): Promise<void>;
  selectPage(pageId: string): Promise<void>;
  appendPage(width: number, height: number, ruling: InkRuling): Promise<void>;
  rename(title: string): Promise<void>;
  reloadRemote(): Promise<void>;
  retrySave(): Promise<void>;
  retryDraftStorage(): Promise<void>;
  persistDraft(): Promise<InkDraftRecord | undefined>;
  flush(): Promise<void>;
  setActiveStroke(active: boolean): void;
  remoteReloadSequence: number;
}

interface LoadedInkDocument {
  manifest: InkManifest;
  pageRef: InkPageRef;
  page: InkPage;
  base_revision: string;
  saveStatus: InkSaveStatus;
}

const documentSaveQueues = new Map<string, Promise<void>>();
const conflictedDocuments = new Set<string>();
const activeDocumentSequences = new Map<string, Set<number>>();
const pendingSaveOperationIds = new Map<string, Set<string>>();

const operationId = (): string => globalThis.crypto?.randomUUID?.()
  ?? `ink-${Date.now()}-${Math.random().toString(36).slice(2)}`;

function serializeDocumentSave(documentId: string, save: () => Promise<void>): Promise<void> {
  const previous = documentSaveQueues.get(documentId) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(save);
  const queued = next.finally(() => {
    if (documentSaveQueues.get(documentId) === queued) documentSaveQueues.delete(documentId);
  });
  documentSaveQueues.set(documentId, queued);
  return queued;
}

export function useInkDocument(documentId: string, requestedPageId?: string): InkDocumentState {
  const [state, setState] = useState<InkDocumentState>({
    status: 'loading',
    saveStatus: 'loading',
    savePage: async () => {},
    selectPage: async () => {},
    appendPage: async () => {},
    rename: async () => {},
    reloadRemote: async () => {},
    retrySave: async () => {},
    retryDraftStorage: async () => {},
    persistDraft: async () => undefined,
    flush: async () => {},
    setActiveStroke: () => {},
    remoteReloadSequence: 0,
  });
  const loadedRef = useRef<LoadedInkDocument | null>(null);
  const selectedPageIdRef = useRef(requestedPageId);
  const lastRequestedPageIdRef = useRef(requestedPageId);
  if (lastRequestedPageIdRef.current !== requestedPageId) {
    lastRequestedPageIdRef.current = requestedPageId;
    selectedPageIdRef.current = requestedPageId;
  }
  const sequenceRef = useRef(0);
  const queueRef = useRef<Promise<void>>(Promise.resolve());
  const latestSequenceRef = useRef(0);
  const loadRequestRef = useRef(0);
  const activeRef = useRef(true);
  const saveStatusRef = useRef<InkSaveStatus>('loading');
  const sequenceOnPageRef = useRef(0);
  const activeStrokeRef = useRef(false);
  const [remoteReloadSequence, setRemoteReloadSequence] = useState(0);

  const loadRemote = useCallback(async (restoreDraft: boolean): Promise<LoadedInkDocument> => {
    const requestId = ++loadRequestRef.current;
    const sequenceAtStart = sequenceRef.current;
    const manifest = await inkApi.get({ document_id: documentId });
    const pageId = selectedPageIdRef.current ?? manifest.pages[0]?.page_id;
    if (!pageId) throw new Error('Ink document has no pages.');
    const pageRef = manifest.pages.find((candidate) => candidate.page_id === pageId);
    if (!pageRef) throw new Error('The requested ink page does not exist.');
    const remotePage = await inkApi.getPage({ document_id: documentId, page_id: pageId });
    let loaded: LoadedInkDocument = {
      manifest,
      pageRef,
      page: remotePage,
      base_revision: manifest.revision,
      saveStatus: 'saved',
    };

    const draft = restoreDraft
      ? await inkDraftJournal.read({ document_id: documentId, page_id: pageId })
      : undefined;

    if (loadRequestRef.current !== requestId || sequenceRef.current !== sequenceAtStart) {
      return loadedRef.current ?? loaded;
    }

    if (draft) {
      sequenceRef.current = Math.max(sequenceRef.current, draft.sequence);
      const revisionChanged = draft.base_revision !== manifest.revision;
      const saveStatus: InkSaveStatus = revisionChanged || draft.save_state === 'conflict'
        ? 'conflict'
        : draft.save_state ?? 'offline';
      if (saveStatus === 'conflict') conflictedDocuments.add(documentId);
      loaded = {
        manifest,
        pageRef,
        page: draft.page,
        base_revision: draft.base_revision,
        saveStatus,
      };
    }

    loadedRef.current = loaded;
    saveStatusRef.current = loaded.saveStatus;
    latestSequenceRef.current = Math.max(latestSequenceRef.current, sequenceRef.current);
    return loaded;
  }, [documentId]);

  const publishLoaded = useCallback((loaded: LoadedInkDocument) => {
    if (!activeRef.current) return;
    saveStatusRef.current = loaded.saveStatus;
    setState((current) => ({
      ...current,
      status: 'ready',
      saveStatus: loaded.saveStatus,
      manifest: loaded.manifest,
      pageRef: loaded.pageRef,
      page: loaded.page,
      error: undefined,
    }));
  }, []);

  const selectPage = useCallback(async (pageId: string) => {
    await queueRef.current;
    const current = loadedRef.current;
    if (!current || !current.manifest.pages.some((pageRef) => pageRef.page_id === pageId)) return;
    selectedPageIdRef.current = pageId;
    const loaded = await loadRemote(true);
    publishLoaded(loaded);
  }, [loadRemote, publishLoaded]);

  const appendPage = useCallback(async (width: number, height: number, ruling: InkRuling) => {
    const current = loadedRef.current;
    if (!current) return;
    await queueRef.current;
    const latest = loadedRef.current;
    if (!latest || conflictedDocuments.has(documentId) || latest.saveStatus === 'conflict') return;
    let manifest: InkManifest;
    try {
      manifest = await inkApi.appendPage({
        document_id: documentId,
        expected_revision: latest.base_revision,
        operation_id: operationId(),
        width,
        height,
        ruling,
      });
    } catch (error) {
      if (error instanceof InkApiError && error.code === 'REVISION_CONFLICT') {
        conflictedDocuments.add(documentId);
        loadedRef.current = { ...latest, saveStatus: 'conflict' };
        setState((currentState) => ({ ...currentState, saveStatus: 'conflict' }));
      }
      throw error;
    }
    const pageRef = manifest.pages.find((entry) => !latest.manifest.pages.some((existing) => existing.page_id === entry.page_id));
    if (!pageRef) return;
    const page: InkPage = { schema_version: 1, page_id: pageRef.page_id, objects: [] };
    selectedPageIdRef.current = page.page_id;
    const loaded: LoadedInkDocument = { manifest, pageRef, page, base_revision: manifest.revision, saveStatus: 'saved' };
    loadedRef.current = loaded;
    publishLoaded(loaded);
  }, [documentId, publishLoaded]);

  const rename = useCallback(async (title: string) => {
    const current = loadedRef.current;
    if (!current || !title.trim()) return;
    await queueRef.current;
    const latest = loadedRef.current;
    if (!latest || conflictedDocuments.has(documentId) || latest.saveStatus === 'conflict') return;
    let manifest: InkManifest;
    try {
      manifest = await inkApi.rename({
        document_id: documentId,
        expected_revision: latest.base_revision,
        operation_id: operationId(),
        title: title.trim(),
      });
    } catch (error) {
      if (error instanceof InkApiError && error.code === 'REVISION_CONFLICT') {
        conflictedDocuments.add(documentId);
        loadedRef.current = { ...latest, saveStatus: 'conflict' };
        setState((currentState) => ({ ...currentState, saveStatus: 'conflict' }));
      }
      throw error;
    }
    const loaded = { ...latest, manifest, base_revision: manifest.revision };
    loadedRef.current = loaded;
    publishLoaded(loaded);
  }, [documentId, publishLoaded]);

  const reloadRemote = useCallback(async () => {
    const current = loadedRef.current;
    if (current) await inkDraftJournal.discard({ document_id: documentId, page_id: current.page.page_id }, Number.MAX_SAFE_INTEGER);
    conflictedDocuments.delete(documentId);
    const loaded = await loadRemote(false);
    setRemoteReloadSequence((sequence) => sequence + 1);
    publishLoaded(loaded);
  }, [documentId, loadRemote, publishLoaded]);

  const savePage = useCallback((page: InkPage): Promise<void> => {
    const initial = loadedRef.current;
    if (!initial || page.page_id !== initial.page.page_id) return Promise.resolve();
    const sequence = ++sequenceRef.current;
    latestSequenceRef.current = sequence;
    const key = { document_id: documentId, page_id: page.page_id };
    const saveOperationId = operationId();
    const nextStatus = initial.saveStatus === 'conflict' || initial.saveStatus === 'storage-error' ? initial.saveStatus : 'saving';
    saveStatusRef.current = nextStatus;
    sequenceOnPageRef.current = sequence;
    const activeSequences = activeDocumentSequences.get(documentId) ?? new Set<number>();
    activeSequences.add(sequence);
    activeDocumentSequences.set(documentId, activeSequences);
    const saveOperationIds = pendingSaveOperationIds.get(documentId) ?? new Set<string>();
    saveOperationIds.add(saveOperationId);
    pendingSaveOperationIds.set(documentId, saveOperationIds);
    loadedRef.current = { ...initial, page, saveStatus: nextStatus };
    setState((current) => ({ ...current, saveStatus: nextStatus, page }));
    const save = async (record: InkDraftRecord) => {
      const current = loadedRef.current;
      if (!current) return;
      if (conflictedDocuments.has(documentId) || current.saveStatus === 'conflict') {
        await inkDraftJournal.persist({ ...record, save_state: 'conflict' });
        if (latestSequenceRef.current === sequence) {
          const latest = loadedRef.current;
          if (latest) loadedRef.current = { ...latest, page, saveStatus: 'conflict' };
          saveStatusRef.current = 'conflict';
          if (activeRef.current) setState((currentState) => ({ ...currentState, saveStatus: 'conflict', page }));
        }
        return;
      }
      try {
        if (record.base_revision !== current.base_revision) {
          conflictedDocuments.add(documentId);
          await inkDraftJournal.persist({ ...record, save_state: 'conflict' });
          if (latestSequenceRef.current === sequence) {
            const latest = loadedRef.current;
            if (latest) loadedRef.current = { ...latest, page, saveStatus: 'conflict' };
            if (activeRef.current) setState((currentState) => ({ ...currentState, saveStatus: 'conflict', page }));
          }
          return;
        }
        const savedManifest = await inkApi.savePage({
          document_id: documentId,
          expected_revision: current.base_revision,
          operation_id: saveOperationId,
          page,
        });
        const nextPageRef = savedManifest.pages.find((entry) => entry.page_id === page.page_id);
        const latest = loadedRef.current;
        if (latest) loadedRef.current = {
          ...latest,
          manifest: savedManifest,
          pageRef: nextPageRef ?? latest.pageRef,
          base_revision: savedManifest.revision,
        };
        if (latestSequenceRef.current === sequence && latest) {
          loadedRef.current = { ...latest, manifest: savedManifest, pageRef: nextPageRef ?? latest.pageRef, base_revision: savedManifest.revision, page, saveStatus: 'saved' };
          if (activeRef.current) setState((currentState) => ({
            ...currentState,
            status: 'ready',
            saveStatus: 'saved',
            manifest: savedManifest,
            pageRef: nextPageRef ?? current.pageRef,
            page,
          }));
        }
        await inkDraftJournal.discard(key, sequence);
      } catch (error) {
        const conflict = error instanceof InkApiError
          && (error.code === 'REVISION_CONFLICT' || error.code === 'OPERATION_STATE_UNKNOWN');
        const saveStatus = conflict ? 'conflict' : 'offline';
        if (conflict) conflictedDocuments.add(documentId);
        try {
          await inkDraftJournal.persist({ ...record, save_state: saveStatus });
        } catch {
          if (latestSequenceRef.current === sequence) {
            const latest = loadedRef.current;
            if (latest) loadedRef.current = { ...latest, page, saveStatus: 'storage-error' };
            saveStatusRef.current = 'storage-error';
            if (activeRef.current) setState((currentState) => ({ ...currentState, saveStatus: 'storage-error', page }));
          }
          return;
        }
        const latest = loadedRef.current;
        if (latestSequenceRef.current === sequence && latest) {
          loadedRef.current = { ...latest, page, saveStatus };
          saveStatusRef.current = saveStatus;
          if (activeRef.current) setState((currentState) => ({ ...currentState, saveStatus, page }));
        }
      }
    };

    const queued = serializeDocumentSave(documentId, async () => {
      const current = loadedRef.current;
      if (!current || current.saveStatus === 'storage-error') return;
      const record: InkDraftRecord = {
        ...key,
        base_revision: current.base_revision,
        sequence,
        page,
        updated_at: Date.now(),
        ...(current.saveStatus === 'conflict' || current.saveStatus === 'offline' ? { save_state: current.saveStatus } : {}),
      };
      try {
        await inkDraftJournal.persist(record);
      } catch {
        if (latestSequenceRef.current === sequence) {
          const latest = loadedRef.current;
          if (latest) loadedRef.current = { ...latest, page, saveStatus: 'storage-error' };
          saveStatusRef.current = 'storage-error';
          if (activeRef.current) setState((currentState) => ({ ...currentState, saveStatus: 'storage-error', page }));
        }
        return;
      }
      await save(record);
    }).finally(() => {
      const sequences = activeDocumentSequences.get(documentId);
      sequences?.delete(sequence);
      if (sequences && sequences.size === 0) activeDocumentSequences.delete(documentId);
      const saveOperationIds = pendingSaveOperationIds.get(documentId);
      saveOperationIds?.delete(saveOperationId);
      if (saveOperationIds && saveOperationIds.size === 0) pendingSaveOperationIds.delete(documentId);
    });
    queueRef.current = queued;
    return queued;
  }, [documentId]);

  const retrySave = useCallback(async () => {
    const current = loadedRef.current;
    if (!current || current.saveStatus === 'conflict' || current.saveStatus === 'storage-error' || conflictedDocuments.has(documentId)) return;
    await savePage(current.page);
  }, [documentId, savePage]);

  const retryDraftStorage = useCallback(async () => {
    const current = loadedRef.current;
    if (!current || current.saveStatus !== 'storage-error') return;
    const sequence = Math.max(1, sequenceRef.current, latestSequenceRef.current);
    const record: InkDraftRecord = {
      document_id: documentId,
      page_id: current.page.page_id,
      base_revision: current.base_revision,
      sequence,
      page: current.page,
      updated_at: Date.now(),
    };
    try {
      await inkDraftJournal.persist(record);
      const latest = loadedRef.current;
      if (!latest || latest.page.page_id !== current.page.page_id) return;
      const recovered = { ...latest, saveStatus: 'offline' as const };
      loadedRef.current = recovered;
      saveStatusRef.current = 'offline';
      if (activeRef.current) setState((currentState) => ({ ...currentState, saveStatus: 'offline' }));
      await savePage(recovered.page);
    } catch {
      // Keep the non-durable storage-error state until a draft write succeeds.
    }
  }, [documentId, savePage]);

  const persistDraft = useCallback(async (): Promise<InkDraftRecord | undefined> => {
    const current = loadedRef.current;
    if (!current || current.saveStatus === 'saved' || current.saveStatus === 'loading') return undefined;
    const sequence = Math.max(1, sequenceRef.current, latestSequenceRef.current);
    sequenceRef.current = sequence;
    if (current.saveStatus === 'storage-error') return undefined;
    const record: InkDraftRecord = {
      document_id: documentId,
      page_id: current.page.page_id,
      base_revision: current.base_revision,
      sequence,
      page: current.page,
      updated_at: Date.now(),
      ...(current.saveStatus === 'conflict' || current.saveStatus === 'offline' ? { save_state: current.saveStatus } : {}),
    };
    try {
      await inkDraftJournal.persist(record);
      return record;
    } catch (error) {
      loadedRef.current = { ...current, saveStatus: 'storage-error' };
      saveStatusRef.current = 'storage-error';
      if (activeRef.current) setState((currentState) => ({ ...currentState, saveStatus: 'storage-error' }));
      throw error;
    }
  }, [documentId]);

  const flush = useCallback(async () => {
    await queueRef.current;
    const current = loadedRef.current;
    if (current && current.saveStatus !== 'saved') throw new Error('Ink editor has an unsaved draft.');
  }, []);

  useEffect(() => {
    activeRef.current = true;
    let cancelled = false;
    setState((current) => ({ ...current, status: 'loading', saveStatus: 'loading', error: undefined }));
    void loadRemote(true).then((loaded) => {
      if (!cancelled) publishLoaded(loaded);
    }).catch((error: unknown) => {
      if (!cancelled) setState((current) => ({ ...current, status: 'error', error }));
    });
    return () => {
      cancelled = true;
      activeRef.current = false;
    };
  }, [loadRemote, publishLoaded]);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    void listen<InkChangedEvent>('ink:changed', async ({ payload }) => {
      if (cancelled || payload?.document_id !== documentId) return;
      if (payload.operation_id && pendingSaveOperationIds.get(documentId)?.has(payload.operation_id)) return;
      const current = loadedRef.current;
      if (!current) return;
      const startSequence = sequenceRef.current;
      try {
        const manifest = await inkApi.get({ document_id: documentId });
        if (cancelled || sequenceRef.current !== startSequence) return;
        const beforeRead = loadedRef.current;
        if (!beforeRead || beforeRead.page.page_id !== current.page.page_id || manifest.revision === beforeRead.base_revision
          || !manifest.pages.some((pageRef) => pageRef.page_id === beforeRead.page.page_id)) return;
        const remotePage = await inkApi.getPage({ document_id: documentId, page_id: beforeRead.page.page_id });
        if (cancelled || sequenceRef.current !== startSequence) return;
        const latest = loadedRef.current;
        if (!latest || latest.page.page_id !== current.page.page_id) return;
        const hasPendingSave = (activeDocumentSequences.get(documentId)?.size ?? 0) > 0;
        const isDirty = activeStrokeRef.current || hasDirtyInkEditor(documentId) || hasPendingSave || latest.saveStatus !== 'saved' || conflictedDocuments.has(documentId);
        if (isDirty) {
          conflictedDocuments.add(documentId);
          saveStatusRef.current = 'conflict';
          loadedRef.current = { ...latest, manifest, pageRef: manifest.pages.find((pageRef) => pageRef.page_id === latest.page.page_id) ?? latest.pageRef, saveStatus: 'conflict' };
          setState((previous) => ({
            ...previous,
            status: 'ready',
            saveStatus: 'conflict',
            manifest,
            pageRef: manifest.pages.find((pageRef) => pageRef.page_id === latest.page.page_id) ?? latest.pageRef,
            page: latest.page,
          }));
          return;
        }
        const loaded: LoadedInkDocument = {
          manifest,
          pageRef: manifest.pages.find((pageRef) => pageRef.page_id === latest.page.page_id) ?? latest.pageRef,
          page: remotePage,
          base_revision: manifest.revision,
          saveStatus: 'saved',
        };
        loadedRef.current = loaded;
        saveStatusRef.current = 'saved';
        setRemoteReloadSequence((sequence) => sequence + 1);
        publishLoaded(loaded);
      } catch {
        // A changed event is advisory; current loaded page and its draft remain authoritative if refetch fails.
      }
    }).then((stop) => {
      if (cancelled) stop();
      else unlisten = stop;
    }).catch(() => undefined);
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [documentId, publishLoaded]);

  const setActiveStroke = useCallback((active: boolean) => { activeStrokeRef.current = active; }, []);

  return { ...state, savePage, selectPage, appendPage, rename, reloadRemote, retrySave, retryDraftStorage, persistDraft, flush, setActiveStroke, remoteReloadSequence };
}
