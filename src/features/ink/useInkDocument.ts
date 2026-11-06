import { useCallback, useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { inkApi, InkApiError, type InkChangedEvent } from './api';
import { inkDraftJournal, type InkDraftRecord } from './drafts';
import { hasDirtyInkEditor } from './editorSession';
import { isInkDiagnosticsEnabled, recordInkDiagnostic } from './inkDiagnostics';
import type { InkManifest, InkPage, InkPageRef, InkRuling } from './types';

export type InkSaveStatus = 'loading' | 'saved' | 'saving' | 'conflict' | 'offline' | 'storage-error';

export interface InkDocumentState {
  status: 'loading' | 'ready' | 'error';
  saveStatus: InkSaveStatus;
  manifest?: InkManifest;
  pageRef?: InkPageRef;
  page?: InkPage;
  error?: unknown;
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

function diagnosticsOn(): boolean {
  try {
    return isInkDiagnosticsEnabled();
  } catch {
    return false;
  }
}

function logDiagnostic(event: string, data: Record<string, unknown>): void {
  if (!diagnosticsOn()) return;
  try {
    recordInkDiagnostic(event, data);
  } catch {
    // Diagnostics are a pure side channel; they must never affect persistence.
  }
}

/** Error metadata only: never copy a message, stack, cause, or arbitrary payload. */
function diagnosticError(error: unknown): Record<string, unknown> {
  try {
    if (error && typeof error === 'object') {
      const candidate = error as { code?: unknown; constructor?: { name?: unknown } };
      const constructorName = candidate.constructor?.name;
      const errorType = typeof constructorName === 'string' && constructorName
        ? constructorName
        : 'Object';
      return typeof candidate.code === 'string'
        ? { errorType, errorCode: candidate.code }
        : { errorType };
    }
    return { errorType: typeof error };
  } catch {
    return { errorType: 'unknown' };
  }
}

/** Bounded page summary: never retain or clone page objects or samples. */
function pageDiagnosticFields(page: InkPage): Record<string, unknown> {
  try {
    const count = page.objects.length;
    const lastObjectId = count > 0 ? page.objects[count - 1]?.id : undefined;
    return {
      pageId: page.page_id,
      objectCount: count,
      ...(lastObjectId ? { lastObjectId } : {}),
    };
  } catch {
    return {};
  }
}

function logPageDiagnostic(
  event: string,
  documentId: string,
  page: InkPage,
  data: Record<string, unknown> = {},
): void {
  if (!diagnosticsOn()) return;
  try {
    logDiagnostic(event, { docId: documentId, ...pageDiagnosticFields(page), ...data });
  } catch {
    // Never let a malformed page summary affect document persistence.
  }
}

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
    if (diagnosticsOn()) {
      logDiagnostic('load:start', {
        docId: documentId,
        restoreDraft,
        requestedPageId: selectedPageIdRef.current ?? null,
      });
    }
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
      if (diagnosticsOn()) {
        logDiagnostic('load:stale', {
          docId: documentId,
          pageId,
          reason: loadRequestRef.current !== requestId ? 'superseded' : 'sequence-changed',
          requestId,
          currentRequestId: loadRequestRef.current,
          sequenceAtStart,
          currentSequence: sequenceRef.current,
        });
      }
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
    logPageDiagnostic('load:success', documentId, loaded.page, {
      restoreDraft,
      draftRestored: Boolean(draft),
      baseRevision: loaded.base_revision,
      manifestRevision: manifest.revision,
      pageCount: manifest.pages.length,
      saveStatus: loaded.saveStatus,
    });
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
    if (diagnosticsOn()) {
      logDiagnostic('remote:reload-start', {
        docId: documentId,
        pageId: current?.page.page_id,
        previousRevision: current?.base_revision,
        saveStatus: current?.saveStatus,
      });
    }
    if (current) await inkDraftJournal.discard({ document_id: documentId, page_id: current.page.page_id }, Number.MAX_SAFE_INTEGER);
    conflictedDocuments.delete(documentId);
    const loaded = await loadRemote(false);
    setRemoteReloadSequence((sequence) => sequence + 1);
    publishLoaded(loaded);
    logPageDiagnostic('remote:reload-success', documentId, loaded.page, {
      previousRevision: current?.base_revision,
      baseRevision: loaded.base_revision,
    });
  }, [documentId, loadRemote, publishLoaded]);

  const savePage = useCallback((page: InkPage, expectedRevision?: string): Promise<void> => {
    const initial = loadedRef.current;
    if (!initial || page.page_id !== initial.page.page_id) {
      logPageDiagnostic('save:skipped', documentId, page, {
        reason: !initial ? 'no-loaded-document' : 'page-mismatch',
        loadedPageId: initial?.page.page_id,
      });
      return Promise.resolve();
    }
    // Optional atomic guard for queued callers (e.g. paste): refuse before touching
    // refs/state when the loaded base revision no longer matches the click target.
    if (expectedRevision !== undefined && initial.base_revision !== expectedRevision) {
      logPageDiagnostic('save:skipped', documentId, page, {
        reason: 'expected-revision-mismatch',
        expectedRevision,
        baseRevision: initial.base_revision,
      });
      return Promise.reject(new Error('Ink page revision changed before save'));
    }
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
    logPageDiagnostic('save:queued', documentId, page, {
      sequence,
      operationId: saveOperationId,
      baseRevision: initial.base_revision,
      saveStatus: nextStatus,
    });
    let saveOutcome = 'not-started';
    let saveStage: 'queue' | 'api' | 'apply' | 'discard' = 'queue';
    let saveBaseRevision = initial.base_revision;
    let saveResultRevision: string | undefined;
    const save = async (record: InkDraftRecord) => {
      const current = loadedRef.current;
      if (!current) {
        saveOutcome = 'skipped-no-document';
        logPageDiagnostic('save:skipped', documentId, page, {
          reason: 'document-unloaded',
          sequence,
          operationId: saveOperationId,
        });
        return;
      }
      if (conflictedDocuments.has(documentId) || current.saveStatus === 'conflict') {
        saveOutcome = 'conflict';
        logPageDiagnostic('save:skipped', documentId, page, {
          reason: 'already-conflicted',
          sequence,
          operationId: saveOperationId,
          baseRevision: record.base_revision,
          saveStatus: current.saveStatus,
        });
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
          saveOutcome = 'conflict';
          logPageDiagnostic('save:conflict', documentId, page, {
            reason: 'base-revision-changed',
            sequence,
            operationId: saveOperationId,
            baseRevision: record.base_revision,
            currentRevision: current.base_revision,
          });
          conflictedDocuments.add(documentId);
          await inkDraftJournal.persist({ ...record, save_state: 'conflict' });
          if (latestSequenceRef.current === sequence) {
            const latest = loadedRef.current;
            if (latest) loadedRef.current = { ...latest, page, saveStatus: 'conflict' };
            if (activeRef.current) setState((currentState) => ({ ...currentState, saveStatus: 'conflict', page }));
          }
          return;
        }
        saveStage = 'api';
        logPageDiagnostic('save:api-start', documentId, page, {
          sequence,
          operationId: saveOperationId,
          baseRevision: current.base_revision,
        });
        const savedManifest = await inkApi.savePage({
          document_id: documentId,
          expected_revision: current.base_revision,
          operation_id: saveOperationId,
          page,
        });
        saveResultRevision = savedManifest.revision;
        saveStage = 'apply';
        logPageDiagnostic('save:api-success', documentId, page, {
          sequence,
          operationId: saveOperationId,
          baseRevision: current.base_revision,
          resultRevision: savedManifest.revision,
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
        saveStage = 'discard';
        await inkDraftJournal.discard(key, sequence);
        saveOutcome = 'saved';
      } catch (error) {
        const conflict = error instanceof InkApiError
          && (error.code === 'REVISION_CONFLICT' || error.code === 'OPERATION_STATE_UNKNOWN');
        const saveStatus = conflict ? 'conflict' : 'offline';
        saveOutcome = saveStatus;
        if (diagnosticsOn()) {
          const failureEvent = saveStage === 'discard'
            ? 'save:discard-failure'
            : saveStage === 'apply'
              ? 'save:apply-failure'
              : 'save:api-failure';
          logDiagnostic(failureEvent, {
            docId: documentId,
            ...pageDiagnosticFields(page),
            sequence,
            operationId: saveOperationId,
            baseRevision: record.base_revision,
            currentRevision: current.base_revision,
            resultRevision: saveResultRevision,
            conflict,
            ...diagnosticError(error),
          });
        }
        if (conflict) conflictedDocuments.add(documentId);
        try {
          await inkDraftJournal.persist({ ...record, save_state: saveStatus });
        } catch (fallbackError) {
          saveOutcome = 'storage-error';
          if (diagnosticsOn()) {
            logDiagnostic('save:draft-failure', {
              docId: documentId,
              ...pageDiagnosticFields(page),
              sequence,
              operationId: saveOperationId,
              baseRevision: record.base_revision,
              phase: 'failure-fallback',
              saveState: saveStatus,
              ...diagnosticError(fallbackError),
            });
          }
          if (latestSequenceRef.current === sequence) {
            const latest = loadedRef.current;
            if (latest) loadedRef.current = { ...latest, page, saveStatus: 'storage-error' };
            saveStatusRef.current = 'storage-error';
            if (activeRef.current) setState((currentState) => ({ ...currentState, saveStatus: 'storage-error', page }));
          }
          return;
        }
        if (diagnosticsOn()) {
          logDiagnostic('save:draft-success', {
            docId: documentId,
            ...pageDiagnosticFields(page),
            sequence,
            operationId: saveOperationId,
            baseRevision: record.base_revision,
            phase: 'failure-fallback',
            saveState: saveStatus,
          });
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
      if (!current || current.saveStatus === 'storage-error') {
        saveOutcome = current ? 'skipped-storage-error' : 'skipped-no-document';
        logPageDiagnostic('save:skipped', documentId, page, {
          reason: current ? 'storage-error' : 'document-unloaded',
          sequence,
          operationId: saveOperationId,
          saveStatus: current?.saveStatus,
        });
        return;
      }
      const record: InkDraftRecord = {
        ...key,
        base_revision: current.base_revision,
        sequence,
        page,
        updated_at: Date.now(),
        ...(current.saveStatus === 'conflict' || current.saveStatus === 'offline' ? { save_state: current.saveStatus } : {}),
      };
      saveBaseRevision = record.base_revision;
      logPageDiagnostic('save:draft-start', documentId, page, {
        sequence,
        operationId: saveOperationId,
        baseRevision: record.base_revision,
        phase: 'queued',
        saveState: record.save_state,
      });
      try {
        await inkDraftJournal.persist(record);
      } catch (error) {
        saveOutcome = 'storage-error';
        if (diagnosticsOn()) {
          logDiagnostic('save:draft-failure', {
            docId: documentId,
            ...pageDiagnosticFields(page),
            sequence,
            operationId: saveOperationId,
            baseRevision: record.base_revision,
            phase: 'queued',
            ...diagnosticError(error),
          });
        }
        if (latestSequenceRef.current === sequence) {
          const latest = loadedRef.current;
          if (latest) loadedRef.current = { ...latest, page, saveStatus: 'storage-error' };
          saveStatusRef.current = 'storage-error';
          if (activeRef.current) setState((currentState) => ({ ...currentState, saveStatus: 'storage-error', page }));
        }
        return;
      }
      logPageDiagnostic('save:draft-success', documentId, page, {
        sequence,
        operationId: saveOperationId,
        baseRevision: record.base_revision,
        phase: 'queued',
        saveState: record.save_state,
      });
      await save(record);
    }).finally(() => {
      const sequences = activeDocumentSequences.get(documentId);
      sequences?.delete(sequence);
      if (sequences && sequences.size === 0) activeDocumentSequences.delete(documentId);
      const saveOperationIds = pendingSaveOperationIds.get(documentId);
      saveOperationIds?.delete(saveOperationId);
      if (saveOperationIds && saveOperationIds.size === 0) pendingSaveOperationIds.delete(documentId);
      logPageDiagnostic('save:finished', documentId, page, {
        sequence,
        operationId: saveOperationId,
        baseRevision: saveBaseRevision,
        resultRevision: saveResultRevision,
        outcome: saveOutcome,
        isLatestSequence: latestSequenceRef.current === sequence,
      });
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
    logPageDiagnostic('draft:retry-start', documentId, current.page, {
      sequence,
      baseRevision: current.base_revision,
      saveStatus: current.saveStatus,
    });
    try {
      await inkDraftJournal.persist(record);
      logPageDiagnostic('draft:retry-success', documentId, current.page, {
        sequence,
        baseRevision: current.base_revision,
      });
      const latest = loadedRef.current;
      if (!latest || latest.page.page_id !== current.page.page_id) return;
      const recovered = { ...latest, saveStatus: 'offline' as const };
      loadedRef.current = recovered;
      saveStatusRef.current = 'offline';
      if (activeRef.current) setState((currentState) => ({ ...currentState, saveStatus: 'offline' }));
      await savePage(recovered.page);
    } catch (error) {
      if (diagnosticsOn()) {
        logDiagnostic('draft:retry-failure', {
          docId: documentId,
          ...pageDiagnosticFields(current.page),
          sequence,
          baseRevision: current.base_revision,
          ...diagnosticError(error),
        });
      }
      // Keep the non-durable storage-error state until a draft write succeeds.
    }
  }, [documentId, savePage]);

  const persistDraft = useCallback(async (): Promise<InkDraftRecord | undefined> => {
    const current = loadedRef.current;
    if (!current || current.saveStatus === 'saved' || current.saveStatus === 'loading') {
      if (!current) {
        logDiagnostic('draft:persist-skipped', { docId: documentId, reason: 'no-loaded-document' });
      } else {
        logPageDiagnostic('draft:persist-skipped', documentId, current.page, {
          reason: current.saveStatus === 'saved' ? 'already-saved' : 'loading',
          saveStatus: current.saveStatus,
        });
      }
      return undefined;
    }
    const sequence = Math.max(1, sequenceRef.current, latestSequenceRef.current);
    sequenceRef.current = sequence;
    if (current.saveStatus === 'storage-error') {
      logPageDiagnostic('draft:persist-skipped', documentId, current.page, {
        reason: 'storage-error',
        saveStatus: current.saveStatus,
      });
      return undefined;
    }
    const record: InkDraftRecord = {
      document_id: documentId,
      page_id: current.page.page_id,
      base_revision: current.base_revision,
      sequence,
      page: current.page,
      updated_at: Date.now(),
      ...(current.saveStatus === 'conflict' || current.saveStatus === 'offline' ? { save_state: current.saveStatus } : {}),
    };
    logPageDiagnostic('draft:persist-start', documentId, current.page, {
      sequence,
      baseRevision: current.base_revision,
      saveState: record.save_state,
      saveStatus: current.saveStatus,
    });
    try {
      await inkDraftJournal.persist(record);
      logPageDiagnostic('draft:persist-success', documentId, current.page, {
        sequence,
        baseRevision: current.base_revision,
        saveState: record.save_state,
      });
      return record;
    } catch (error) {
      if (diagnosticsOn()) {
        logDiagnostic('draft:persist-failure', {
          docId: documentId,
          ...pageDiagnosticFields(current.page),
          sequence,
          baseRevision: current.base_revision,
          ...diagnosticError(error),
        });
      }
      loadedRef.current = { ...current, saveStatus: 'storage-error' };
      saveStatusRef.current = 'storage-error';
      if (activeRef.current) setState((currentState) => ({ ...currentState, saveStatus: 'storage-error' }));
      throw error;
    }
  }, [documentId]);

  const flush = useCallback(async () => {
    logDiagnostic('flush:start', {
      docId: loadedRef.current?.manifest.document_id,
      saveStatus: loadedRef.current?.saveStatus,
    });
    await queueRef.current;
    const current = loadedRef.current;
    if (current && current.saveStatus !== 'saved') {
      logDiagnostic('flush:blocked', {
        docId: current.manifest.document_id,
        saveStatus: current.saveStatus,
      });
      throw new Error('Ink editor has an unsaved draft.');
    }
    logDiagnostic('flush:clean', {
      docId: current?.manifest.document_id,
      saveStatus: current?.saveStatus ?? 'missing',
    });
  }, []);

  useEffect(() => {
    activeRef.current = true;
    let cancelled = false;
    setState((current) => ({ ...current, status: 'loading', saveStatus: 'loading', error: undefined }));
    void loadRemote(true).then((loaded) => {
      if (!cancelled) publishLoaded(loaded);
    }).catch((error: unknown) => {
      if (!cancelled) {
        if (diagnosticsOn()) {
          logDiagnostic('load:failure', {
            docId: documentId,
            restoreDraft: true,
            ...diagnosticError(error),
          });
        }
        setState((current) => ({ ...current, status: 'error', error }));
      }
    });
    return () => {
      cancelled = true;
      activeRef.current = false;
    };
  }, [documentId, loadRemote, publishLoaded]);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    void listen<InkChangedEvent>('ink:changed', async ({ payload }) => {
      if (cancelled || payload?.document_id !== documentId) return;
      if (payload.operation_id && pendingSaveOperationIds.get(documentId)?.has(payload.operation_id)) {
        logDiagnostic('changed:ignored', {
          docId: documentId,
          reason: 'own-save-echo',
          operationId: payload.operation_id,
          revision: payload.revision,
        });
        return;
      }
      const current = loadedRef.current;
      if (!current) {
        logDiagnostic('changed:ignored', {
          docId: documentId,
          reason: 'no-loaded-document',
          operationId: payload.operation_id,
          revision: payload.revision,
        });
        return;
      }
      const startSequence = sequenceRef.current;
      try {
        const manifest = await inkApi.get({ document_id: documentId });
        if (cancelled || sequenceRef.current !== startSequence) {
          logDiagnostic('changed:ignored', {
            docId: documentId,
            reason: cancelled ? 'listener-cancelled' : 'stale-sequence',
            revision: payload.revision,
            startSequence,
            currentSequence: sequenceRef.current,
          });
          return;
        }
        const beforeRead = loadedRef.current;
        if (!beforeRead || beforeRead.page.page_id !== current.page.page_id || manifest.revision === beforeRead.base_revision
          || !manifest.pages.some((pageRef) => pageRef.page_id === beforeRead.page.page_id)) {
          if (diagnosticsOn()) {
            const reason = !beforeRead
              ? 'no-loaded-document'
              : beforeRead.page.page_id !== current.page.page_id
                ? 'page-changed'
                : manifest.revision === beforeRead.base_revision
                  ? 'revision-unchanged'
                  : 'page-missing';
            logDiagnostic('changed:ignored', {
              docId: documentId,
              pageId: beforeRead?.page.page_id ?? current.page.page_id,
              reason,
              operationId: payload.operation_id,
              revision: payload.revision,
              baseRevision: beforeRead?.base_revision,
              objectCount: beforeRead?.page.objects.length,
            });
          }
          return;
        }
        const remotePage = await inkApi.getPage({ document_id: documentId, page_id: beforeRead.page.page_id });
        if (cancelled || sequenceRef.current !== startSequence) {
          logDiagnostic('changed:ignored', {
            docId: documentId,
            pageId: beforeRead.page.page_id,
            reason: cancelled ? 'listener-cancelled' : 'stale-after-page-fetch',
            revision: payload.revision,
            startSequence,
            currentSequence: sequenceRef.current,
          });
          return;
        }
        const latest = loadedRef.current;
        if (!latest || latest.page.page_id !== current.page.page_id) {
          logDiagnostic('changed:ignored', {
            docId: documentId,
            pageId: beforeRead.page.page_id,
            reason: 'page-changed-after-page-fetch',
            revision: payload.revision,
          });
          return;
        }
        const hasPendingSave = (activeDocumentSequences.get(documentId)?.size ?? 0) > 0;
        const isDirty = activeStrokeRef.current || hasDirtyInkEditor(documentId) || hasPendingSave || latest.saveStatus !== 'saved' || conflictedDocuments.has(documentId);
        if (isDirty) {
          if (diagnosticsOn()) {
            const reasons: string[] = [];
            if (activeStrokeRef.current) reasons.push('active-stroke');
            if (hasDirtyInkEditor(documentId)) reasons.push('dirty-editor');
            if (hasPendingSave) reasons.push('pending-save');
            if (latest.saveStatus !== 'saved') reasons.push(`save-status:${latest.saveStatus}`);
            if (conflictedDocuments.has(documentId)) reasons.push('conflict-marked');
            logPageDiagnostic('changed:conflict', documentId, latest.page, {
              reason: reasons.join(','),
              reasons,
              operationId: payload.operation_id,
              baseRevision: latest.base_revision,
              remoteRevision: manifest.revision,
            });
          }
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
        logPageDiagnostic('changed:remote-reload', documentId, remotePage, {
          previousRevision: latest.base_revision,
          remoteRevision: manifest.revision,
          operationId: payload.operation_id,
        });
        loadedRef.current = loaded;
        saveStatusRef.current = 'saved';
        setRemoteReloadSequence((sequence) => sequence + 1);
        publishLoaded(loaded);
      } catch (error) {
        if (diagnosticsOn()) {
          logDiagnostic('changed:fetch-failure', {
            docId: documentId,
            operationId: payload.operation_id,
            revision: payload.revision,
            ...diagnosticError(error),
          });
        }
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
