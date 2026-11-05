import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { inkDraftJournal, type InkDraftRecord } from '../drafts';
import { flushInkEditor, hasDirtyInkEditor } from '../editorSession';
import { InkEditor } from '../InkEditor';
import zh from '@/locales/zh-CN/ink.json';
import en from '@/locales/en-US/ink.json';
import type { InkManifest, InkPage } from '../types';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listener: undefined as undefined | ((event: { payload: unknown }) => unknown),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (_event: string, listener: (event: { payload: unknown }) => unknown) => {
    mocks.listener = listener;
    return () => { if (mocks.listener === listener) mocks.listener = undefined; };
  }),
}));
vi.mock('../renderer', () => ({ renderInkPage: vi.fn() }));
vi.mock('../useInkBackground', () => ({ useInkBackground: () => ({ error: false }) }));
vi.mock('@/hooks/useBreakpoint', () => ({ useIsMobile: () => false }));

class TestPointerEvent extends MouseEvent {
  readonly pointerId: number;
  readonly pointerType: string;
  readonly pressure: number;
  constructor(type: string, init: MouseEventInit & { pointerId?: number; pointerType?: string; pressure?: number } = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 7;
    this.pointerType = init.pointerType ?? 'pen';
    this.pressure = init.pressure ?? 0.5;
  }
}

const documentId = 'paged-host-flush';
const emptyPage = (page_id: string): InkPage => ({ schema_version: 1, page_id, objects: [] });
let manifest: InkManifest;
let pages: Map<string, InkPage>;
let drafts: Map<string, InkDraftRecord>;
let saves: Array<{ document_id: string; expected_revision: string; operation_id: string; page: InkPage }>;
let journalAtCas: Array<InkDraftRecord | undefined>;
let saveGate: { promise: Promise<void>; resolve(): void } | undefined;
let saveError: unknown;

beforeEach(() => {
  localStorage.clear();
  mocks.invoke.mockReset();
  mocks.listener = undefined;
  vi.stubGlobal('PointerEvent', TestPointerEvent);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ clearRect: vi.fn() } as unknown as CanvasRenderingContext2D);
  manifest = {
    schema_version: 1, document_id: documentId, revision: 'rev-1', title: 'Paged flush', source: { kind: 'blank' },
    pages: ['page-1', 'page-2'].map((page_id) => ({
      page_id, width: 200, height: 160, background: { kind: 'blank', ruling: 'blank' }, page_blob_hash: `hash-${page_id}`,
    })),
  };
  pages = new Map(manifest.pages.map(({ page_id }) => [page_id, emptyPage(page_id)]));
  drafts = new Map();
  saves = [];
  journalAtCas = [];
  saveGate = undefined;
  saveError = undefined;
  vi.spyOn(inkDraftJournal, 'read').mockImplementation(async ({ document_id, page_id }) => {
    const draft = drafts.get(page_id);
    return draft?.document_id === document_id ? structuredClone(draft) : undefined;
  });
  vi.spyOn(inkDraftJournal, 'persist').mockImplementation(async (record) => { drafts.set(record.page_id, structuredClone(record)); });
  vi.spyOn(inkDraftJournal, 'discard').mockImplementation(async ({ page_id }, sequence) => {
    if ((drafts.get(page_id)?.sequence ?? Infinity) <= sequence) drafts.delete(page_id);
  });
  mocks.invoke.mockImplementation(async (command: string, { request }: { request: Record<string, any> }) => {
    if (command === 'vfs_ink_get') return structuredClone({ ...manifest, document_id: request.document_id });
    if (command === 'vfs_ink_get_page') return structuredClone(pages.get(request.page_id));
    if (command === 'vfs_ink_save_page') {
      saves.push(structuredClone(request) as typeof saves[number]);
      journalAtCas.push(structuredClone(drafts.get(request.page.page_id)));
      if (saveGate) await saveGate.promise;
      if (saveError) throw saveError;
      if (request.expected_revision !== manifest.revision) throw { code: 'REVISION_CONFLICT', message: 'Revision conflict', retryable: false };
      pages.set(request.page.page_id, structuredClone(request.page));
      manifest = { ...manifest, revision: `saved-${saves.length}`, pages: manifest.pages.map((entry) => entry.page_id === request.page.page_id ? { ...entry, page_blob_hash: `saved-${saves.length}` } : entry) };
      return structuredClone(manifest);
    }
    if (command === 'vfs_ink_rename') {
      manifest = { ...manifest, title: request.title, revision: 'renamed' };
      return structuredClone(manifest);
    }
    if (command === 'vfs_ink_append_page') {
      const page_id = 'page-3';
      manifest = { ...manifest, revision: 'appended', pages: [...manifest.pages, { ...manifest.pages[0], page_id }] };
      pages.set(page_id, emptyPage(page_id));
      return structuredClone(manifest);
    }
    throw new Error(`Unexpected command: ${command}`);
  });
});

afterEach(async () => {
  cleanup();
  await act(async () => undefined);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function ready() {
  await waitFor(() => expect(screen.getByTestId('ink-editor-flush-state')).toHaveTextContent('ready'));
}

function startGesture(x = 20) {
  const bounds = { left: 0, top: 0, width: 200, height: 160, right: 200, bottom: 160, x: 0, y: 0, toJSON: () => ({}) };
  const canvas = screen.getByTestId('ink-page-canvas');
  const input = screen.getByTestId('ink-active-stroke-canvas');
  vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue(bounds);
  vi.spyOn(input, 'getBoundingClientRect').mockReturnValue(bounds);
  fireEvent.pointerDown(input, { pointerId: 7, pointerType: 'pen', button: 0, buttons: 1, clientX: x, clientY: 20 });
  fireEvent.pointerMove(input, { pointerId: 7, pointerType: 'pen', buttons: 1, clientX: x + 20, clientY: 40 });
  return input;
}

async function endGesture(input: HTMLElement, x = 20) {
  fireEvent.pointerUp(input, { pointerId: 7, pointerType: 'pen', button: 0, clientX: x + 30, clientY: 50 });
  await act(async () => undefined);
}

async function flush() {
  expect(await act(async () => flushInkEditor(documentId))).toEqual({ ok: true });
}

describe('InkEditor document-level host flush', () => {
  it('keeps complete pointer gestures pending with no writes, then saves the latest page on host exit', async () => {
    render(<InkEditor documentId={documentId} />);
    await ready();
    await endGesture(startGesture());
    await endGesture(startGesture(70), 70);
    expect(saves).toHaveLength(0);
    expect(inkDraftJournal.persist).not.toHaveBeenCalled();
    expect(screen.getByTestId('ink-editor-save-state')).toHaveAttribute('data-state', 'pending');
    expect(screen.getByTestId('ink-editor-save-state')).toHaveAttribute('data-dirty', 'true');
    expect(hasDirtyInkEditor(documentId)).toBe(true);
    await flush();
    expect(saves).toHaveLength(1);
    expect(saves[0].page.objects).toHaveLength(2);
    expect(journalAtCas[0]?.page).toEqual(saves[0].page);
    expect(hasDirtyInkEditor(documentId)).toBe(false);
    expect(screen.getByTestId('ink-editor-save-state')).toHaveAttribute('data-state', 'saved');
    await flush();
    expect(saves).toHaveLength(1);
  });

  it('finishes an unlifted final gesture before reporting a successful flush', async () => {
    render(<InkEditor documentId={documentId} />);
    await ready();
    const input = startGesture();
    expect(hasDirtyInkEditor(documentId)).toBe(true);
    await flush();
    expect(saves).toHaveLength(1);
    const content = saves[0].page.objects[0].content;
    expect(content.kind === 'stroke' ? content.samples.map(({ x, y }) => ({ x, y })) : null).toEqual([{ x: 20, y: 20 }, { x: 40, y: 40 }]);
    await endGesture(input);
    await flush();
    expect(saves).toHaveLength(1);
  });

  it('navigates multiple dirty pages without writing or registering overlapping dirty sessions', async () => {
    render(<InkEditor documentId={documentId} />);
    await ready();
    startGesture();
    fireEvent.click(screen.getByTestId('ink-page-next'));
    await waitFor(() => expect(screen.getByTestId('ink-page-count')).toHaveTextContent('2/2'));
    await endGesture(startGesture(70), 70);
    fireEvent.click(screen.getByTestId('ink-page-previous'));
    await waitFor(() => expect(screen.getByTestId('ink-page-count')).toHaveTextContent('1/2'));
    expect(saves).toHaveLength(0);
    expect(inkDraftJournal.persist).not.toHaveBeenCalled();
    await flush();
    expect(saves.map(({ page, expected_revision }) => [page.page_id, page.objects.length, expected_revision])).toEqual([
      ['page-1', 1, 'rev-1'], ['page-2', 1, 'saved-1'],
    ]);
    expect(screen.getByTestId('ink-page-count')).toHaveTextContent('1/2');
  });

  it('does not flush strokes for append or rename and keeps their new revision for the final save', async () => {
    render(<InkEditor documentId={documentId} />);
    await ready();
    await endGesture(startGesture());
    fireEvent.change(screen.getByTestId('ink-rename-title'), { target: { value: 'Renamed note' } });
    fireEvent.click(screen.getByTestId('ink-rename-submit'));
    await waitFor(() => expect(screen.getByTestId('ink-editor-title')).toHaveTextContent('Renamed note'));
    fireEvent.click(screen.getByTestId('ink-page-append'));
    await waitFor(() => expect(screen.getByTestId('ink-page-count')).toHaveTextContent('3/3'));
    expect(saves).toHaveLength(0);
    expect(inkDraftJournal.persist).not.toHaveBeenCalled();
    await endGesture(startGesture(70), 70);
    await flush();
    expect(saves.map(({ page, expected_revision }) => [page.page_id, expected_revision])).toEqual([
      ['page-1', 'appended'], ['page-3', 'saved-1'],
    ]);
  });

  it('passes the committed revision to AI and export before React has to render a saved state', async () => {
    const onAskAi = vi.fn();
    const onExport = vi.fn();
    render(<InkEditor documentId={documentId} onAskAi={onAskAi} onExport={onExport} />);
    await ready();
    startGesture();
    fireEvent.click(screen.getByTestId('ink-ask-ai'));
    await waitFor(() => expect(onAskAi).toHaveBeenCalledWith({ documentId, pageId: 'page-1', revision: 'saved-1' }));
    await endGesture(startGesture(70), 70);
    fireEvent.click(screen.getByTestId('ink-export'));
    await waitFor(() => expect(onExport).toHaveBeenCalledWith(documentId, 'page-1', 'saved-2'));
    expect(saves[1].page.objects).toHaveLength(2);
  });

  it('does not export or report exit success after a CAS failure', async () => {
    const onExport = vi.fn();
    render(<InkEditor documentId={documentId} onExport={onExport} />);
    await ready();
    await endGesture(startGesture());
    saveError = new Error('Native unavailable');
    fireEvent.click(screen.getByTestId('ink-export'));
    await waitFor(() => expect(screen.getByTestId('ink-editor-save-state')).toHaveAttribute('data-state', 'offline'));
    expect(onExport).not.toHaveBeenCalled();
    expect(await act(async () => flushInkEditor(documentId))).toEqual({ ok: false, code: 'EDITOR_BUSY' });
    expect(drafts.get('page-1')?.page.objects).toHaveLength(1);
    expect(hasDirtyInkEditor(documentId)).toBe(true);
  });

  it('uses background events only for one recovery draft of each latest page', async () => {
    render(<InkEditor documentId={documentId} />);
    await ready();
    await endGesture(startGesture());
    fireEvent.click(screen.getByTestId('ink-page-next'));
    await waitFor(() => expect(screen.getByTestId('ink-page-count')).toHaveTextContent('2/2'));
    await endGesture(startGesture(70), 70);
    await act(async () => {
      window.dispatchEvent(new Event('pagehide'));
      window.dispatchEvent(new Event('pagehide'));
    });
    await waitFor(() => expect(drafts.size).toBe(2));
    expect(inkDraftJournal.persist).toHaveBeenCalledTimes(2);
    expect(saves).toHaveLength(0);
    expect(screen.getByTestId('ink-editor-save-state')).toHaveAttribute('data-state', 'pending');
  });

  it('saves the unfinished gesture once when exiting by session cleanup', async () => {
    const view = render(<InkEditor documentId={documentId} />);
    await ready();
    startGesture();
    expect(saves).toHaveLength(0);
    view.unmount();
    await act(async () => undefined);
    expect(saves).toHaveLength(1);
    expect(saves[0].page.objects).toHaveLength(1);
    expect(drafts.size).toBe(0);
    expect(hasDirtyInkEditor(documentId)).toBe(false);
  });

  it('retains the final recovery draft if the exit cleanup save fails', async () => {
    const view = render(<InkEditor documentId={documentId} />);
    await ready();
    startGesture();
    saveError = new Error('Native unavailable');
    view.unmount();
    await act(async () => undefined);
    expect(saves).toHaveLength(1);
    expect(drafts.get('page-1')?.page.objects).toHaveLength(1);
    expect(drafts.get('page-1')?.save_state).toBe('offline');
  });

  it('keeps selection and new input on the current page while an older page is saving', async () => {
    render(<InkEditor documentId={documentId} />);
    await ready();
    await endGesture(startGesture());
    let resolve!: () => void;
    saveGate = { promise: new Promise<void>((done) => { resolve = done; }), resolve: () => resolve() };
    let pending!: ReturnType<typeof flushInkEditor>;
    act(() => { pending = flushInkEditor(documentId); });
    await waitFor(() => expect(saves).toHaveLength(1));
    fireEvent.click(screen.getByTestId('ink-page-next'));
    await waitFor(() => expect(screen.getByTestId('ink-page-count')).toHaveTextContent('2/2'));
    await endGesture(startGesture(70), 70);
    await act(async () => { saveGate?.resolve(); expect(await pending).toEqual({ ok: false, code: 'EDITOR_BUSY' }); });
    expect(saves.map(({ page }) => page.page_id)).toEqual(['page-1', 'page-2']);
    expect(screen.getByTestId('ink-page-count')).toHaveTextContent('2/2');
    await flush();
    expect(saves).toHaveLength(2);
  });

  it('blocks an AI snapshot if a new unfinished gesture starts during its save', async () => {
    const onAskAi = vi.fn();
    render(<InkEditor documentId={documentId} onAskAi={onAskAi} />);
    await ready();
    await endGesture(startGesture());
    let resolve!: () => void;
    saveGate = { promise: new Promise<void>((done) => { resolve = done; }), resolve: () => resolve() };
    fireEvent.click(screen.getByTestId('ink-ask-ai'));
    await waitFor(() => expect(saves).toHaveLength(1));
    const input = startGesture(70);
    await act(async () => { saveGate?.resolve(); });
    expect(onAskAi).not.toHaveBeenCalled();
    expect(hasDirtyInkEditor(documentId)).toBe(true);
    await endGesture(input, 70);
    await flush();
    expect(saves).toHaveLength(2);
    expect(saves[1].page.objects).toHaveLength(2);
  });

  it('retains page-local undo history across navigation without saving until flush', async () => {
    render(<InkEditor documentId={documentId} />);
    await ready();
    await endGesture(startGesture());
    await endGesture(startGesture(70), 70);
    fireEvent.click(screen.getByTestId('ink-page-next'));
    await waitFor(() => expect(screen.getByTestId('ink-page-count')).toHaveTextContent('2/2'));
    expect(screen.getByTestId('ink-undo')).toBeDisabled();
    fireEvent.click(screen.getByTestId('ink-page-previous'));
    await waitFor(() => expect(screen.getByTestId('ink-page-count')).toHaveTextContent('1/2'));
    fireEvent.click(screen.getByTestId('ink-undo'));
    await act(async () => undefined);
    expect(saves).toHaveLength(0);
    expect(inkDraftJournal.persist).not.toHaveBeenCalled();
    await flush();
    expect(saves[0].page.objects).toHaveLength(1);
    fireEvent.click(screen.getByTestId('ink-redo'));
    await act(async () => undefined);
    expect(saves).toHaveLength(1);
    await flush();
    expect(saves[1].page.objects).toHaveLength(2);
  });

  it('flushes the old unfinished page on document replacement without affecting the new page or its history', async () => {
    const view = render(<InkEditor documentId={documentId} />);
    await ready();
    startGesture();
    const nextId = 'paged-host-replacement';
    const implementation = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation(async (command, payload) => {
      if (payload.request.document_id === nextId) {
        if (command === 'vfs_ink_get_page') return emptyPage(payload.request.page_id);
        if (command === 'vfs_ink_save_page') {
          saves.push(structuredClone(payload.request));
          return { ...manifest, document_id: nextId, revision: 'replacement-saved' };
        }
      }
      return implementation(command, payload);
    });
    view.rerender(<InkEditor documentId={nextId} />);
    await waitFor(() => expect(screen.getByTestId('ink-editor')).toHaveAttribute('data-document-id', nextId));
    await ready();
    await waitFor(() => expect(saves).toHaveLength(1));
    expect(saves[0].document_id).toBe(documentId);
    expect(saves[0].page.objects).toHaveLength(1);
    expect(hasDirtyInkEditor(documentId)).toBe(false);
    expect(hasDirtyInkEditor(nextId)).toBe(false);
    expect(screen.getByTestId('ink-undo')).toBeDisabled();
    await endGesture(startGesture(70), 70);
    expect(await act(async () => flushInkEditor(nextId))).toEqual({ ok: true });
    expect(saves[1].document_id).toBe(nextId);
    expect(saves[1].page.objects).toHaveLength(1);
  });

  it.each([false, true])('loads the committed revision after a same-document key replacement (lifted: %s)', async (lifted) => {
    const view = render(<InkEditor key="old" documentId={documentId} />);
    await ready();
    const input = startGesture();
    if (lifted) await endGesture(input);
    let resolve!: () => void;
    saveGate = { promise: new Promise<void>((done) => { resolve = done; }), resolve: () => resolve() };
    const implementation = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation(async (command, payload) => {
      const value = await implementation(command, payload);
      if (command === 'vfs_ink_save_page') {
        await mocks.listener?.({ payload: { document_id: documentId, revision: value.revision, operation_id: payload.request.operation_id } });
      }
      return value;
    });
    const readsBeforeReplacement = mocks.invoke.mock.calls.filter(([command]) => command === 'vfs_ink_get').length;
    view.rerender(<InkEditor key="new" documentId={documentId} />);
    await waitFor(() => expect(saves).toHaveLength(1));
    expect(screen.getByTestId('ink-editor-flush-state')).toHaveTextContent('loading');
    expect(mocks.invoke.mock.calls.filter(([command]) => command === 'vfs_ink_get')).toHaveLength(readsBeforeReplacement);
    await act(async () => { saveGate?.resolve(); });
    await ready();
    expect(screen.getByTestId('ink-editor-save-state')).toHaveAttribute('data-state', 'saved');
    expect(hasDirtyInkEditor(documentId)).toBe(false);
    await endGesture(startGesture(70), 70);
    await flush();
    expect(saves).toHaveLength(2);
    expect(saves[1].expected_revision).toBe('saved-1');
    expect(saves[1].page.objects).toHaveLength(2);
    expect(screen.getByTestId('ink-editor-save-state')).toHaveAttribute('data-state', 'saved');
    expect(drafts.size).toBe(0);
  });

  it('restores the failed exit draft before accepting input from a same-document replacement', async () => {
    const view = render(<InkEditor key="old-failure" documentId={documentId} />);
    await ready();
    startGesture();
    let resolve!: () => void;
    saveGate = { promise: new Promise<void>((done) => { resolve = done; }), resolve: () => resolve() };
    saveError = new Error('Native unavailable');
    view.rerender(<InkEditor key="new-failure" documentId={documentId} />);
    await waitFor(() => expect(saves).toHaveLength(1));
    expect(screen.getByTestId('ink-editor-flush-state')).toHaveTextContent('loading');
    await act(async () => { saveGate?.resolve(); });
    await ready();
    expect(screen.getByTestId('ink-editor-save-state')).toHaveAttribute('data-state', 'offline');
    expect(drafts.get('page-1')?.page.objects).toHaveLength(1);
    saveError = undefined;
    await endGesture(startGesture(70), 70);
    await flush();
    expect(saves).toHaveLength(2);
    expect(saves[1].expected_revision).toBe('rev-1');
    expect(saves[1].page.objects).toHaveLength(2);
    expect(drafts.size).toBe(0);
  });

  it('keeps an unlifted gesture and rejects the reload through the real editor controls', async () => {
    render(<InkEditor documentId={documentId} />);
    await ready();
    await endGesture(startGesture());
    saveError = { code: 'REVISION_CONFLICT', message: 'Revision conflict', retryable: false };
    expect(await act(async () => flushInkEditor(documentId))).toEqual({ ok: false, code: 'EDITOR_BUSY' });
    const implementation = mocks.invoke.getMockImplementation()!;
    let resolve!: () => void;
    const gate = new Promise<void>((done) => { resolve = done; });
    let waiting = false;
    mocks.invoke.mockImplementation(async (command, payload) => {
      const value = await implementation(command, payload);
      if (command === 'vfs_ink_get_page') { waiting = true; await gate; }
      return value;
    });
    fireEvent.click(screen.getByRole('button', { name: 'actions.reloadRemote' }));
    await waitFor(() => expect(waiting).toBe(true));
    const input = startGesture(70);
    await act(async () => { resolve(); });
    expect(screen.getByTestId('ink-editor-save-state')).toHaveAttribute('data-state', 'conflict');
    expect(screen.getByText('errors.operationFailed')).toBeInTheDocument();
    expect(hasDirtyInkEditor(documentId)).toBe(true);
    await endGesture(input, 70);
    await act(async () => { window.dispatchEvent(new Event('pagehide')); });
    expect(drafts.get('page-1')?.page.objects).toHaveLength(2);
    expect(drafts.get('page-1')?.save_state).toBe('conflict');
    expect(saves).toHaveLength(1);
  });

  it('provides shared pending status translations without claiming offline recovery', () => {
    expect(zh.status.pending).toContain('未保存');
    expect(en.status.pending).toContain('Unsaved');
    expect(zh.status.pending).not.toContain('失败');
    expect(en.status.pending).not.toContain('recovery');
  });
});
