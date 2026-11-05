import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addAppEventListener, APP_EVENTS } from '@/events';

/**
 * Board host boundary mocks. The LazyInkBoardEditor action handlers themselves
 * are intentionally NOT mocked.
 */
const mocks = vi.hoisted(() => {
  const events: string[] = [];
  const viewportCrop = { x: -400, y: -300, width: 800, height: 600 };
  const selectionCrop = { x: -120, y: -90, width: 60, height: 40 };
  const manifest = {
    schema_version: 2 as const,
    document_id: 'board-doc-1',
    revision: 'board-rev-1',
    title: 'Board action fixture',
    source: { kind: 'blank' as const },
    pages: [] as [],
    surface: {
      kind: 'board' as const,
      page_id: 'board-page-1',
      ruling: 'grid' as const,
      bounds: { x: -10000, y: -10000, width: 20000, height: 20000 },
    },
    chunks: [],
  };
  // Mutable current manifest so a test can publish an own-save revision while
  // keeping the same surface (the hook returns a new manifest on every save).
  const manifestState = { current: manifest };
  const chunk = {
    schema_version: 2 as const,
    chunk_id: 'chunk-1',
    objects: [],
  };
  const renderSnapshot = vi.fn(async () => {
    events.push('render');
    return {
      artifact_id: 'artifact-board-1',
      render_id: 'render-board-1',
      document_id: 'board-doc-1',
      page_id: 'board-page-1',
      revision: 'board-rev-1',
      width_px: 800,
      height_px: 600,
      mime_type: 'image/png',
      resource_id: 'resource-board-render-1',
      file_id: 'file-board-render-1',
      blob_hash: 'hash-board-render-1',
      content_hash: 'content-board-render-1',
      created_at: '2026-11-04T00:00:00Z',
    };
  });
  const flushInkEditor = vi.fn(async () => {
    events.push('flush');
    return { ok: true as const };
  });
  const boardFlush = vi.fn(async () => {
    events.push('flush');
  });
  const exportDocument = vi.fn(async (request: Record<string, unknown>) => {
    events.push('export');
    const board = request.board as { region: { width: number; height: number } } | undefined;
    return {
      artifact_id: 'artifact-board-export-1',
      render_id: 'render-board-export-1',
      document_id: 'board-doc-1',
      page_id: 'board-page-1',
      page_ids: request.page_ids,
      revision: 'board-rev-1',
      format: request.format,
      operation_id: request.operation_id,
      mime_type: request.format === 'pdf' ? 'application/pdf' : 'image/png',
      width_px: Math.max(1, Math.round(board?.region.width ?? 1)),
      height_px: Math.max(1, Math.round(board?.region.height ?? 1)),
      resource_id: 'resource-board-export-1',
      file_id: 'file-board-export-1',
      blob_hash: 'hash-board-export-1',
      content_hash: 'content-board-export-1',
      open_locator: '/file-board-export-1',
      created_at: '2026-11-04T00:00:00Z',
    };
  });
  const referenceToChat = vi.fn(async () => ({ success: true }));
  const showGlobalNotification = vi.fn();
  const insertObjects = vi.fn(async () => undefined);
  const setActiveInput = vi.fn();
  const save = vi.fn(async () => undefined);
  const saveState: { saveStatus: string; revisionEpoch: number } = {
    saveStatus: 'saved',
    revisionEpoch: 0,
  };
  const getInkBoardOverview = vi.fn(async () => ({
    document_id: 'board-doc-1',
    revision: 'board-rev-1',
    page_id: 'board-page-1',
    max_z_index: '0',
  }));
  const viewProps: { current: Record<string, unknown> | null } = { current: null };
  return {
    boardFlush,
    chunk,
    events,
    exportDocument,
    flushInkEditor,
    getInkBoardOverview,
    insertObjects,
    manifest,
    manifestState,
    referenceToChat,
    renderSnapshot,
    save,
    saveState,
    setActiveInput,
    selectionCrop,
    showGlobalNotification,
    viewportCrop,
    viewProps,
  };
});

vi.mock('../useInkBoardDocument', () => ({
  useInkBoardDocument: () => ({
    status: 'ready',
    get saveStatus() { return mocks.saveState.saveStatus; },
    manifest: mocks.manifestState.current,
    surface: mocks.manifestState.current.surface,
    chunks: [mocks.chunk],
    dirtyChunks: [],
    camera: { x: 0, y: 0, scale: 1 },
    get revisionEpoch() { return mocks.saveState.revisionEpoch; },
    undoDepth: 0,
    redoDepth: 0,
    error: undefined,
    loadVisible: vi.fn(async () => undefined),
    upsertObjects: vi.fn(async () => undefined),
    insertObjects: mocks.insertObjects,
    removeObjects: vi.fn(async () => undefined),
    undo: vi.fn(async () => undefined),
    redo: vi.fn(async () => undefined),
    save: mocks.save,
    reloadRemote: vi.fn(async () => undefined),
    persistDraft: vi.fn(async () => undefined),
    flush: mocks.boardFlush,
    setCamera: vi.fn(),
    setActiveInput: mocks.setActiveInput,
  }),
}));

vi.mock('../InkBoardView', async () => {
  const ReactModule = await import('react');
  return {
    InkBoardView: ReactModule.forwardRef((
      props: Record<string, unknown>,
      ref: React.ForwardedRef<{
        getViewportWorldRect(): typeof mocks.viewportCrop;
        finishStroke(): Promise<void>;
        focus(): void;
      }>,
    ) => {
      mocks.viewProps.current = props;
      ReactModule.useImperativeHandle(ref, () => ({
        getViewportWorldRect: () => mocks.viewportCrop,
        finishStroke: async () => {
          mocks.events.push('finishStroke');
        },
        focus: () => undefined,
      }));
      return ReactModule.createElement('div', { 'data-testid': 'ink-board-view' });
    }),
  };
});

vi.mock('../api', () => ({
  getInkBoardOverview: mocks.getInkBoardOverview,
  renderInkBoardSnapshot: mocks.renderSnapshot,
  exportInkDocument: mocks.exportDocument,
}));

vi.mock('../editorSession', () => ({
  flushInkEditor: mocks.flushInkEditor,
  registerInkEditorSession: vi.fn(() => vi.fn()),
}));

vi.mock('@/features/learning-hub/useReferenceToChat', () => ({
  useReferenceToChat: () => ({ referenceToChat: mocks.referenceToChat }),
}));

vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: mocks.showGlobalNotification,
}));

import { LazyInkBoardEditor } from '../LazyInkBoardEditor';

const openResourceDisposers: Array<() => void> = [];
function listenForOpenResource(listener: (event: CustomEvent<{ dstuPath: string }>) => void) {
  openResourceDisposers.push(addAppEventListener(APP_EVENTS.LEARNING_HUB_OPEN_RESOURCE, (_detail, event) => listener(event)));
}

afterEach(() => {
  openResourceDisposers.splice(0).forEach((dispose) => dispose());
  vi.useRealTimers();
});

const SELECTION_POLYGON = [
  { x: mocks.selectionCrop.x, y: mocks.selectionCrop.y },
  { x: mocks.selectionCrop.x + mocks.selectionCrop.width, y: mocks.selectionCrop.y },
  { x: mocks.selectionCrop.x + mocks.selectionCrop.width, y: mocks.selectionCrop.y + mocks.selectionCrop.height },
  { x: mocks.selectionCrop.x, y: mocks.selectionCrop.y + mocks.selectionCrop.height },
];

describe('LazyInkBoardEditor shared host actions', () => {
  beforeEach(() => {
    mocks.events.length = 0;
    mocks.flushInkEditor.mockClear();
    mocks.boardFlush.mockClear();
    mocks.renderSnapshot.mockReset();
    mocks.renderSnapshot.mockImplementation(async () => {
      mocks.events.push('render');
      return {
        artifact_id: 'artifact-board-1',
        render_id: 'render-board-1',
        document_id: 'board-doc-1',
        page_id: 'board-page-1',
        revision: 'board-rev-1',
        width_px: 800,
        height_px: 600,
        mime_type: 'image/png',
        resource_id: 'resource-board-render-1',
        file_id: 'file-board-render-1',
        blob_hash: 'hash-board-render-1',
        content_hash: 'content-board-render-1',
        created_at: '2026-11-04T00:00:00Z',
      };
    });
    mocks.exportDocument.mockReset();
    mocks.exportDocument.mockImplementation(async (request: Record<string, unknown>) => {
      mocks.events.push('export');
      const board = request.board as { region: { width: number; height: number } } | undefined;
      return {
        artifact_id: 'artifact-board-export-1',
        render_id: 'render-board-export-1',
        document_id: 'board-doc-1',
        page_id: 'board-page-1',
        page_ids: request.page_ids,
        revision: 'board-rev-1',
        format: request.format,
        operation_id: request.operation_id,
        mime_type: request.format === 'pdf' ? 'application/pdf' : 'image/png',
        width_px: Math.max(1, Math.round(board?.region.width ?? 1)),
        height_px: Math.max(1, Math.round(board?.region.height ?? 1)),
        resource_id: 'resource-board-export-1',
        file_id: 'file-board-export-1',
        blob_hash: 'hash-board-export-1',
        content_hash: 'content-board-export-1',
        open_locator: '/file-board-export-1',
        created_at: '2026-11-04T00:00:00Z',
      };
    });
    mocks.referenceToChat.mockClear();
    mocks.showGlobalNotification.mockClear();
    mocks.insertObjects.mockClear();
    mocks.save.mockClear();
    mocks.setActiveInput.mockClear();
    mocks.saveState.saveStatus = 'saved';
    mocks.saveState.revisionEpoch = 0;
    mocks.manifestState.current = mocks.manifest;
    mocks.getInkBoardOverview.mockReset();
    mocks.getInkBoardOverview.mockImplementation(async () => ({
      document_id: 'board-doc-1',
      revision: 'board-rev-1',
      page_id: 'board-page-1',
      max_z_index: '0',
    }));
    mocks.viewProps.current = null;
  });

  it('flushes first, renders whole viewport or selection crop explicitly, references the real artifact without sending, and attaches nothing on render failure', async () => {
    render(<LazyInkBoardEditor documentId="board-doc-1" />);

    const askAi = await screen.findByTestId('ink-board-ask-ai');
    await waitFor(() => expect(screen.getByTestId('ink-board-overview-state')).toHaveAttribute('data-state', 'ready'));
    expect(askAi).toBeEnabled();

    fireEvent.click(askAi);
    await waitFor(() => expect(mocks.renderSnapshot).toHaveBeenCalledTimes(1));
    expect(mocks.events).toContain('finishStroke');
    expect(mocks.events).toContain('flush');
    expect(mocks.events.indexOf('finishStroke')).toBeLessThan(mocks.events.lastIndexOf('flush'));
    expect(mocks.events.lastIndexOf('flush')).toBeLessThan(mocks.events.indexOf('render'));
    expect(mocks.renderSnapshot).toHaveBeenNthCalledWith(1, {
      document_id: 'board-doc-1',
      expected_revision: 'board-rev-1',
      page_id: 'board-page-1',
      board: { crop: mocks.viewportCrop },
    });
    expect(mocks.referenceToChat).toHaveBeenCalledTimes(1);
    expect(mocks.referenceToChat).toHaveBeenCalledWith(expect.objectContaining({
      sourceType: 'image',
      sourceId: 'file-board-render-1',
      metadata: expect.objectContaining({ mimeType: 'image/png' }),
    }));
    expect(mocks.referenceToChat).not.toHaveBeenCalledWith(expect.objectContaining({
      sourceId: 'board-doc-1',
    }));

    const onSelectionChange = mocks.viewProps.current?.onSelectionChange as
      | ((selection: { polygon: typeof SELECTION_POLYGON; bounds: typeof mocks.selectionCrop; objectIds: string[] }) => void)
      | undefined;
    expect(onSelectionChange).toBeTypeOf('function');
    act(() => {
      onSelectionChange?.({
        polygon: SELECTION_POLYGON,
        bounds: mocks.selectionCrop,
        objectIds: ['obj-1'],
      });
    });

    fireEvent.click(screen.getByTestId('ink-board-ask-ai'));
    await waitFor(() => expect(mocks.renderSnapshot).toHaveBeenCalledTimes(2));
    expect(mocks.renderSnapshot).toHaveBeenNthCalledWith(2, expect.objectContaining({
      document_id: 'board-doc-1',
      expected_revision: 'board-rev-1',
      page_id: 'board-page-1',
      board: { crop: mocks.selectionCrop },
    }));

    const referencesBeforeFailure = mocks.referenceToChat.mock.calls.length;
    mocks.renderSnapshot.mockRejectedValueOnce(new Error('board render failed'));
    fireEvent.click(screen.getByTestId('ink-board-ask-ai'));
    await waitFor(() => expect(mocks.renderSnapshot).toHaveBeenCalledTimes(3));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(mocks.referenceToChat).toHaveBeenCalledTimes(referencesBeforeFailure);
  });

  it('exports the current viewport as PNG after finish/flush and opens the artifact instead of the source', async () => {
    const opened: string[] = [];
    listenForOpenResource((event) => opened.push(event.detail.dstuPath));
    render(<LazyInkBoardEditor documentId="board-doc-1" />);

    await screen.findByTestId('ink-board-editor');
    await waitFor(() => expect(screen.getByTestId('ink-board-overview-state')).toHaveAttribute('data-state', 'ready'));
    const exportButton = screen.getByTestId('ink-board-export');
    expect(exportButton).toBeEnabled();
    fireEvent.click(exportButton);
    const dialog = await screen.findByTestId('ink-board-export-dialog');
    expect(dialog).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('ink-board-export-submit'));

    await waitFor(() => expect(mocks.exportDocument).toHaveBeenCalledTimes(1));
    expect(mocks.events).toContain('finishStroke');
    expect(mocks.events).toContain('flush');
    expect(mocks.events.indexOf('finishStroke')).toBeLessThan(mocks.events.lastIndexOf('flush'));
    expect(mocks.events.lastIndexOf('flush')).toBeLessThan(mocks.events.indexOf('export'));
    expect(mocks.exportDocument).toHaveBeenCalledWith(expect.objectContaining({
      document_id: 'board-doc-1',
      expected_revision: 'board-rev-1',
      page_ids: ['board-page-1'],
      format: 'png',
      operation_id: expect.any(String),
      board: {
        region: mocks.viewportCrop,
        page_width: mocks.viewportCrop.width,
        page_height: mocks.viewportCrop.height,
        paginate: false,
      },
    }));
    await waitFor(() => expect(opened).toEqual(['/file-board-export-1']));
    expect(opened).not.toContain('/board-doc-1');
  });

  it('uses an explicit selection crop for PNG instead of the surface bounds', async () => {
    render(<LazyInkBoardEditor documentId="board-doc-1" />);

    await screen.findByTestId('ink-board-editor');
    await waitFor(() => expect(screen.getByTestId('ink-board-overview-state')).toHaveAttribute('data-state', 'ready'));
    const onSelectionChange = mocks.viewProps.current?.onSelectionChange as
      | ((selection: { polygon: typeof SELECTION_POLYGON; bounds: typeof mocks.selectionCrop; objectIds: string[] }) => void)
      | undefined;
    act(() => {
      onSelectionChange?.({
        polygon: SELECTION_POLYGON,
        bounds: mocks.selectionCrop,
        objectIds: ['obj-1'],
      });
    });

    const exportButton = screen.getByTestId('ink-board-export');
    expect(exportButton).toBeEnabled();
    fireEvent.click(exportButton);
    await screen.findByTestId('ink-board-export-dialog');
    fireEvent.click(screen.getByTestId('ink-board-export-submit'));

    await waitFor(() => expect(mocks.exportDocument).toHaveBeenCalledTimes(1));
    expect(mocks.exportDocument).toHaveBeenCalledWith(expect.objectContaining({
      format: 'png',
      board: {
        region: mocks.selectionCrop,
        page_width: mocks.selectionCrop.width,
        page_height: mocks.selectionCrop.height,
        paginate: false,
      },
    }));
    expect((mocks.exportDocument.mock.calls[0][0] as { board: { region: unknown } }).board.region)
      .not.toEqual(mocks.manifest.surface.bounds);
  });

  it('exports PDF with the current frame and an explicit row-major page grid below the 500-page preview bound', async () => {
    const opened: string[] = [];
    listenForOpenResource((event) => opened.push(event.detail.dstuPath));
    render(<LazyInkBoardEditor documentId="board-doc-1" />);

    await screen.findByTestId('ink-board-editor');
    await waitFor(() => expect(screen.getByTestId('ink-board-overview-state')).toHaveAttribute('data-state', 'ready'));
    const exportButton = screen.getByTestId('ink-board-export');
    expect(exportButton).toBeEnabled();
    fireEvent.click(exportButton);
    await screen.findByTestId('ink-board-export-dialog');

    fireEvent.click(screen.getByTestId('ink-board-export-format-pdf'));
    fireEvent.change(screen.getByTestId('ink-board-export-page-width'), { target: { value: '400' } });
    fireEvent.change(screen.getByTestId('ink-board-export-page-height'), { target: { value: '300' } });
    const preview = screen.getByTestId('ink-board-export-preview');
    expect(preview).toHaveAttribute('data-row-major', 'true');
    expect(Number(preview.getAttribute('data-page-count'))).toBe(4);
    expect(Number(preview.getAttribute('data-page-count'))).toBeLessThanOrEqual(500);

    fireEvent.click(screen.getByTestId('ink-board-export-submit'));
    await waitFor(() => expect(mocks.exportDocument).toHaveBeenCalledTimes(1));
    expect(mocks.exportDocument).toHaveBeenCalledWith(expect.objectContaining({
      page_ids: ['board-page-1'],
      format: 'pdf',
      operation_id: expect.any(String),
      board: {
        region: mocks.viewportCrop,
        page_width: 400,
        page_height: 300,
        paginate: true,
      },
    }));
    await waitFor(() => expect(opened).toEqual(['/file-board-export-1']));
  });

  it('releases the space-pan state on window keyup and blur through the shared event registry', async () => {
    render(<LazyInkBoardEditor documentId="board-doc-1" />);

    const editor = await screen.findByTestId('ink-board-editor');
    fireEvent.keyDown(editor, { code: 'Space', key: ' ' });
    expect(mocks.viewProps.current?.spaceDown).toBe(true);

    fireEvent.keyUp(window, { code: 'Space' });
    await waitFor(() => expect(mocks.viewProps.current?.spaceDown).toBe(false));

    fireEvent.keyDown(editor, { code: 'Space', key: ' ' });
    expect(mocks.viewProps.current?.spaceDown).toBe(true);

    fireEvent(window, new Event('blur'));
    await waitFor(() => expect(mocks.viewProps.current?.spaceDown).toBe(false));
  });

  it('retries a rejected overview explicitly, then commits a stroke with the resolved global z', async () => {
    mocks.getInkBoardOverview.mockRejectedValueOnce(new Error('overview unavailable'));
    render(<LazyInkBoardEditor documentId="board-doc-1" />);

    await waitFor(() =>
      expect(screen.getByTestId('ink-board-overview-state')).toHaveAttribute('data-state', 'error'));

    mocks.getInkBoardOverview.mockResolvedValueOnce({
      document_id: 'board-doc-1',
      revision: 'board-rev-1',
      page_id: 'board-page-1',
      max_z_index: '41',
    });
    fireEvent.click(screen.getByTestId('ink-board-overview-retry'));
    await waitFor(() =>
      expect(screen.getByTestId('ink-board-overview-state')).toHaveAttribute('data-state', 'ready'));

    const onCommitStroke = mocks.viewProps.current?.onCommitStroke as
      | ((content: {
        kind: 'stroke';
        samples: Array<{ x: number; y: number; pressure: number; elapsed_ms: number }>;
        style: { tool: 'pen'; color: string; width: number; pressure_enabled: boolean };
      }) => Promise<void>)
      | undefined;
    await act(async () => {
      await onCommitStroke?.({
        kind: 'stroke',
        samples: [
          { x: 0, y: 0, pressure: 0.5, elapsed_ms: 0 },
          { x: 2, y: 2, pressure: 0.5, elapsed_ms: 2 },
        ],
        style: { tool: 'pen', color: '#000000', width: 2, pressure_enabled: true },
      });
    });
    expect(mocks.insertObjects).toHaveBeenCalledTimes(1);
    expect(mocks.insertObjects.mock.calls[0][0][0]).toEqual(
      expect.objectContaining({ z_index: 42 }),
    );
  });

  type CommitStroke = (content: {
    kind: 'stroke';
    samples: Array<{ x: number; y: number; pressure: number; elapsed_ms: number }>;
    style: { tool: 'pen'; color: string; width: number; pressure_enabled: boolean };
  }) => Promise<void>;

  const STROKE_CONTENT = {
    kind: 'stroke' as const,
    samples: [
      { x: 0, y: 0, pressure: 0.5, elapsed_ms: 0 },
      { x: 2, y: 2, pressure: 0.5, elapsed_ms: 2 },
    ],
    style: { tool: 'pen' as const, color: '#000000', width: 2, pressure_enabled: true },
  };

  async function mountReadyBoard() {
    const view = render(<LazyInkBoardEditor documentId="board-doc-1" />);
    await screen.findByTestId('ink-board-editor');
    await waitFor(() =>
      expect(screen.getByTestId('ink-board-overview-state')).toHaveAttribute('data-state', 'ready'));
    return view;
  }

  function currentCommitStroke(): CommitStroke {
    const handler = mocks.viewProps.current?.onCommitStroke as CommitStroke | undefined;
    expect(handler).toBeTypeOf('function');
    return handler as CommitStroke;
  }

  it('uses the view active callback and fences callbacks from an old epoch or document', async () => {
    const view = await mountReadyBoard();
    const active = mocks.viewProps.current?.onActiveStrokeChange as ((active: boolean) => void) | undefined;
    expect(active).toBeTypeOf('function');
    act(() => { active!(true); active!(false); });
    expect(mocks.setActiveInput.mock.calls).toEqual([[true], [false]]);

    mocks.saveState.revisionEpoch = 1;
    mocks.manifestState.current = { ...mocks.manifestState.current, revision: 'board-rev-2' };
    mocks.getInkBoardOverview.mockImplementationOnce(() => new Promise<never>(() => undefined));
    view.rerender(<LazyInkBoardEditor documentId="board-doc-1" />);
    mocks.setActiveInput.mockClear();
    act(() => { active!(true); active!(false); });
    expect(mocks.setActiveInput).not.toHaveBeenCalled();
    const current = mocks.viewProps.current?.onActiveStrokeChange as (active: boolean) => void;
    act(() => { current(true); current(false); });
    expect(mocks.setActiveInput.mock.calls).toEqual([[true], [false]]);

    mocks.setActiveInput.mockClear();
    view.rerender(<LazyInkBoardEditor documentId="board-doc-2" />);
    act(() => { current(true); current(false); });
    expect(mocks.setActiveInput).not.toHaveBeenCalled();
  });

  function installIdleTimers() {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  }

  it('keeps completed strokes in memory across idle periods until an explicit save finishes input and flushes', async () => {
    await mountReadyBoard();
    const commitStroke = currentCommitStroke();
    installIdleTimers();
    try {
      await act(async () => { await commitStroke(STROKE_CONTENT); });
      expect(mocks.insertObjects).toHaveBeenCalledTimes(1);
      await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
      expect(mocks.save).not.toHaveBeenCalled();
      expect(mocks.boardFlush).not.toHaveBeenCalled();

      await act(async () => { await commitStroke(STROKE_CONTENT); });
      await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
      expect(mocks.insertObjects).toHaveBeenCalledTimes(2);
      expect(mocks.save).not.toHaveBeenCalled();
      expect(mocks.boardFlush).not.toHaveBeenCalled();

      mocks.saveState.saveStatus = 'pending';
      fireEvent.click(screen.getByTestId('ink-board-tool-highlighter'));
      fireEvent.click(screen.getByTestId('ink-board-save'));
      await act(async () => undefined);
      expect(mocks.events).toEqual(['finishStroke', 'flush']);
      expect(mocks.boardFlush).toHaveBeenCalledOnce();
      expect(mocks.save).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('never starts an idle CAS after unmount or while the document reports storage-error', async () => {
    const view = await mountReadyBoard();
    const commitStroke = currentCommitStroke();
    installIdleTimers();
    try {
      await act(async () => { await commitStroke(STROKE_CONTENT); });
      expect(mocks.insertObjects).toHaveBeenCalledTimes(1);
      await act(async () => { await vi.advanceTimersByTimeAsync(500); });
      expect(mocks.save).not.toHaveBeenCalled();

      act(() => { view.unmount(); });
      await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
      expect(mocks.save).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }

    mocks.save.mockClear();
    mocks.insertObjects.mockClear();
    mocks.saveState.saveStatus = 'storage-error';
    try {
      await mountReadyBoard();
      expect(screen.getByTestId('ink-board-save-state')).toHaveAttribute('data-state', 'storage-error');
      const storageErrorCommit = currentCommitStroke();
      installIdleTimers();

      await act(async () => { await storageErrorCommit(STROKE_CONTENT); });
      expect(mocks.insertObjects).toHaveBeenCalledTimes(1);
      await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
      expect(mocks.save).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      mocks.saveState.saveStatus = 'saved';
    }
  });

  it('keeps the authorized next z across a local save with a pending overview, but not across a remote epoch change', async () => {
    mocks.getInkBoardOverview.mockResolvedValueOnce({
      document_id: 'board-doc-1',
      revision: 'board-rev-1',
      page_id: 'board-page-1',
      max_z_index: '41',
    });
    const view = await mountReadyBoard();

    await act(async () => { await currentCommitStroke()(STROKE_CONTENT); });
    expect(mocks.insertObjects).toHaveBeenCalledTimes(1);
    const firstZ = (mocks.insertObjects.mock.calls[0][0][0] as { z_index: number }).z_index;
    expect(firstZ).toBe(42);

    // Own save publishes a new revision on the same surface/remote epoch while
    // the refreshed overview is still pending. The existing next-z grant must
    // survive this (the old strict revision match used to reject the gesture).
    mocks.manifestState.current = { ...mocks.manifestState.current, revision: 'board-rev-2' };
    mocks.getInkBoardOverview.mockImplementationOnce(() => new Promise<never>(() => undefined));
    view.rerender(<LazyInkBoardEditor documentId="board-doc-1" />);

    await act(async () => { await currentCommitStroke()(STROKE_CONTENT); });
    expect(mocks.insertObjects).toHaveBeenCalledTimes(2);
    const secondZ = (mocks.insertObjects.mock.calls[1][0][0] as { z_index: number }).z_index;
    expect(secondZ).toBeGreaterThan(firstZ);

    // A remote epoch change invalidates that grant: until a fresh bounded
    // summary arrives the gesture must not insert, and must not reuse old z.
    mocks.saveState.revisionEpoch = 1;
    mocks.manifestState.current = { ...mocks.manifestState.current, revision: 'board-rev-3' };
    mocks.getInkBoardOverview.mockImplementationOnce(() => new Promise<never>(() => undefined));
    view.rerender(<LazyInkBoardEditor documentId="board-doc-1" />);

    await act(async () => { await currentCommitStroke()(STROKE_CONTENT); });
    expect(mocks.insertObjects).toHaveBeenCalledTimes(2);
  });
});
