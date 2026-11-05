import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addAppEventListener, APP_EVENTS } from '@/events';

interface SelectionRegion {
  polygon: Array<{ x: number; y: number }>;
  bounds: { x: number; y: number; width: number; height: number };
}

interface PageViewMockProps {
  selectionMode?: 'none' | 'rectangle' | 'lasso';
  onSelectionChange?: (selection: SelectionRegion | null) => void;
  onViewportWidthChange?: (width: number) => void;
  onViewportInteraction?: () => void;
  tool: { zoom: number; panX: number; panY: number };
}

const mocks = vi.hoisted(() => {
  const events: string[] = [];
  const flush = vi.fn(async () => { events.push('flush'); });
  const finishStroke = vi.fn(async () => { events.push('finishStroke'); });
  const renderSnapshot = vi.fn(async () => {
    events.push('renderSnapshot');
    return {
      artifact_id: 'artifact-1',
      render_id: 'render-1',
      document_id: 'ink-document-1',
      page_id: 'page-1',
      revision: 'revision-7',
      width_px: 800,
      height_px: 1100,
      mime_type: 'image/png',
      resource_id: 'resource-render-1',
      file_id: 'file-render-1',
      blob_hash: 'hash-render-1',
      content_hash: 'content-render-1',
      created_at: '2026-11-03T00:00:00Z',
    };
  });
  const invoke = vi.fn(async (command: string) => {
    if (command === 'vfs_ink_get') {
      return { pages: [{ page_id: 'page-1' }, { page_id: 'page-2' }] };
    }
    if (command === 'vfs_ink_export') {
      events.push('exportDocument');
      return { file_id: 'file-export-1' };
    }
    throw new Error(`Unexpected command: ${command}`);
  });
  const referenceToChat = vi.fn(async () => ({ success: true }));
  const pageRef = {
    page_id: 'page-1',
    width: 794,
    height: 1123,
    background: { kind: 'blank', ruling: 'blank' as const },
    page_blob_hash: 'page-hash-1',
  };
  const page = { schema_version: 1, page_id: 'page-1', objects: [] };
  const manifest = {
    schema_version: 1,
    document_id: 'ink-document-1',
    revision: 'revision-7',
    title: 'Annotated source',
    source: { kind: 'blank' as const },
    pages: [pageRef],
  };
  const getSnapshot = vi.fn(() => ({ status: 'ready', saveStatus: 'saved', page, pageRef, manifest, remoteReloadSequence: 0 }));
  const persistDraft = vi.fn(async () => undefined);
  const pageViewProps: { current: PageViewMockProps | null } = { current: null };
  return { events, flush, finishStroke, renderSnapshot, invoke, referenceToChat, pageRef, page, manifest, pageViewProps, getSnapshot, persistDraft };
});

vi.mock('../useInkDocument', () => ({
  enqueueInkDocumentExit: (_documentId: string, exit: () => Promise<void>) => exit(),
  useInkDocument: () => ({
    status: 'ready',
    saveStatus: 'saved',
    manifest: mocks.manifest,
    pageRef: mocks.pageRef,
    page: mocks.page,
    savePage: vi.fn(),
    reloadRemote: vi.fn(),
    retrySave: vi.fn(),
    getSnapshot: mocks.getSnapshot,
    persistDraft: mocks.persistDraft,
    remoteReloadSequence: 0,
    flush: mocks.flush,
  }),
}));
vi.mock('../InkPageView', async () => {
  const ReactModule = await import('react');
  return {
    InkPageView: ReactModule.forwardRef((props: unknown, ref: React.ForwardedRef<{ finishStroke(): Promise<void>; eraseAt(point: { x: number; y: number }): Promise<void> }>) => {
      mocks.pageViewProps.current = props as PageViewMockProps;
      ReactModule.useImperativeHandle(ref, () => ({
        finishStroke: mocks.finishStroke,
        eraseAt: async () => undefined,
      }));
      return ReactModule.createElement('div', { 'data-testid': 'ink-page-view' });
    }),
  };
});
vi.mock('../api', () => ({ renderInkSnapshot: mocks.renderSnapshot }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('../editorSession', () => ({ flushInkEditor: vi.fn(async () => ({ ok: true })), registerInkEditorSession: vi.fn(() => vi.fn()) }));
vi.mock('../drafts', () => ({ inkDraftJournal: { discard: vi.fn(), read: vi.fn(), persist: vi.fn() } }));
vi.mock('@/hooks/useEventRegistry', () => ({ useEventRegistry: vi.fn() }));
vi.mock('@/features/learning-hub/useReferenceToChat', () => ({ useReferenceToChat: () => ({ referenceToChat: mocks.referenceToChat }) }));
vi.mock('@/components/UnifiedNotification', () => ({ showGlobalNotification: vi.fn() }));

import { LazyInkEditor } from '../LazyInkEditor';

const openResourceDisposers: Array<() => void> = [];
function listenForOpenResource(listener: (event: CustomEvent<{ dstuPath: string }>) => void) {
  openResourceDisposers.push(addAppEventListener(APP_EVENTS.LEARNING_HUB_OPEN_RESOURCE, (_detail, event) => listener(event)));
}

afterEach(() => openResourceDisposers.splice(0).forEach((dispose) => dispose()));

const SELECTION_CROP = { x: 20, y: 60, width: 60, height: 40 };

/** 模拟真实 InkPageView 在底图空区完成矩形圈选后回传的 polygon/bounds。 */
function emitBackgroundSelection() {
  const onSelectionChange = mocks.pageViewProps.current?.onSelectionChange;
  if (!onSelectionChange) throw new Error('InkPageView is missing onSelectionChange');
  act(() => {
    onSelectionChange({
      polygon: [
        { x: SELECTION_CROP.x, y: SELECTION_CROP.y },
        { x: SELECTION_CROP.x + SELECTION_CROP.width, y: SELECTION_CROP.y },
        { x: SELECTION_CROP.x + SELECTION_CROP.width, y: SELECTION_CROP.y + SELECTION_CROP.height },
        { x: SELECTION_CROP.x, y: SELECTION_CROP.y + SELECTION_CROP.height },
      ],
      bounds: SELECTION_CROP,
    });
  });
}

async function chooseRectangleSelection() {
  fireEvent.click(await screen.findByTestId('ink-select-rectangle'));
  await waitFor(() => expect(mocks.pageViewProps.current?.selectionMode).toBe('rectangle'));
  emitBackgroundSelection();
  return screen.findByTestId('ink-selection-ask-ai');
}

describe('LazyInkEditor shared host actions', () => {
  beforeEach(() => {
    mocks.events.length = 0;
    mocks.flush.mockClear();
    mocks.finishStroke.mockClear();
    mocks.renderSnapshot.mockClear();
    mocks.invoke.mockClear();
    mocks.referenceToChat.mockClear();
    mocks.pageViewProps.current = null;
  });

  it('keeps export format controls compact instead of using the full-width nav style', async () => {
    render(<LazyInkEditor documentId="ink-document-1" />);

    const png = await screen.findByRole('button', { name: 'PNG' });
    const pdf = screen.getByRole('button', { name: 'PDF' });

    // The selected format must be a compact in-toolbar button, not the shell
    // navigation variant whose `w-full` stretches across the whole host pane.
    expect(png).toHaveAttribute('aria-pressed', 'true');
    expect(png.className).not.toMatch(/(^|\s)w-full(\s|$)/);
    expect(pdf.className).not.toMatch(/(^|\s)w-full(\s|$)/);
    expect(screen.getByTestId('ink-page-controls')).toContainElement(png);
    expect(screen.getByTestId('ink-page-controls')).toContainElement(pdf);
    expect(screen.getByTestId('ink-editor')).toHaveClass('relative', 'h-full', 'min-h-0', 'overflow-hidden');
    expect(screen.getByTestId('ink-toolbar')).toHaveClass('shrink-0');
    expect(screen.getByTestId('ink-color-blue')).toHaveClass('relative');

    fireEvent.click(pdf);

    expect(pdf).toHaveAttribute('aria-pressed', 'true');
    expect(png).toHaveAttribute('aria-pressed', 'false');
    expect(pdf.className).not.toMatch(/(^|\s)w-full(\s|$)/);
    expect(png.className).not.toMatch(/(^|\s)w-full(\s|$)/);
  });

  it('fits a new page to available width without enlarging small pages, then keeps manual zoom and pan', async () => {
    render(<LazyInkEditor documentId="ink-document-1" />);
    await screen.findByTestId('ink-page-view');

    act(() => mocks.pageViewProps.current?.onViewportWidthChange?.(366));
    expect(mocks.pageViewProps.current?.tool.zoom).toBeCloseTo(366 / 794);
    act(() => mocks.pageViewProps.current?.onViewportWidthChange?.(1600));
    expect(mocks.pageViewProps.current?.tool.zoom).toBe(1);
    act(() => mocks.pageViewProps.current?.onViewportWidthChange?.(316));
    expect(mocks.pageViewProps.current?.tool.zoom).toBeCloseTo(316 / 794);

    fireEvent.click(screen.getByTestId('ink-zoom-in'));
    expect(mocks.pageViewProps.current?.tool.zoom).toBe(0.65);
    fireEvent.click(screen.getByTestId('ink-pan-right'));
    act(() => mocks.pageViewProps.current?.onViewportWidthChange?.(280));
    expect(mocks.pageViewProps.current?.tool).toMatchObject({ zoom: 0.65, panX: 20, panY: 0 });
    act(() => mocks.pageViewProps.current?.onViewportWidthChange?.(1600));
    fireEvent.click(screen.getByTestId('ink-zoom-out'));
    expect(mocks.pageViewProps.current?.tool).toMatchObject({ zoom: 0.4, panX: 20, panY: 0 });
  });

  it('does not re-fit after the user starts navigating or writing in the viewport', async () => {
    render(<LazyInkEditor documentId="ink-document-1" />);
    await screen.findByTestId('ink-page-view');

    act(() => mocks.pageViewProps.current?.onViewportWidthChange?.(366));
    const initialZoom = mocks.pageViewProps.current?.tool.zoom;
    act(() => mocks.pageViewProps.current?.onViewportInteraction?.());
    act(() => mocks.pageViewProps.current?.onViewportWidthChange?.(720));
    expect(mocks.pageViewProps.current?.tool.zoom).toBe(initialZoom);
  });

  it('renders an immutable PNG after editor flush and references that image through the existing Chat flow', async () => {
    render(<LazyInkEditor documentId="ink-document-1" />);

    fireEvent.click(await screen.findByTestId('ink-ask-ai'));

    await waitFor(() => expect(mocks.referenceToChat).toHaveBeenCalledTimes(1));
    expect(mocks.finishStroke).toHaveBeenCalledOnce();
    expect(mocks.flush).toHaveBeenCalledOnce();
    expect(mocks.events).toEqual(['finishStroke', 'flush', 'renderSnapshot']);
    expect(mocks.renderSnapshot).toHaveBeenCalledWith({
      document_id: 'ink-document-1',
      expected_revision: 'revision-7',
      page_id: 'page-1',
    });
    expect(mocks.referenceToChat).toHaveBeenCalledWith(expect.objectContaining({
      sourceType: 'image',
      sourceId: 'file-render-1',
      metadata: expect.objectContaining({ mimeType: 'image/png' }),
    }));
    expect(mocks.referenceToChat).not.toHaveBeenCalledWith(expect.objectContaining({ sourceId: 'ink-document-1' }));
  });

  it('exports the current page as PNG by default and opens the resulting VFS file', async () => {
    const openResource = vi.fn();
    listenForOpenResource(openResource);
    render(<LazyInkEditor documentId="ink-document-1" />);

    fireEvent.click(await screen.findByTestId('ink-export'));

    await waitFor(() => expect(openResource).toHaveBeenCalled());
    expect((openResource.mock.calls[0][0] as CustomEvent).detail).toEqual({ dstuPath: '/file-export-1' });
    expect(mocks.events).toEqual(['finishStroke', 'flush', 'exportDocument']);
    expect(mocks.invoke).toHaveBeenCalledWith('vfs_ink_get', { request: { document_id: 'ink-document-1' } });
    expect(mocks.invoke).toHaveBeenCalledWith('vfs_ink_export', {
      request: {
        document_id: 'ink-document-1',
        expected_revision: 'revision-7',
        page_ids: ['page-1'],
        format: 'png',
        operation_id: expect.any(String),
      },
    });
  });

  it('exports ordered manifest pages as PDF when PDF is selected', async () => {
    const openResource = vi.fn();
    listenForOpenResource(openResource);
    render(<LazyInkEditor documentId="ink-document-1" />);

    fireEvent.click(await screen.findByRole('button', { name: 'PDF' }));
    fireEvent.click(screen.getByTestId('ink-export'));

    await waitFor(() => expect(openResource).toHaveBeenCalled());
    expect(mocks.invoke).toHaveBeenCalledWith('vfs_ink_export', {
      request: expect.objectContaining({
        document_id: 'ink-document-1',
        expected_revision: 'revision-7',
        page_ids: ['page-1', 'page-2'],
        format: 'pdf',
        operation_id: expect.any(String),
      }),
    });
  });

  it('renders a logical crop snapshot for a background-only rectangle and references the real artifact file', async () => {
    render(<LazyInkEditor documentId="ink-document-1" />);

    expect(screen.queryByTestId('ink-selection-ask-ai')).not.toBeInTheDocument();

    const selectionAskAi = await chooseRectangleSelection();
    fireEvent.click(selectionAskAi);

    await waitFor(() => expect(mocks.referenceToChat).toHaveBeenCalledTimes(1));

    expect(mocks.finishStroke).toHaveBeenCalledOnce();
    expect(mocks.flush).toHaveBeenCalledOnce();
    expect(mocks.events).toEqual(['finishStroke', 'flush', 'renderSnapshot']);
    expect(mocks.renderSnapshot).toHaveBeenCalledTimes(1);
    expect(mocks.renderSnapshot).toHaveBeenCalledWith({
      document_id: 'ink-document-1',
      expected_revision: 'revision-7',
      page_id: 'page-1',
      crop: { x: 20, y: 60, width: 60, height: 40 },
    });
    expect(mocks.referenceToChat).toHaveBeenCalledWith(expect.objectContaining({
      sourceType: 'image',
      sourceId: 'file-render-1',
      metadata: expect.objectContaining({ mimeType: 'image/png' }),
    }));
    expect(mocks.referenceToChat.mock.invocationCallOrder[0])
      .toBeGreaterThan(mocks.renderSnapshot.mock.invocationCallOrder[0]);
  });

  it('does not render or reference when finishStroke or flush rejects', async () => {
    // finishStroke 拒绝：不进入 flush/render/reference。
    mocks.finishStroke.mockRejectedValueOnce(new Error('finish failed'));
    const first = render(<LazyInkEditor documentId="ink-document-1" />);
    fireEvent.click(await chooseRectangleSelection());

    await waitFor(() => expect(mocks.finishStroke).toHaveBeenCalledOnce());
    expect(mocks.flush).not.toHaveBeenCalled();
    expect(mocks.renderSnapshot).not.toHaveBeenCalled();
    expect(mocks.referenceToChat).not.toHaveBeenCalled();
    first.unmount();

    // flush 拒绝：不 render/reference。
    mocks.events.length = 0;
    mocks.finishStroke.mockClear();
    mocks.flush.mockClear();
    mocks.renderSnapshot.mockClear();
    mocks.referenceToChat.mockClear();
    mocks.pageViewProps.current = null;
    mocks.flush.mockRejectedValueOnce(new Error('flush failed'));

    render(<LazyInkEditor documentId="ink-document-1" />);
    fireEvent.click(await chooseRectangleSelection());

    await waitFor(() => expect(mocks.flush).toHaveBeenCalledOnce());
    expect(mocks.finishStroke).toHaveBeenCalledOnce();
    expect(mocks.renderSnapshot).not.toHaveBeenCalled();
    expect(mocks.referenceToChat).not.toHaveBeenCalled();
  });
});
