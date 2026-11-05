import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleAndroidBack } from '@/app/navigation/androidBackCoordinator';
import { flushInkWorkspace } from '@/services/inkWorkspaceRegistry';
import { inkDraftJournal, type InkDraftRecord } from '../drafts';
import { hasDirtyInkEditor } from '../editorSession';
import type { InkManifest, InkPage } from '../types';
import { InkWorkspace } from '../InkWorkspace';

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => undefined) }));
vi.mock('../renderer', () => ({ renderInkPage: vi.fn() }));
vi.mock('../useInkBackground', () => ({ useInkBackground: () => ({ error: false }) }));
vi.mock('@/hooks/useBreakpoint', () => ({ useIsMobile: () => false }));
vi.mock('../LazyInkEditorEntry', async () => ({ LazyInkEditor: (await import('../InkEditor')).InkEditor }));

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

const documentId = 'file_workspace_flush';
let manifest: InkManifest;
let pages: Map<string, InkPage>;
let drafts: Map<string, InkDraftRecord>;
let saves: Array<{ document_id: string; expected_revision: string; page: InkPage }>;
let saveError: unknown;
let gate: ReturnType<typeof deferred> | undefined;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  mocks.invoke.mockReset();
  vi.stubGlobal('PointerEvent', TestPointerEvent);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ clearRect: vi.fn() } as unknown as CanvasRenderingContext2D);
  manifest = {
    schema_version: 1, document_id: documentId, revision: 'rev-1', title: 'Workspace flush', source: { kind: 'blank' },
    pages: ['page-1', 'page-2'].map((page_id) => ({
      page_id, width: 200, height: 160, background: { kind: 'blank', ruling: 'blank' }, page_blob_hash: `hash-${page_id}`,
    })),
  };
  pages = new Map(manifest.pages.map(({ page_id }) => [page_id, { schema_version: 1, page_id, objects: [] }]));
  drafts = new Map();
  saves = [];
  saveError = undefined;
  gate = undefined;
  vi.spyOn(inkDraftJournal, 'read').mockImplementation(async ({ page_id }) => structuredClone(drafts.get(page_id)));
  vi.spyOn(inkDraftJournal, 'persist').mockImplementation(async (record) => { drafts.set(record.page_id, structuredClone(record)); });
  vi.spyOn(inkDraftJournal, 'discard').mockImplementation(async ({ page_id }, sequence) => {
    if ((drafts.get(page_id)?.sequence ?? Infinity) <= sequence) drafts.delete(page_id);
  });
  mocks.invoke.mockImplementation(async (command: string, { request }: { request: Record<string, any> }) => {
    if (command === 'vfs_ink_get') return structuredClone(manifest);
    if (command === 'vfs_ink_get_page') return structuredClone(pages.get(request.page_id));
    if (command === 'vfs_ink_save_page') {
      saves.push(structuredClone(request) as typeof saves[number]);
      if (gate) await gate.promise;
      if (saveError) throw saveError;
      if (request.expected_revision !== manifest.revision) throw new Error('Stale revision');
      pages.set(request.page.page_id, structuredClone(request.page));
      manifest = { ...manifest, revision: `saved-${saves.length}` };
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
}

async function completedGesture(x = 20) {
  startGesture(x);
  fireEvent.pointerUp(screen.getByTestId('ink-active-stroke-canvas'), { pointerId: 7, pointerType: 'pen', button: 0, clientX: x + 30, clientY: 50 });
  await act(async () => undefined);
}

describe('InkWorkspace real document exit', () => {
  it.each(['button', 'android', 'host'] as const)('finishes an unlifted last stroke and awaits canonical saving for %s exit', async (exit) => {
    const onClose = vi.fn();
    render(<InkWorkspace documentId={documentId} onClose={onClose} />);
    await ready();
    await completedGesture();
    await completedGesture(70);
    expect(saves).toHaveLength(0);
    expect(inkDraftJournal.persist).not.toHaveBeenCalled();
    startGesture(120);
    gate = deferred();
    let hostExit: Promise<boolean> | undefined;
    act(() => {
      if (exit === 'host') hostExit = flushInkWorkspace(documentId);
      else if (exit === 'android') expect(handleAndroidBack()).toBe(true);
      else fireEvent.click(screen.getByRole('button', { name: '返回', exact: true }));
    });
    await waitFor(() => expect(saves).toHaveLength(1));
    expect(saves[0].page.objects).toHaveLength(3);
    expect(drafts.get('page-1')?.page.objects).toHaveLength(3);
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByTestId('ink-editor')).toBeInTheDocument();
    await act(async () => { gate!.resolve(); });
    if (hostExit) {
      await expect(hostExit).resolves.toBe(true);
      expect(onClose).not.toHaveBeenCalled();
    } else {
      await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
      expect(screen.queryByTestId('ink-editor')).not.toBeInTheDocument();
    }
    expect(hasDirtyInkEditor(documentId)).toBe(false);
    expect(drafts.size).toBe(0);
  });

  it('retains all pages on failed exit and retries every cached dirty page without saving during page navigation', async () => {
    const onClose = vi.fn();
    render(<InkWorkspace documentId={documentId} onClose={onClose} />);
    await ready();
    startGesture();
    fireEvent.click(screen.getByTestId('ink-page-next'));
    await waitFor(() => expect(screen.getByTestId('ink-page-count')).toHaveTextContent('2/2'));
    startGesture(70);
    expect(saves).toHaveLength(0);
    expect(inkDraftJournal.persist).not.toHaveBeenCalled();
    saveError = new Error('disk unavailable');
    fireEvent.click(screen.getByRole('button', { name: '返回', exact: true }));
    expect(await screen.findByText(/保存未完成/)).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByTestId('ink-page-count')).toHaveTextContent('2/2');
    expect(drafts.get('page-1')?.page.objects).toHaveLength(1);
    expect(drafts.get('page-2')?.page.objects).toHaveLength(1);
    saveError = undefined;
    fireEvent.click(screen.getByRole('button', { name: '重试', exact: true }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(saves.slice(1).map(({ page, expected_revision }) => [page.page_id, expected_revision])).toEqual([
      ['page-1', 'rev-1'], ['page-2', 'saved-2'],
    ]);
    expect(drafts.size).toBe(0);
  });

  it('finishes an active gesture on host deactivation and retains its draft if saving fails', async () => {
    const view = render(<InkWorkspace documentId={documentId} />);
    await ready();
    startGesture();
    saveError = new Error('Native unavailable');
    view.rerender(<InkWorkspace documentId={documentId} isActive={false} />);
    await waitFor(() => expect(drafts.get('page-1')?.page.objects).toHaveLength(1));
    expect(saves).toHaveLength(1);
    view.rerender(<InkWorkspace documentId={documentId} isActive />);
    expect(await screen.findByText(/保存未完成/)).toBeInTheDocument();
    expect(screen.getByTestId('ink-editor')).toBeInTheDocument();
  });

  it('retains the unfinished gesture as a recovery draft when a forced-unmount save cannot complete', async () => {
    const onClose = vi.fn();
    const view = render(<InkWorkspace documentId={documentId} onClose={onClose} />);
    await ready();
    startGesture();
    saveError = new Error('Native unavailable');
    view.unmount();
    await waitFor(() => expect(drafts.get('page-1')?.page.objects).toHaveLength(1));
    expect(onClose).not.toHaveBeenCalled();
    expect(hasDirtyInkEditor(documentId)).toBe(false);
  });
});
