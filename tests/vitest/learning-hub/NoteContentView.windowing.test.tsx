import React from 'react';
import { act, render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import NoteContentView from '@/features/learning-hub/apps/views/NoteContentView';
import type { DstuNode } from '@/dstu/types';

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

vi.mock('@/components/ui/NotionButton', () => ({
  NotionButton: ({ children, iconOnly: _iconOnly, variant: _variant, size: _size, ...props }: any) => (
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
    return <div data-testid="notes-crepe-editor">{props.initialContent}</div>;
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

describe('NoteContentView windowing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.latestEditorProps = null;
    mocks.contextPanelContents = [];
    mocks.watchCallback = null;
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
    expect(mocks.contextPanelContents.at(-1)).toBe(props.initialContent);
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
