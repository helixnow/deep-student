import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import NoteContentView from '@/features/learning-hub/apps/views/NoteContentView';
import type { DstuNode } from '@/dstu/types';
import type { CrepeEditorApi } from '@/components/crepe/types';
import { createFullDocumentApi } from '@/features/notes/fullDocument';
import {
  __resetContentDirtyRegistry,
  registerContentDirtyChecker,
} from '@/features/workbench/apps/content/contentDirtyRegistry';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  getContent: vi.fn(),
  update: vi.fn(),
  setMetadata: vi.fn(),
  watch: vi.fn(),
  getContentRange: vi.fn(),
  streamContent: vi.fn(),
  loadInitialLineWindowSetting: vi.fn(),
  showGlobalNotification: vi.fn(),
  latestEditorProps: null as any,
  contextPanelContents: [] as string[],
  watchCallback: null as ((event: any) => void) | null,
}));

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: vi.fn() },
  useTranslation: () => ({
    t: (_key: string, defaultValue?: string) => defaultValue ?? _key,
  }),
}));

vi.mock('@/dstu', () => ({
  dstu: {
    get: mocks.get,
    getContent: mocks.getContent,
    update: mocks.update,
    setMetadata: mocks.setMetadata,
    watch: mocks.watch,
    getContentRange: mocks.getContentRange,
    streamContent: mocks.streamContent,
  },
}));

vi.mock('@/features/notes/markdownWindowSettings', () => ({
  loadInitialLineWindowSetting: mocks.loadInitialLineWindowSetting,
}));

vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: mocks.showGlobalNotification,
}));

vi.mock('@/stores/systemStatusStore', () => ({
  useSystemStatusStore: {
    getState: () => ({ maintenanceMode: false }),
  },
}));

vi.mock('@/hooks/useBreakpoint', () => ({
  useIsMobile: () => false,
}));

vi.mock('@/components/ui/DsButton', () => ({
  DsButton: ({ children, iconOnly: _iconOnly, variant: _variant, size: _size, ...props }: any) => (
    <button type="button" {...props}>{children}</button>
  ),
}));

vi.mock('@/components/shared/CommonTooltip', () => ({
  CommonTooltip: ({ children }: any) => <>{children}</>,
}));

vi.mock('@/components/ui/shad/Sheet', () => ({
  Sheet: ({ children }: any) => <>{children}</>,
  SheetContent: ({ children }: any) => <div>{children}</div>,
}));

vi.mock('react-resizable-panels', () => ({
  PanelGroup: ({ children }: any) => <div>{children}</div>,
  Panel: React.forwardRef<HTMLDivElement, any>(function MockPanel({ children }, ref) {
    React.useImperativeHandle(ref, () => ({ collapse: vi.fn(), expand: vi.fn() }) as any);
    return <div>{children}</div>;
  }),
  PanelResizeHandle: ({ children }: any) => <div>{children}</div>,
}));

vi.mock('@/features/notes/NotesCrepeEditor', () => ({
  NotesCrepeEditor: (props: any) => {
    mocks.latestEditorProps = props;
    return (
      <div data-testid="notes-crepe-editor">
        {props.initialContent}
        {props.headerActions}
      </div>
    );
  },
}));

vi.mock('@/features/notes/NotesContextPanel', () => ({
  NotesContextPanel: (props: any) => {
    mocks.contextPanelContents.push(props.content ?? '');
    return <aside data-testid="notes-context-panel" />;
  },
}));

const node: DstuNode = {
  id: 'note_1',
  sourceId: 'note_1',
  path: '/note_1',
  name: 'Windowed note',
  type: 'note',
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_001_000,
  metadata: { tags: [] },
  resourceHash: 'hash-1',
};

function ok<T>(value: T) {
  return { ok: true as const, value };
}

function err(error: unknown) {
  return { ok: false as const, error };
}

function makeLines(count: number, prefix = 'line') {
  return Array.from({ length: count }, (_, index) => `${prefix} ${index + 1}`).join('\n');
}

function lineCount(markdown: string) {
  return markdown.split('\n').length;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

async function renderWindowedNote(markdown = makeLines(1000)) {
  mocks.get.mockResolvedValue(ok(node));
  mocks.getContent.mockResolvedValue(ok(markdown));
  mocks.update.mockResolvedValue(ok({ ...node, updatedAt: node.updatedAt + 1000 }));
  mocks.setMetadata.mockResolvedValue(ok(undefined));
  mocks.loadInitialLineWindowSetting.mockResolvedValue(100);
  mocks.watch.mockImplementation((_path: string, callback: (event: any) => void) => {
    mocks.watchCallback = callback;
    return vi.fn();
  });

  render(<NoteContentView node={node} isActive />);
  await waitFor(() => expect(mocks.latestEditorProps).not.toBeNull());
  return mocks.latestEditorProps;
}

function attachFullDocumentEditor(props: any, liveVisible: string) {
  const state = { visible: liveVisible, revision: 1, rejectCandidate: false, throwCandidate: false };
  const retainFailure = vi.fn();
  const setMarkdown = vi.fn((markdown: string) => {
    state.revision++;
    if (markdown === 'candidate' && state.throwCandidate) throw new Error('parser failed');
    state.visible = markdown === 'candidate' && state.rejectCandidate ? 'normalized candidate' : markdown;
    return true;
  });
  const flushPendingSave = vi.fn(() => props.onSave(state.visible));
  const extended = props.extendEditorApi({
    getMarkdown: () => state.visible,
    setMarkdown,
    isReadonly: () => false,
    flushPendingSave,
  } as unknown as CrepeEditorApi);
  const api = createFullDocumentApi(extended, {
    noteId: props.noteId,
    isCurrent: () => mocks.latestEditorProps.noteId === props.noteId,
    revision: () => state.revision,
    isWindowed: () => extended.isDocumentWindowed(),
    retainFailure,
  });
  act(() => props.onEditorReady(api));
  return { api, state, setMarkdown, flushPendingSave, retainFailure };
}

describe('NoteContentView windowing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetContentDirtyRegistry();
    mocks.latestEditorProps = null;
    mocks.contextPanelContents = [];
    mocks.watchCallback = null;
  });

  it('reads the initial OCC token before requesting note content', async () => {
    const pendingNode = deferred<ReturnType<typeof ok<DstuNode>>>();
    const markdown = makeLines(1000);
    mocks.get.mockReturnValueOnce(pendingNode.promise);
    mocks.getContent.mockResolvedValue(ok(markdown));
    mocks.update.mockResolvedValue(ok({ ...node, updatedAt: node.updatedAt + 1000 }));
    mocks.setMetadata.mockResolvedValue(ok(undefined));
    mocks.loadInitialLineWindowSetting.mockResolvedValue(100);
    mocks.watch.mockImplementation((_path: string, callback: (event: any) => void) => {
      mocks.watchCallback = callback;
      return vi.fn();
    });

    render(<NoteContentView node={node} isActive />);
    await waitFor(() => expect(mocks.get).toHaveBeenCalledTimes(1));
    expect(mocks.getContent).not.toHaveBeenCalled();

    await act(async () => {
      pendingNode.resolve(ok(node));
      await pendingNode.promise;
    });

    await waitFor(() => expect(mocks.latestEditorProps).not.toBeNull());
    expect(mocks.getContent).toHaveBeenCalledTimes(1);
  });

  it('passes only the configured initial markdown window to the editor and context panel', async () => {
    const props = await renderWindowedNote();

    expect(mocks.getContent).toHaveBeenCalledTimes(1);
    expect(mocks.getContent).toHaveBeenCalledWith('/note_1');
    expect(mocks.getContentRange).not.toHaveBeenCalled();
    expect(mocks.streamContent).not.toHaveBeenCalled();

    expect(lineCount(props.initialContent)).toBe(100);
    expect(props.initialContent).toContain('line 100');
    expect(props.initialContent).not.toContain('line 101');
    expect(props.windowingState).toMatchObject({
      enabled: true,
      loadedLineCount: 100,
      totalLineCount: 1000,
      hasMore: true,
    });

    expect(screen.queryByTestId('notes-context-panel')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'notes:contextPanel.title' }));
    await waitFor(() => expect(mocks.contextPanelContents.at(-1)).toBe(makeLines(1000)));
  });

  it('provides live full markdown to internal editor actions before the tail is loaded', async () => {
    const markdown = makeLines(1000);
    const props = await renderWindowedNote(markdown);
    let visible = props.initialContent;
    const api = props.extendEditorApi({ getMarkdown: () => visible });
    expect(api.isDocumentWindowed()).toBe(true);
    expect(api.getFullMarkdown()).toBe(markdown);
    visible = visible.replace('line 1\n', 'edited first line\n');
    expect(api.getFullMarkdown()).toBe(markdown.replace('line 1\n', 'edited first line\n'));
    expect(api.getFullMarkdown()).toContain('line 1000');
    act(() => props.onEditorReady(api));
    fireEvent.click(screen.getByRole('button', { name: 'notes:contextPanel.title' }));
    await waitFor(() => expect(mocks.contextPanelContents.at(-1)).toBe(api.getFullMarkdown()));
  });

  it.each(['roundtrip', 'throw'] as const)('restores the live unsaved window and complete draft on %s failure', async (failure) => {
    const original = makeLines(1000) + '\n\n';
    const props = await renderWindowedNote(original);
    const liveVisible = 'UNSAVED first line\nnew local paragraph\n';
    const { api, state, retainFailure, flushPendingSave } = attachFullDocumentEditor(props, liveVisible);
    const before = api.getFullDocument();
    state.rejectCandidate = failure === 'roundtrip';
    state.throwCandidate = failure === 'throw';

    await act(async () => {
      await expect(api.replaceFullDocument('candidate', before)).rejects.toThrow();
    });

    expect(state.visible).toBe(liveVisible);
    expect(api.getFullDocument().markdown).toBe(before.markdown);
    expect(api.getFullDocument().markdown).toContain('line 1000\n\n');
    expect(mocks.latestEditorProps.initialContent).toBe(liveVisible);
    expect(flushPendingSave).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
    expect(retainFailure.mock.calls[0][2]).toBe(before.markdown);
    // A later autosave uses the rebased live prefix boundary, not the old 100 lines.
    await act(async () => mocks.latestEditorProps.onSave(state.visible));
    expect(mocks.update.mock.calls.at(-1)?.[1]).toBe(before.markdown);
  });

  it('persists a full replacement of an unsaved window, including edits in its hidden tail', async () => {
    const props = await renderWindowedNote();
    const { api } = attachFullDocumentEditor(props, 'UNSAVED prefix');
    const before = api.getFullDocument();
    const candidate = before.markdown.replace('line 1000', 'AI changed hidden tail');
    await act(async () => expect(api.replaceFullDocument(candidate, before)).resolves.toMatchObject({ noteId: node.id, markdown: candidate }));
    expect(mocks.update.mock.calls.at(-1)?.[1]).toBe(candidate);
    expect(api.getFullDocument().markdown).toBe(candidate);
    expect(mocks.latestEditorProps.windowingState.hasMore).toBe(false);
  });

  it('rejects an old revision even after text returns to the same value', async () => {
    const props = await renderWindowedNote();
    const { api, state, setMarkdown } = attachFullDocumentEditor(props, 'UNSAVED prefix');
    const baseline = api.getFullDocument();
    state.revision++;
    await expect(api.replaceFullDocument('candidate', baseline)).rejects.toThrow();
    expect(setMarkdown).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('does not acknowledge an old full replacement or restore it into a newly opened note', async () => {
    const oldContent = makeLines(1000);
    mocks.get.mockResolvedValue(ok(node));
    mocks.getContent.mockResolvedValue(ok(oldContent));
    mocks.loadInitialLineWindowSetting.mockResolvedValue(100);
    mocks.watch.mockReturnValue(vi.fn());
    const view = render(<NoteContentView node={node} isActive />);
    await waitFor(() => expect(mocks.latestEditorProps).not.toBeNull());
    const { api } = attachFullDocumentEditor(mocks.latestEditorProps, 'old unsaved prefix');
    const pending = deferred<ReturnType<typeof ok<DstuNode>>>();
    mocks.update.mockReturnValueOnce(pending.promise);
    let outcome!: Promise<unknown>;
    act(() => { outcome = api.replaceFullDocument('candidate', api.getFullDocument()).catch((error) => error); });
    const second = { ...node, id: 'note_2', sourceId: 'note_2', path: '/note_2' };
    mocks.get.mockResolvedValue(ok(second));
    mocks.getContent.mockResolvedValue(ok('second note'));
    view.rerender(<NoteContentView node={second} isActive />);
    await waitFor(() => expect(mocks.latestEditorProps.noteId).toBe('note_2'));
    await act(async () => { pending.resolve(ok(node)); await outcome; });
    expect(await outcome).toBeInstanceOf(Error);
    expect(mocks.latestEditorProps.initialContent).toBe('second note');
    expect(() => api.getFullDocument()).toThrow();
  });

  it('loads more from the original suffix while preserving the edited prefix', async () => {
    const props = await renderWindowedNote();

    const result = await act(async () => props.onRequestLoadMore('edited line 1\nedited line 2'));

    expect(result?.loadedMarkdown.startsWith('edited line 1\nedited line 2\nline 101')).toBe(true);
    expect(result?.loadedMarkdown).toContain('line 400');
    expect(result?.loadedMarkdown).not.toContain('line 401');
    expect(result).toMatchObject({
      loadedLineCount: 400,
      totalLineCount: 1000,
      hasMore: true,
    });
  });

  it('saves a partial editor window as the composed full markdown with hidden suffix intact', async () => {
    const props = await renderWindowedNote();

    await act(async () => {
      await props.onSave('edited loaded prefix');
    });

    const updateContent = mocks.update.mock.calls.at(-1)?.[1] as string;
    expect(updateContent.startsWith('edited loaded prefix\nline 101')).toBe(true);
    expect(updateContent).toContain('line 1000');
    expect(updateContent).not.toContain('line 1\nline 2');
  });

  it('preserves a newer load-more projection when an older save completes', async () => {
    const props = await renderWindowedNote();
    const pendingUpdate = deferred<ReturnType<typeof ok<DstuNode>>>();
    mocks.update.mockReset();
    mocks.update.mockReturnValueOnce(pendingUpdate.promise);

    let savePromise!: Promise<void>;
    act(() => {
      savePromise = props.onSave('edited loaded prefix');
    });
    await waitFor(() => expect(mocks.update).toHaveBeenCalledTimes(1));

    const expanded = await act(async () => (
      mocks.latestEditorProps.onRequestLoadMore('edited loaded prefix')
    ));
    expect(expanded.loadedMarkdown).toContain('line 400');

    pendingUpdate.resolve(ok({ ...node, updatedAt: node.updatedAt + 1000 }));
    await act(async () => savePromise);

    await waitFor(() => {
      expect(mocks.latestEditorProps.initialContent).toContain('line 400');
      expect(mocks.latestEditorProps.windowingState.loadedLineCount).toBe(301);
    });

    mocks.update.mockReset();
    mocks.update.mockResolvedValue(ok({ ...node, updatedAt: node.updatedAt + 2000 }));
    await act(async () => {
      await mocks.latestEditorProps.onSave(expanded.loadedMarkdown);
    });

    const recomposed = mocks.update.mock.calls.at(-1)?.[1] as string;
    expect(recomposed).toContain('line 1000');
    expect(recomposed.split('\n').filter((line) => line === 'line 101')).toHaveLength(1);
    expect(recomposed.split('\n').filter((line) => line === 'line 401')).toHaveLength(1);
  });

  it('dispatches only projected loaded markdown on external refresh', async () => {
    await renderWindowedNote();
    const externalMarkdown = makeLines(1000, 'external line');
    mocks.get.mockResolvedValue(ok({ ...node, updatedAt: node.updatedAt + 2000 }));
    mocks.getContent.mockResolvedValue(ok(externalMarkdown));
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent');

    act(() => {
      mocks.watchCallback?.({
        type: 'updated',
        path: '/note_1',
        node: { ...node, updatedAt: node.updatedAt + 2000 },
      });
    });

    await waitFor(() => {
      expect(dispatchSpy.mock.calls.some(([event]) => event.type === 'notes:external-updated')).toBe(true);
    });
    const event = dispatchSpy.mock.calls
      .map(([entry]) => entry)
      .find((entry) => entry.type === 'notes:external-updated') as CustomEvent;

    expect(lineCount(event.detail.content)).toBe(100);
    expect(event.detail.content).toContain('external line 100');
    expect(event.detail.content).not.toContain('external line 1000');
    dispatchSpy.mockRestore();
  });

  it('keeps window A baseline stale so A conflicts after dirty window B saves', async () => {
    const props = await renderWindowedNote();
    const unregisterDirty = registerContentDirtyChecker('note', node.id, () => true);
    const externalUpdatedAt = node.updatedAt + 3000;
    const externalMarkdown = makeLines(1000, 'window B');
    mocks.get.mockResolvedValue(ok({ ...node, updatedAt: externalUpdatedAt }));
    mocks.getContent.mockResolvedValue(ok(externalMarkdown));
    mocks.update.mockReset();
    mocks.update.mockResolvedValue(err({ code: 'CONFLICT', toUserMessage: () => 'Conflict' }));
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent');

    act(() => {
      mocks.watchCallback?.({
        type: 'updated',
        path: node.path,
        node: { ...node, updatedAt: externalUpdatedAt },
      });
    });

    expect(dispatchSpy.mock.calls.some(([event]) => event.type === 'notes:external-updated')).toBe(false);
    await expect(props.onSave('window A dirty edit')).rejects.toThrow('Conflict');

    const firstUpdateOptions = mocks.update.mock.calls[0]?.[3];
    expect(firstUpdateOptions).toMatchObject({ expectedUpdatedAtMs: node.updatedAt });
    expect(firstUpdateOptions.expectedUpdatedAtMs).not.toBe(externalUpdatedAt);

    unregisterDirty();
    dispatchSpy.mockRestore();
  });

  it('abandons an external refresh if the editor becomes dirty while disk reads are pending', async () => {
    const props = await renderWindowedNote();
    const pendingNode = deferred<ReturnType<typeof ok<DstuNode>>>();
    const pendingContent = deferred<ReturnType<typeof ok<string>>>();
    const externalUpdatedAt = node.updatedAt + 5000;
    mocks.get.mockReturnValueOnce(pendingNode.promise);
    mocks.getContent.mockReturnValueOnce(pendingContent.promise);
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent');

    act(() => {
      mocks.watchCallback?.({
        type: 'updated',
        path: node.path,
        node: { ...node, updatedAt: externalUpdatedAt },
      });
    });
    await waitFor(() => expect(mocks.get).toHaveBeenCalledTimes(2));
    expect(mocks.getContent).toHaveBeenCalledTimes(1);

    await act(async () => {
      pendingNode.resolve(ok({ ...node, updatedAt: externalUpdatedAt }));
      await pendingNode.promise;
    });
    await waitFor(() => expect(mocks.getContent).toHaveBeenCalledTimes(2));
    const unregisterDirty = registerContentDirtyChecker('note', node.id, () => true);

    await act(async () => {
      pendingContent.resolve(ok(makeLines(1000, 'external pending')));
      await pendingContent.promise;
    });

    expect(dispatchSpy.mock.calls.some(([event]) => event.type === 'notes:external-updated')).toBe(false);
    mocks.update.mockReset();
    mocks.update.mockResolvedValue(err({ code: 'CONFLICT', toUserMessage: () => 'Conflict' }));
    mocks.get.mockResolvedValue(ok({ ...node, updatedAt: externalUpdatedAt }));
    mocks.getContent.mockResolvedValue(ok(makeLines(1000, 'external pending')));
    await expect(props.onSave('local edit after pending refresh')).rejects.toThrow('Conflict');
    expect(mocks.update.mock.calls[0]?.[3]).toMatchObject({ expectedUpdatedAtMs: node.updatedAt });

    unregisterDirty();
    dispatchSpy.mockRestore();
  });

  it('does not advance the save baseline when an external content refresh fails', async () => {
    const props = await renderWindowedNote();
    const externalUpdatedAt = node.updatedAt + 6000;
    mocks.get.mockResolvedValue(ok({ ...node, updatedAt: externalUpdatedAt }));
    mocks.getContent.mockResolvedValueOnce(err({ code: 'IO_ERROR' }));

    act(() => {
      mocks.watchCallback?.({
        type: 'updated',
        path: node.path,
        node: { ...node, updatedAt: externalUpdatedAt },
      });
    });
    await waitFor(() => expect(mocks.getContent).toHaveBeenCalledTimes(2));

    mocks.update.mockReset();
    mocks.update.mockResolvedValue(err({ code: 'CONFLICT', toUserMessage: () => 'Conflict' }));
    mocks.getContent.mockResolvedValue(ok(makeLines(1000, 'external after failure')));
    await expect(props.onSave('local edit after failed refresh')).rejects.toThrow('Conflict');

    expect(mocks.update.mock.calls[0]?.[3]).toMatchObject({ expectedUpdatedAtMs: node.updatedAt });
  });

  it('reads the conflict token before content when classifying a metadata-only conflict', async () => {
    const originalMarkdown = makeLines(1000);
    const props = await renderWindowedNote(originalMarkdown);
    const pendingNode = deferred<ReturnType<typeof ok<DstuNode>>>();
    const metadataUpdatedAt = node.updatedAt + 7000;
    mocks.get.mockReturnValueOnce(pendingNode.promise);
    mocks.update.mockReset();
    mocks.update
      .mockResolvedValueOnce(err({ code: 'CONFLICT', toUserMessage: () => 'Conflict' }))
      .mockResolvedValueOnce(ok({ ...node, updatedAt: metadataUpdatedAt + 1000 }));

    let savePromise!: Promise<void>;
    act(() => {
      savePromise = props.onSave('local edit after metadata change');
    });
    await waitFor(() => expect(mocks.get).toHaveBeenCalledTimes(2));
    // The initial load is the only content read until the fresh OCC token resolves.
    expect(mocks.getContent).toHaveBeenCalledTimes(1);

    await act(async () => {
      pendingNode.resolve(ok({ ...node, updatedAt: metadataUpdatedAt }));
      await pendingNode.promise;
    });
    await waitFor(() => expect(mocks.getContent).toHaveBeenCalledTimes(2));
    await act(async () => savePromise);

    expect(mocks.update).toHaveBeenCalledTimes(2);
    expect(mocks.update.mock.calls[1]?.[3]).toMatchObject({
      expectedUpdatedAtMs: metadataUpdatedAt,
    });
  });

  it('restores conflict user content through a loaded window and recomposes it on save retry', async () => {
    const props = await renderWindowedNote();
    const externalMarkdown = makeLines(1000, 'external line');
    mocks.update.mockResolvedValueOnce(err({ code: 'CONFLICT', toUserMessage: () => 'Conflict' }));
    mocks.get.mockResolvedValue(ok({ ...node, updatedAt: node.updatedAt + 3000 }));
    mocks.getContent.mockResolvedValue(ok(externalMarkdown));
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent');

    await expect(props.onSave('edited loaded prefix')).rejects.toThrow('Conflict');

    const notificationOptions = mocks.showGlobalNotification.mock.calls
      .map((call) => call[3])
      .find((options) => options?.action);
    expect(notificationOptions?.action).toBeTruthy();

    act(() => {
      notificationOptions.action.onClick();
    });

    const requestSaveEvent = dispatchSpy.mock.calls
      .map(([event]) => event)
      .filter((event) => event.type === 'notes:request-save')
      .at(-1) as CustomEvent;

    expect(requestSaveEvent.detail.content).toContain('edited loaded prefix');
    expect(lineCount(requestSaveEvent.detail.content)).toBe(100);
    expect(requestSaveEvent.detail.content).not.toContain('line 1000');

    mocks.update.mockReset();
    mocks.update.mockResolvedValue(ok({ ...node, updatedAt: node.updatedAt + 4000 }));
    await waitFor(() => expect(mocks.latestEditorProps.initialContent).toBe(requestSaveEvent.detail.content));

    await act(async () => {
      await mocks.latestEditorProps.onSave(requestSaveEvent.detail.content);
    });

    const restoredFullContent = mocks.update.mock.calls.at(-1)?.[1] as string;
    expect(restoredFullContent).toContain('edited loaded prefix');
    expect(restoredFullContent).toContain('line 1000');
    expect(restoredFullContent).not.toContain('external line 1000');
    dispatchSpy.mockRestore();
  });
});
