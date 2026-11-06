import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clearInkDiagnostics,
  getInkDiagnosticsSnapshot,
  setInkDiagnosticsEnabled,
  type InkDiagnosticRecord,
} from '../inkDiagnostics';
import { useInkDocument } from '../useInkDocument';
import type { InkManifest, InkObject, InkPage } from '../types';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  getPage: vi.fn(),
  savePage: vi.fn(),
  journalRead: vi.fn(),
  journalPersist: vi.fn(),
  journalDiscard: vi.fn(),
  listener: undefined as undefined | ((event: { payload: unknown }) => unknown),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (
    _event: string,
    listener: (event: { payload: unknown }) => unknown,
  ) => {
    mocks.listener = listener;
    return () => {
      mocks.listener = undefined;
    };
  }),
}));

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    inkApi: {
      ...actual.inkApi,
      get: mocks.get,
      getPage: mocks.getPage,
      savePage: mocks.savePage,
    },
  };
});

vi.mock('../drafts', () => ({
  inkDraftJournal: {
    read: mocks.journalRead,
    persist: mocks.journalPersist,
    discard: mocks.journalDiscard,
  },
}));

const PAGE_ID = 'ink_diag_page';

function makeTextObject(id: string): InkObject {
  return {
    id,
    author: 'user',
    created_at: 1,
    content: {
      kind: 'text',
      rect: { x: 0, y: 0, width: 10, height: 10 },
      text: 'diagnostic text must not leak',
      font_size: 12,
      color: '#000000',
    },
  };
}

function makePage(objects: InkObject[] = [makeTextObject('obj-a')]): InkPage {
  return { schema_version: 1, page_id: PAGE_ID, objects };
}

function makeManifest(documentId: string, revision = 'rev-1'): InkManifest {
  return {
    schema_version: 1,
    document_id: documentId,
    revision,
    title: 'Diagnostics',
    source: { kind: 'blank' },
    pages: [{
      page_id: PAGE_ID,
      width: 800,
      height: 600,
      background: { kind: 'blank', ruling: 'blank' },
      page_blob_hash: 'page-hash-1',
    }],
  };
}

function configureDocument(documentId: string, page: InkPage = makePage()): void {
  mocks.get.mockResolvedValue(makeManifest(documentId));
  mocks.getPage.mockResolvedValue(page);
  mocks.savePage.mockResolvedValue(makeManifest(documentId, 'rev-2'));
}

async function renderReady(documentId: string) {
  const hook = renderHook(() => useInkDocument(documentId));
  await waitFor(() => expect(hook.result.current.status).toBe('ready'));
  return hook;
}

async function emitChanged(payload: Record<string, unknown>): Promise<void> {
  await act(async () => {
    await mocks.listener?.({ payload });
  });
}

function recordsFor(event: string): readonly InkDiagnosticRecord[] {
  return getInkDiagnosticsSnapshot().records.filter((record) => record.event === event);
}

function onlyRecord(event: string): InkDiagnosticRecord {
  const matches = recordsFor(event);
  expect(matches).toHaveLength(1);
  return matches[0];
}

beforeEach(() => {
  setInkDiagnosticsEnabled(false);
  clearInkDiagnostics();
  mocks.listener = undefined;
  mocks.get.mockReset();
  mocks.getPage.mockReset();
  mocks.savePage.mockReset();
  mocks.journalRead.mockReset();
  mocks.journalPersist.mockReset();
  mocks.journalDiscard.mockReset();
  mocks.journalRead.mockResolvedValue(undefined);
  mocks.journalPersist.mockResolvedValue(undefined);
  mocks.journalDiscard.mockResolvedValue(undefined);
});

describe('useInkDocument diagnostics', () => {
  it('collects nothing and does not inspect page objects while disabled', async () => {
    const documentId = 'ink_diag_disabled';
    configureDocument(documentId);
    const page = makePage();
    let objectReads = 0;
    Object.defineProperty(page, 'objects', {
      configurable: true,
      get() {
        objectReads += 1;
        return [];
      },
    });

    const { result } = await renderReady(documentId);
    await act(async () => {
      await result.current.savePage(page);
    });

    expect(result.current.saveStatus).toBe('saved');
    expect(getInkDiagnosticsSnapshot().records).toHaveLength(0);
    expect(objectReads).toBe(0);
  });

  it('records the save pipeline in order with bounded identifiers and revisions', async () => {
    const documentId = 'ink_diag_success';
    configureDocument(documentId);
    setInkDiagnosticsEnabled(true);
    clearInkDiagnostics();
    const order: string[] = [];
    mocks.journalPersist.mockImplementation(async () => { order.push('draft'); });
    mocks.journalDiscard.mockImplementation(async () => { order.push('discard'); });
    mocks.savePage.mockImplementation(async () => {
      order.push('api');
      return makeManifest(documentId, 'rev-2');
    });

    const page = makePage();
    const { result } = await renderReady(documentId);
    await act(async () => {
      await result.current.savePage(page);
    });

    expect(result.current.saveStatus).toBe('saved');
    expect(order).toEqual(['draft', 'api', 'discard']);
    expect(recordsFor('save:queued')).toHaveLength(1);
    expect(recordsFor('save:draft-start')).toHaveLength(1);
    expect(recordsFor('save:draft-success')).toHaveLength(1);
    expect(recordsFor('save:api-start')).toHaveLength(1);
    expect(recordsFor('save:api-success')).toHaveLength(1);
    expect(recordsFor('save:finished')).toHaveLength(1);

    const queued = onlyRecord('save:queued');
    expect(queued.data).toMatchObject({
      docId: documentId,
      pageId: PAGE_ID,
      baseRevision: 'rev-1',
      saveStatus: 'saving',
      objectCount: 1,
      lastObjectId: 'obj-a',
    });
    expect(queued.data?.sequence).toEqual(expect.any(Number));
    expect(queued.data?.operationId).toEqual(expect.any(String));

    const apiSuccess = onlyRecord('save:api-success');
    expect(apiSuccess.data).toMatchObject({
      baseRevision: 'rev-1',
      resultRevision: 'rev-2',
      objectCount: 1,
      lastObjectId: 'obj-a',
    });

    const finished = onlyRecord('save:finished');
    expect(finished.data).toMatchObject({
      baseRevision: 'rev-1',
      resultRevision: 'rev-2',
      outcome: 'saved',
      objectCount: 1,
      lastObjectId: 'obj-a',
      isLatestSequence: true,
    });
    expect(JSON.stringify(getInkDiagnosticsSnapshot())).not.toContain('diagnostic text must not leak');
  });

  it('records a draft failure without changing the storage-error result', async () => {
    const documentId = 'ink_diag_draft_failure';
    configureDocument(documentId);
    setInkDiagnosticsEnabled(true);
    clearInkDiagnostics();
    mocks.journalPersist.mockRejectedValue(new Error('journal secret message'));

    const page = makePage();
    const { result } = await renderReady(documentId);
    await act(async () => {
      await result.current.savePage(page);
    });

    expect(result.current.saveStatus).toBe('storage-error');
    expect(mocks.savePage).not.toHaveBeenCalled();
    const failure = onlyRecord('save:draft-failure');
    expect(failure.data).toMatchObject({
      docId: documentId,
      pageId: PAGE_ID,
      phase: 'queued',
      errorType: 'Error',
      objectCount: 1,
      lastObjectId: 'obj-a',
    });
    expect(onlyRecord('save:finished').data).toMatchObject({
      outcome: 'storage-error',
      isLatestSequence: true,
    });
    await act(async () => {
      await expect(result.current.flush()).rejects.toThrow('Ink editor has an unsaved draft.');
    });
    expect(onlyRecord('flush:blocked').data).toMatchObject({
      docId: documentId,
      saveStatus: 'storage-error',
    });
    expect(JSON.stringify(getInkDiagnosticsSnapshot())).not.toContain('journal secret message');
  });

  it('records an api failure and preserves offline draft semantics', async () => {
    const documentId = 'ink_diag_api_failure';
    configureDocument(documentId);
    setInkDiagnosticsEnabled(true);
    clearInkDiagnostics();
    const { InkApiError } = await import('../api');
    mocks.savePage.mockRejectedValue(new InkApiError({
      code: 'UNAVAILABLE',
      message: 'api secret message',
      retryable: true,
    }));

    const page = makePage();
    const { result } = await renderReady(documentId);
    await act(async () => {
      await result.current.savePage(page);
    });

    expect(result.current.saveStatus).toBe('offline');
    expect(mocks.journalPersist).toHaveBeenCalledTimes(2);
    expect(mocks.journalPersist.mock.calls[1][0]).toMatchObject({ save_state: 'offline' });
    const failure = onlyRecord('save:api-failure');
    expect(failure.data).toMatchObject({
      docId: documentId,
      pageId: PAGE_ID,
      baseRevision: 'rev-1',
      conflict: false,
      errorType: 'InkApiError',
      errorCode: 'UNAVAILABLE',
    });
    expect(onlyRecord('save:finished').data).toMatchObject({
      outcome: 'offline',
      isLatestSequence: true,
    });
    expect(JSON.stringify(getInkDiagnosticsSnapshot())).not.toContain('api secret message');
  });

  it('records an own-save echo as ignored without refetching', async () => {
    const documentId = 'ink_diag_echo';
    configureDocument(documentId);
    setInkDiagnosticsEnabled(true);
    clearInkDiagnostics();
    let releaseDraft!: () => void;
    const draftGate = new Promise<void>((resolve) => { releaseDraft = resolve; });
    mocks.journalPersist.mockImplementationOnce(() => draftGate);

    const page = makePage();
    const { result } = await renderReady(documentId);
    let pending!: Promise<void>;
    act(() => {
      pending = result.current.savePage(page);
    });
    await waitFor(() => expect(recordsFor('save:queued')).toHaveLength(1));
    const operationId = String(onlyRecord('save:queued').data?.operationId);
    const getCallsBefore = mocks.get.mock.calls.length;

    await emitChanged({
      document_id: documentId,
      revision: 'rev-2',
      operation_id: operationId,
      affected_page_ids: [PAGE_ID],
    });

    const ignored = onlyRecord('changed:ignored');
    expect(ignored.data).toMatchObject({
      docId: documentId,
      reason: 'own-save-echo',
      operationId,
      revision: 'rev-2',
    });
    expect(mocks.get).toHaveBeenCalledTimes(getCallsBefore);

    await act(async () => {
      releaseDraft();
      await pending;
    });
    expect(result.current.saveStatus).toBe('saved');
  });

  it('records ignored revisions, clean remote reloads, and dirty conflicts', async () => {
    const documentId = 'ink_diag_changed';
    configureDocument(documentId);
    setInkDiagnosticsEnabled(true);
    clearInkDiagnostics();
    const { result } = await renderReady(documentId);
    const getPageCallsAfterLoad = mocks.getPage.mock.calls.length;

    await emitChanged({
      document_id: documentId,
      revision: 'rev-1',
      operation_id: 'other-unchanged',
      affected_page_ids: [PAGE_ID],
    });
    expect(onlyRecord('changed:ignored').data).toMatchObject({
      reason: 'revision-unchanged',
      baseRevision: 'rev-1',
      revision: 'rev-1',
    });
    expect(mocks.getPage).toHaveBeenCalledTimes(getPageCallsAfterLoad);

    mocks.get.mockResolvedValue(makeManifest(documentId, 'rev-2'));
    mocks.getPage.mockResolvedValue(makePage([makeTextObject('remote-a')]));
    await emitChanged({
      document_id: documentId,
      revision: 'rev-2',
      operation_id: 'other-clean',
      affected_page_ids: [PAGE_ID],
    });
    expect(result.current.manifest?.revision).toBe('rev-2');
    expect(result.current.remoteReloadSequence).toBe(1);
    expect(onlyRecord('changed:remote-reload').data).toMatchObject({
      previousRevision: 'rev-1',
      remoteRevision: 'rev-2',
      objectCount: 1,
      lastObjectId: 'remote-a',
    });

    act(() => result.current.setActiveStroke(true));
    mocks.get.mockResolvedValue(makeManifest(documentId, 'rev-3'));
    mocks.getPage.mockResolvedValue(makePage([makeTextObject('remote-b')]));
    await emitChanged({
      document_id: documentId,
      revision: 'rev-3',
      operation_id: 'other-conflict',
      affected_page_ids: [PAGE_ID],
    });

    expect(result.current.saveStatus).toBe('conflict');
    const conflict = onlyRecord('changed:conflict');
    expect(conflict.data).toMatchObject({
      baseRevision: 'rev-2',
      remoteRevision: 'rev-3',
      reasons: ['active-stroke'],
      objectCount: 1,
      lastObjectId: 'remote-a',
    });
  });
});
