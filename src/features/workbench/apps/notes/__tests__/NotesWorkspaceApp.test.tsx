import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppWindowProps } from '../../../core/types';

const nodes = [
  {
    id: 'note_1', sourceId: 'note_1', path: '/course/note_1', name: '课堂笔记', type: 'note',
    createdAt: 1, updatedAt: 1,
  },
  {
    id: 'mindmap_1', sourceId: 'mindmap_1', path: '/course/mindmap_1', name: '章节导图', type: 'mindmap',
    createdAt: 2, updatedAt: 2,
  },
] as const;

const panelProps: Array<Record<string, unknown>> = [];
const mindmapProps: Array<Record<string, unknown>> = [];

vi.mock('@/dstu', () => ({
  dstu: {
    list: vi.fn(async () => ({ ok: true, value: nodes })),
    watch: vi.fn(() => () => undefined),
    rename: vi.fn(async () => ({ ok: true, value: nodes[0] })),
    delete: vi.fn(async () => ({ ok: true, value: undefined })),
  },
  createEmpty: vi.fn(),
}));

vi.mock('@/features/learning-hub/apps/UnifiedAppPanel', () => ({
  default: (props: Record<string, unknown>) => {
    panelProps.push(props);
    return <div data-testid={`note-editor-${String(props.resourceId)}`} />;
  },
}));

vi.mock('@/features/mindmap/MindMapContentView', () => ({
  MindMapContentView: (props: Record<string, unknown>) => {
    mindmapProps.push(props);
    return <div data-testid={`mindmap-editor-${String(props.resourceId)}`} />;
  },
}));

import { dstu } from '@/dstu';
import { __resetContentDirtyRegistry, registerContentDirtyChecker } from '../../content/contentDirtyRegistry';
import { requestWorkspaceResource, resetWorkspaceRegistryForTests } from '../workspaceRegistry';
import { NotesWorkspaceApp } from '../NotesWorkspaceApp';

function props(overrides: Partial<AppWindowProps> = {}): AppWindowProps {
  return {
    windowId: 'notes-window',
    instanceKey: null,
    launchPayload: undefined,
    isActive: true,
    isVisible: true,
    onTitleChange: vi.fn(),
    requestClose: vi.fn(),
    ...overrides,
  };
}

describe('NotesWorkspaceApp', () => {
  beforeEach(() => {
    panelProps.length = 0;
    mindmapProps.length = 0;
    resetWorkspaceRegistryForTests();
    __resetContentDirtyRegistry();
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      disconnect() {}
    });
    const titlebarSlot = document.createElement('div');
    titlebarSlot.dataset.wbTitlebarSlot = '';
    titlebarSlot.dataset.windowId = 'notes-window';
    document.body.appendChild(titlebarSlot);
  });

  afterEach(() => {
    cleanup();
    document.querySelectorAll('[data-wb-titlebar-slot]').forEach((element) => element.remove());
    vi.unstubAllGlobals();
  });

  it('opens the cold-launch resource and exposes the Obsidian workspace selectors', async () => {
    render(<NotesWorkspaceApp {...props({ launchPayload: { resourceType: 'note', resourceId: 'note_1' } })} />);

    expect(document.querySelector('[data-wb-notes-workspace]')).not.toBeNull();
    expect(document.querySelector('[data-notes-ribbon]')).not.toBeNull();
    expect(document.querySelector('[data-notes-explorer]')).not.toBeNull();
    expect(document.querySelector('[data-notes-statusbar]')).not.toBeNull();
    expect(document.querySelector('[data-wb-notes-workspace] [data-notes-tabstrip]')).toBeNull();
    expect(document.querySelector('[data-wb-titlebar-slot] [data-notes-tabstrip]')).not.toBeNull();
    expect(document.querySelectorAll('[data-notes-pane]')).toHaveLength(1);
    expect(await screen.findByTestId('note-editor-note_1')).toBeInTheDocument();
    expect(document.querySelector('[data-notes-pane="main"]')?.getAttribute('data-resource-id')).toBe('note_1');
  });

  it('keeps note and mindmap types separate in one content area', async () => {
    render(<NotesWorkspaceApp {...props({ launchPayload: { resourceType: 'note', resourceId: 'note_1' } })} />);
    await screen.findByText('章节导图');

    fireEvent.click(screen.getByText('章节导图'));
    expect(await screen.findByTestId('mindmap-editor-mindmap_1')).toBeInTheDocument();
    expect(mindmapProps.at(-1)?.storeInstanceId).toBe('notes-window:mindmap:mindmap_1');
    await waitFor(() => {
      expect(document.querySelector('[data-notes-pane="main"]')?.getAttribute('data-resource-id')).toBe('mindmap_1');
    });
    expect(document.querySelectorAll('[data-notes-pane]')).toHaveLength(1);
    expect(panelProps.some((value) => value.type === 'note' && value.resourceId === 'note_1')).toBe(true);
    expect(mindmapProps.some((value) => value.resourceId === 'mindmap_1')).toBe(true);
  });

  it('writes editor title changes back to the internal tab', async () => {
    render(<NotesWorkspaceApp {...props({ launchPayload: { resourceType: 'note', resourceId: 'note_1' } })} />);
    await screen.findByTestId('note-editor-note_1');

    act(() => {
      (panelProps.at(-1)?.onTitleChange as (title: string) => void)('重命名后的笔记');
    });
    expect(screen.getByRole('tab', { name: /重命名后的笔记/ })).toBeInTheDocument();
  });

  it('deduplicates concurrent open requests for the same resource', async () => {
    render(<NotesWorkspaceApp {...props()} />);
    await screen.findByText('课堂笔记');

    await act(async () => {
      await Promise.all([
        requestWorkspaceResource({ type: 'note', id: 'note_1' }, 'notes-window'),
        requestWorkspaceResource({ type: 'note', id: 'note_1' }, 'notes-window'),
      ]);
    });

    expect(screen.getAllByRole('tab', { name: /未命名笔记|课堂笔记/ })).toHaveLength(1);
    expect(screen.getAllByTestId('note-editor-note_1')).toHaveLength(1);
  });

  it('really collapses the desktop explorer and keeps the shell state aligned', async () => {
    render(<NotesWorkspaceApp {...props()} />);
    await screen.findByText('课堂笔记');

    fireEvent.click(screen.getByRole('button', { name: '文件浏览器' }));
    const workspace = document.querySelector('[data-wb-notes-workspace]');
    expect(workspace).toHaveAttribute('data-explorer-open', 'false');
    expect(document.querySelector('[data-notes-explorer]')).toHaveAttribute('aria-hidden', 'true');
  });

  it('selects the closing tab neighbor and supports automatic keyboard tab navigation', async () => {
    render(<NotesWorkspaceApp {...props({ launchPayload: { resourceType: 'note', resourceId: 'note_1' } })} />);
    await screen.findByTestId('note-editor-note_1');
    fireEvent.click(await screen.findByText('章节导图'));

    const noteTab = screen.getByRole('tab', { name: /未命名笔记|课堂笔记/ });
    const mindmapTab = screen.getByRole('tab', { name: /章节导图/ });
    expect(mindmapTab).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(mindmapTab, { key: 'ArrowLeft' });
    expect(noteTab).toHaveAttribute('aria-selected', 'true');

    fireEvent.click(screen.getByRole('button', { name: /关闭 (未命名笔记|课堂笔记)/ }));
    expect(screen.getByRole('tab', { name: /章节导图/ })).toHaveAttribute('aria-selected', 'true');
  });

  it('guards dirty tabs and maps Cmd+W to the active internal tab', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<NotesWorkspaceApp {...props({ launchPayload: { resourceType: 'note', resourceId: 'note_1' } })} />);
    await screen.findByTestId('note-editor-note_1');
    const unregister = registerContentDirtyChecker('note', 'note_1', () => true);

    fireEvent.keyDown(window, { key: 'w', metaKey: true });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('tab', { name: /未命名笔记|课堂笔记/ })).toBeInTheDocument();

    confirm.mockReturnValue(true);
    fireEvent.keyDown(window, { key: 'w', metaKey: true });
    expect(screen.queryByRole('tab', { name: /未命名笔记|课堂笔记/ })).toBeNull();
    unregister();
  });

  it('exposes distinct retry and empty-search states in the explorer', async () => {
    vi.mocked(dstu.list).mockResolvedValueOnce({
      ok: false,
      error: { toUserMessage: () => '读取失败' },
    } as never);
    render(<NotesWorkspaceApp {...props()} />);

    expect(await screen.findByText('文件列表加载失败')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    await screen.findByText('课堂笔记');

    fireEvent.change(screen.getByRole('textbox', { name: '搜索文件' }), { target: { value: '不存在' } });
    expect(screen.getByText('没有匹配“不存在”的文件')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '显示全部文件' }));
    expect(screen.getByText('课堂笔记')).toBeInTheDocument();
  });

  it('closes a clean tab with the standard middle-click gesture', async () => {
    render(<NotesWorkspaceApp {...props({ launchPayload: { resourceType: 'note', resourceId: 'note_1' } })} />);
    await screen.findByTestId('note-editor-note_1');

    const tab = screen.getByRole('tab', { name: /未命名笔记|课堂笔记/ });
    fireEvent(tab.parentElement as HTMLElement, new MouseEvent('auxclick', { bubbles: true, button: 1 }));

    expect(screen.queryByRole('tab', { name: /未命名笔记|课堂笔记/ })).toBeNull();
  });
});
