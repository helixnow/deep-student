import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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

const extraNotes = [
  {
    id: 'note_2', sourceId: 'note_2', path: '/course/note_2', name: '第二笔记', type: 'note',
    createdAt: 3, updatedAt: 3,
  },
  {
    id: 'note_3', sourceId: 'note_3', path: '/course/note_3', name: '第三笔记', type: 'note',
    createdAt: 4, updatedAt: 4,
  },
] as const;

const panelProps: Array<Record<string, unknown>> = [];
const mindmapProps: Array<Record<string, unknown>> = [];

const { folderApi, trashApi, search, getContent } = vi.hoisted(() => ({
  folderApi: {
    listFolders: vi.fn(async () => ({ ok: true, value: [] })),
    createFolder: vi.fn(async () => ({ ok: true, value: { id: 'fld_new' } })),
    renameFolder: vi.fn(async () => ({ ok: true, value: undefined })),
    deleteFolder: vi.fn(async () => ({ ok: true, value: undefined })),
    moveItem: vi.fn(async () => ({ ok: true, value: undefined })),
    moveFolder: vi.fn(async () => ({ ok: true, value: undefined })),
    getFolderTree: vi.fn(async () => ({ ok: true, value: [] })),
  },
  trashApi: {
    listTrash: vi.fn(async () => ({ ok: true, value: [] })),
    restoreItem: vi.fn(async () => ({ ok: true, value: undefined })),
  },
  search: vi.fn(async () => ({ ok: true, value: [] })),
  getContent: vi.fn(async () => ({ ok: true, value: '' })),
}));

const watchState = vi.hoisted(() => ({
  callback: null as ((event: { type: string; path: string; node?: typeof nodes[number] }) => void) | null,
}));

vi.mock('@/dstu', () => ({
  dstu: {
    list: vi.fn(async () => ({ ok: true, value: nodes })),
    watch: vi.fn((_path: string, callback: typeof watchState.callback) => {
      watchState.callback = callback;
      return () => undefined;
    }),
    rename: vi.fn(async () => ({ ok: true, value: nodes[0] })),
    delete: vi.fn(async () => ({ ok: true, value: undefined })),
    search,
    getContent,
  },
  createEmpty: vi.fn(),
  folderApi,
  trashApi,
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
import { DSTU_FOLDER_CHANGE_EVENT } from '@/dstu/folderEvents';
import { registerContentCloseConfirmationHandler } from '../../content/ContentCloseConfirmation';
import { __resetContentDirtyRegistry, registerContentDirtyChecker } from '../../content/contentDirtyRegistry';
import { requestWorkspaceResource, resetWorkspaceRegistryForTests } from '../workspaceRegistry';
import { NotesWorkspaceApp } from '../NotesWorkspaceApp';
import {
  NOTES_WORKSPACE_COMMAND_EVENT,
  type NotesWorkspaceCommandAction,
  type NotesWorkspaceCommandDetail,
} from '@/command-palette/modules/notes.commands';

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

function dispatchWorkspaceCommand(action: NotesWorkspaceCommandAction): void {
  act(() => {
    window.dispatchEvent(new CustomEvent<NotesWorkspaceCommandDetail>(NOTES_WORKSPACE_COMMAND_EVENT, {
      detail: { action },
    }));
  });
}

function mockLibraryWithThreeNotes(): void {
  vi.mocked(dstu.list).mockImplementation((_path, options) => Promise.resolve({
    ok: true,
    value: options?.typeFilter === 'mindmap' ? [nodes[1]] : [nodes[0], ...extraNotes],
  } as never));
}

async function openThreeWorkspaceTabs(): Promise<void> {
  mockLibraryWithThreeNotes();
  render(<NotesWorkspaceApp {...props({ launchPayload: { resourceType: 'note', resourceId: 'note_1' } })} />);
  await screen.findByTestId('note-editor-note_1');
  fireEvent.click(await screen.findByRole('treeitem', { name: '第二笔记' }));
  await screen.findByTestId('note-editor-note_2');
  fireEvent.click(await screen.findByRole('treeitem', { name: '第三笔记' }));
  await screen.findByTestId('note-editor-note_3');
}

describe('NotesWorkspaceApp', () => {
  beforeEach(() => {
    panelProps.length = 0;
    mindmapProps.length = 0;
    resetWorkspaceRegistryForTests();
    __resetContentDirtyRegistry();
    window.localStorage.clear();
    vi.mocked(dstu.list).mockReset();
    vi.mocked(dstu.list).mockResolvedValue({ ok: true, value: nodes } as never);
    vi.mocked(folderApi.listFolders).mockResolvedValue({ ok: true, value: [] });
    vi.mocked(folderApi.getFolderTree).mockResolvedValue({ ok: true, value: [] });
    vi.mocked(trashApi.listTrash).mockResolvedValue({ ok: true, value: [] });
    search.mockReset();
    search.mockResolvedValue({ ok: true, value: [] });
    getContent.mockReset();
    getContent.mockResolvedValue({ ok: true, value: '' });
    watchState.callback = null;
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
    expect(mindmapProps.at(-1)?.focusOnActive).toBe(true);
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

    fireEvent.click(screen.getByRole('button', { name: /文件浏览器|File explorer/ }));
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

    fireEvent.click(noteTab.parentElement?.querySelector<HTMLButtonElement>('.notes-icon-button') as HTMLButtonElement);
    expect(screen.getByRole('tab', { name: /章节导图/ })).toHaveAttribute('aria-selected', 'true');
  });

  it('reorders tabs by drag-and-drop without changing the active resource', async () => {
    await openThreeWorkspaceTabs();
    const firstTab = screen.getByRole('tab', { name: '课堂笔记' });
    const thirdTab = screen.getByRole('tab', { name: '第三笔记' });
    const firstTabItem = firstTab.parentElement as HTMLElement;
    const thirdTabItem = thirdTab.parentElement as HTMLElement;
    const dataTransfer = {
      effectAllowed: '',
      dropEffect: '',
      setData: vi.fn(),
    };
    vi.spyOn(firstTabItem, 'getBoundingClientRect').mockReturnValue({
      bottom: 40, height: 40, left: 100, right: 280, top: 0, width: 180, x: 100, y: 0,
      toJSON: () => ({}),
    });

    fireEvent.dragStart(thirdTabItem, { dataTransfer });
    fireEvent.dragOver(firstTabItem, { clientX: 101, dataTransfer });
    fireEvent.drop(firstTabItem, { clientX: 101, dataTransfer });

    await waitFor(() => {
      expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['第三笔记', '课堂笔记', '第二笔记']);
      expect(screen.getByRole('tab', { name: '第三笔记' })).toHaveAttribute('aria-selected', 'true');
    });
  });

  it('pins a tab persistently and leaves it open when closing other tabs from the context menu', async () => {
    await openThreeWorkspaceTabs();
    const firstTab = screen.getByRole('tab', { name: '课堂笔记' });
    const secondTab = screen.getByRole('tab', { name: '第二笔记' });

    fireEvent.contextMenu(secondTab);
    const pinAction = within(screen.getByRole('menu')).getByRole('menuitemcheckbox', { name: /固定|Pin/ });
    expect(pinAction).toHaveTextContent('第二笔记');
    fireEvent.click(pinAction);
    expect(secondTab.parentElement).toHaveAttribute('data-pinned', 'true');
    expect(secondTab.getAttribute('aria-description')).toMatch(/已固定|Pinned/);
    await waitFor(() => {
      const persisted = JSON.parse(window.localStorage.getItem('workbench.notesWorkspace.state.v1') ?? '{}');
      expect(persisted.tabs.find((tab: { key: string }) => tab.key === 'note:note_2')?.pinned).toBe(true);
    });

    fireEvent.contextMenu(firstTab);
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: /关闭其他|Close other tabs/ }));

    await waitFor(() => {
      expect(screen.getByRole('tab', { name: '课堂笔记' })).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: '第二笔记' })).toBeInTheDocument();
      expect(screen.queryByRole('tab', { name: '第三笔记' })).toBeNull();
    });
  });

  it('closes only unpinned tabs to the right from the tab context menu', async () => {
    await openThreeWorkspaceTabs();
    const firstTab = screen.getByRole('tab', { name: '课堂笔记' });
    const secondTab = screen.getByRole('tab', { name: '第二笔记' });

    fireEvent.contextMenu(secondTab);
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitemcheckbox', { name: /固定|Pin/ }));
    expect(secondTab.parentElement).toHaveAttribute('data-pinned', 'true');

    fireEvent.contextMenu(firstTab);
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: /关闭右侧|Close tabs to the right/ }));

    await waitFor(() => {
      expect(screen.getByRole('tab', { name: '课堂笔记' })).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: '第二笔记' })).toBeInTheDocument();
      expect(screen.queryByRole('tab', { name: '第三笔记' })).toBeNull();
    });
  });

  it('opens tab actions from the keyboard and dismisses a stale menu when another tab is selected', async () => {
    await openThreeWorkspaceTabs();
    const firstTab = screen.getByRole('tab', { name: '课堂笔记' });
    const secondTab = screen.getByRole('tab', { name: '第二笔记' });

    firstTab.focus();
    fireEvent.keyDown(firstTab, { key: 'F10', shiftKey: true });
    const menu = await screen.findByRole('menu');
    expect(firstTab).toHaveAttribute('aria-expanded', 'true');
    await waitFor(() => expect(within(menu).getByRole('menuitemcheckbox')).toHaveFocus());

    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByRole('menu')).toBeNull();
      expect(firstTab).toHaveFocus();
    });

    fireEvent.contextMenu(firstTab);
    await screen.findByRole('menu');
    secondTab.focus();
    fireEvent.click(secondTab);
    await waitFor(() => {
      expect(screen.queryByRole('menu')).toBeNull();
      expect(secondTab).toHaveAttribute('aria-selected', 'true');
      expect(secondTab).toHaveFocus();
    });
  });

  it('stops closing other tabs when the first dirty-tab confirmation is cancelled', async () => {
    const requestConfirmation = vi.fn(async () => false);
    const unregisterConfirmation = registerContentCloseConfirmationHandler(requestConfirmation);
    const unregisterSecond = registerContentDirtyChecker('note', 'note_2', () => true);
    const unregisterThird = registerContentDirtyChecker('note', 'note_3', () => true);

    try {
      await openThreeWorkspaceTabs();
      fireEvent.contextMenu(screen.getByRole('tab', { name: '课堂笔记' }));
      fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: /关闭其他|Close other tabs/ }));

      await waitFor(() => expect(requestConfirmation).toHaveBeenCalledTimes(1));
      expect(screen.getByRole('tab', { name: /^第二笔记/ })).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: /^第三笔记/ })).toBeInTheDocument();
    } finally {
      unregisterSecond();
      unregisterThird();
      unregisterConfirmation();
    }
  });

  it('collapses the split after closing all main tabs from the right-tab menu', async () => {
    await openThreeWorkspaceTabs();
    const secondTab = screen.getByRole('tab', { name: '第二笔记' });
    fireEvent.click(within(secondTab.parentElement as HTMLElement)
      .getByRole('button', { name: /Open .* right split/ }));
    await waitFor(() => expect(document.querySelectorAll('[data-notes-pane]')).toHaveLength(2));

    fireEvent.contextMenu(secondTab);
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: /关闭其他|Close other tabs/ }));

    await waitFor(() => {
      expect(screen.getAllByRole('tab')).toHaveLength(1);
      expect(screen.getByRole('tab', { name: '第二笔记' })).toBeInTheDocument();
      expect(document.querySelectorAll('[data-notes-pane]')).toHaveLength(1);
    });
  });

  it('guards dirty tabs through the Workbench confirmation layer and maps Cmd+W to the active tab', async () => {
    let allowClose = false;
    const requestConfirmation = vi.fn(async () => allowClose);
    const unregisterConfirmation = registerContentCloseConfirmationHandler(requestConfirmation);
    const nativeConfirm = vi.spyOn(window, 'confirm');
    render(<NotesWorkspaceApp {...props({ launchPayload: { resourceType: 'note', resourceId: 'note_1' } })} />);
    await screen.findByTestId('note-editor-note_1');
    const unregister = registerContentDirtyChecker('note', 'note_1', () => true);

    try {
      fireEvent.keyDown(window, { key: 'w', metaKey: true });
      await waitFor(() => expect(requestConfirmation).toHaveBeenCalledTimes(1));
      expect(nativeConfirm).not.toHaveBeenCalled();
      expect(screen.getByRole('tab', { name: /未命名笔记|课堂笔记/ })).toBeInTheDocument();

      allowClose = true;
      fireEvent.keyDown(window, { key: 'w', metaKey: true });
      await waitFor(() => {
        expect(requestConfirmation).toHaveBeenCalledTimes(2);
        expect(screen.queryByRole('tab', { name: /未命名笔记|课堂笔记/ })).toBeNull();
      });
    } finally {
      unregister();
      unregisterConfirmation();
      nativeConfirm.mockRestore();
    }
  });

  it('force-closes a dirty tab after the user confirms moving its resource to trash', async () => {
    const requestConfirmation = vi.fn(async () => false);
    const unregisterConfirmation = registerContentCloseConfirmationHandler(requestConfirmation);
    render(<NotesWorkspaceApp {...props({ launchPayload: { resourceType: 'note', resourceId: 'note_1' } })} />);
    await screen.findByTestId('note-editor-note_1');
    const unregister = registerContentDirtyChecker('note', 'note_1', () => true);

    try {
      fireEvent.contextMenu(screen.getByRole('treeitem', { name: '课堂笔记' }));
      fireEvent.click(screen.getByRole('menuitem', { name: /删除|Delete/ }));
      const dialog = await screen.findByRole('dialog', { name: /移到回收站|Move to trash/ });
      fireEvent.click(within(dialog).getByRole('button', { name: /删除|Delete/ }));

      await waitFor(() => {
        expect(dstu.delete).toHaveBeenCalledWith('/course/note_1');
        expect(screen.queryByRole('tab', { name: /未命名笔记|课堂笔记/ })).toBeNull();
      });
      expect(requestConfirmation).not.toHaveBeenCalled();
    } finally {
      unregister();
      unregisterConfirmation();
    }
  });

  it('consumes Ctrl+W when the workspace has no active tab', async () => {
    render(<NotesWorkspaceApp {...props()} />);
    await screen.findByText('课堂笔记');

    const event = new KeyboardEvent('keydown', {
      key: 'w',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    act(() => window.dispatchEvent(event));

    expect(event.defaultPrevented).toBe(true);
    expect(screen.queryByRole('tab')).toBeNull();
  });

  it('exposes distinct retry and empty-search states in the explorer', async () => {
    vi.mocked(dstu.list).mockResolvedValueOnce({
      ok: false,
      error: { toUserMessage: () => '读取失败' },
    } as never);
    render(<NotesWorkspaceApp {...props()} />);

    expect(await screen.findByText(/文件列表加载失败|Could not load files/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /重试|Retry/ }));
    await screen.findByText('课堂笔记');

    fireEvent.change(screen.getByRole('textbox', { name: /搜索文件|Search files/ }), { target: { value: '不存在' } });
    expect(screen.getByText(/没有匹配|No files match/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /显示全部文件|Show all files/ }));
    expect(screen.getByText('课堂笔记')).toBeInTheDocument();
  });

  it('closes a clean tab with the standard middle-click gesture', async () => {
    render(<NotesWorkspaceApp {...props({ launchPayload: { resourceType: 'note', resourceId: 'note_1' } })} />);
    await screen.findByTestId('note-editor-note_1');

    const tab = screen.getByRole('tab', { name: /未命名笔记|课堂笔记/ });
    fireEvent(tab.parentElement as HTMLElement, new MouseEvent('auxclick', { bubbles: true, button: 1 }));

    expect(screen.queryByRole('tab', { name: /未命名笔记|课堂笔记/ })).toBeNull();
  });

  it('keeps the single-tab workspace as one pane instead of opening an empty split', async () => {
    render(<NotesWorkspaceApp {...props({ launchPayload: { resourceType: 'note', resourceId: 'note_1' } })} />);
    await screen.findByTestId('note-editor-note_1');

    const tab = screen.getByRole('tab', { name: /未命名笔记|课堂笔记/ });
    expect(within(tab.parentElement as HTMLElement).getByRole('button', { name: /Open .* right split/ })).toBeDisabled();
    expect(document.querySelectorAll('[data-notes-pane]')).toHaveLength(1);
  });

  it('mounts a right-split tab once and routes active editor state to the focused pane', async () => {
    render(<NotesWorkspaceApp {...props({ launchPayload: { resourceType: 'note', resourceId: 'note_1' } })} />);
    await screen.findByTestId('note-editor-note_1');
    fireEvent.click(await screen.findByText('章节导图'));
    await screen.findByTestId('mindmap-editor-mindmap_1');

    const noteTab = screen.getByRole('tab', { name: /未命名笔记|课堂笔记/ });
    fireEvent.click(within(noteTab.parentElement as HTMLElement).getByRole('button', { name: /Open .* right split/ }));

    await waitFor(() => expect(document.querySelectorAll('[data-notes-pane]')).toHaveLength(2));
    const mainPane = document.querySelector('[data-notes-pane="main"]');
    const rightPane = document.querySelector('[data-notes-pane="right"]');
    expect(mainPane).toHaveAttribute('data-resource-id', 'mindmap_1');
    expect(rightPane).toHaveAttribute('data-resource-id', 'note_1');
    expect(screen.getAllByTestId('note-editor-note_1')).toHaveLength(1);
    expect([...panelProps].reverse().find((value) => value.resourceId === 'note_1')).toMatchObject({ isActive: true });
    expect([...mindmapProps].reverse().find((value) => value.resourceId === 'mindmap_1')).toMatchObject({ isActive: false });

    fireEvent.click(screen.getByRole('tab', { name: /章节导图/ }));
    await waitFor(() => {
      expect(mainPane).toHaveAttribute('data-resource-id', 'mindmap_1');
      expect([...panelProps].reverse().find((value) => value.resourceId === 'note_1')).toMatchObject({ isActive: false });
      expect([...mindmapProps].reverse().find((value) => value.resourceId === 'mindmap_1')).toMatchObject({ isActive: true });
    });

    const mindmapTab = screen.getByRole('tab', { name: /章节导图/ });
    fireEvent.click(within(mindmapTab.parentElement as HTMLElement).getByRole('button', { name: /关闭|Close/ }));
    await waitFor(() => {
      expect(document.querySelectorAll('[data-notes-pane]')).toHaveLength(1);
      expect(document.querySelector('[data-notes-pane="main"]')).toHaveAttribute('data-resource-id', 'note_1');
      expect(screen.getAllByTestId('note-editor-note_1')).toHaveLength(1);
    });
  });

  it('normalizes stale split state from workspace storage', async () => {
    window.localStorage.setItem('workbench.notesWorkspace.state.v1', JSON.stringify({
      tabs: [
        { key: 'note:note_1', type: 'note', id: 'note_1', title: '课堂笔记' },
        { key: 'mindmap:mindmap_1', type: 'mindmap', id: 'mindmap_1', title: '章节导图' },
      ],
      activeTabKey: 'note:note_1',
      rightTabKey: 'note:missing',
      focusedPane: 'right',
      splitLayout: [10, 90],
      explorerOpen: true,
      explorerWidth: 240,
      collapsedFolderPaths: [],
    }));

    render(<NotesWorkspaceApp {...props()} />);
    await screen.findByTestId('note-editor-note_1');

    expect(document.querySelectorAll('[data-notes-pane]')).toHaveLength(1);
    expect(document.querySelector('[data-notes-pane="main"]')).toHaveAttribute('data-resource-id', 'note_1');
    await waitFor(() => {
      const persisted = JSON.parse(window.localStorage.getItem('workbench.notesWorkspace.state.v1') ?? '{}');
      expect(persisted.rightTabKey).toBeNull();
      expect(persisted.focusedPane).toBe('main');
      expect(persisted.splitLayout).toEqual([50, 50]);
    });
  });

  it('patches content-only watch updates without replacing the tree or losing collapsed state', async () => {
    render(<NotesWorkspaceApp {...props()} />);
    await screen.findByText('课堂笔记');

    const tree = screen.getByRole('tree');
    const folder = screen.getByText('course').closest('button') as HTMLButtonElement;
    fireEvent.click(folder);
    expect(folder).toHaveAttribute('aria-expanded', 'false');
    tree.scrollTop = 36;
    const listCallsBeforeUpdate = vi.mocked(dstu.list).mock.calls.length;

    act(() => {
      watchState.callback?.({
        type: 'updated',
        path: '/course/note_1',
        node: { ...nodes[0], updatedAt: 2 },
      });
    });

    expect(vi.mocked(dstu.list)).toHaveBeenCalledTimes(listCallsBeforeUpdate);
    expect(folder).toHaveAttribute('aria-expanded', 'false');
    expect(tree.scrollTop).toBe(36);
    expect(screen.queryByLabelText(/正在读取文件|Loading files/)).toBeNull();
  });

  it('silently refreshes the tree when another surface changes folder structure', async () => {
    const externalFolder = {
      id: 'fld_external',
      parentId: null,
      title: 'External folder',
      isExpanded: true,
      sortOrder: 0,
      createdAt: 1,
      updatedAt: 1,
    };
    render(<NotesWorkspaceApp {...props()} />);
    await screen.findByText('课堂笔记');
    const tree = screen.getByRole('tree');
    const courseFolder = screen.getByText('course').closest('button') as HTMLButtonElement;
    fireEvent.click(courseFolder);
    expect(courseFolder).toHaveAttribute('aria-expanded', 'false');
    tree.scrollTop = 24;
    const listCallsBeforeEvent = vi.mocked(dstu.list).mock.calls.length;

    vi.mocked(folderApi.listFolders).mockResolvedValue({ ok: true, value: [externalFolder] });
    vi.mocked(folderApi.getFolderTree).mockResolvedValue({
      ok: true,
      value: [{ folder: externalFolder, items: [], children: [] }],
    });
    act(() => window.dispatchEvent(new Event(DSTU_FOLDER_CHANGE_EVENT)));

    expect(screen.queryByLabelText(/正在读取文件|Loading files/)).toBeNull();
    expect(await screen.findByRole('treeitem', { name: /External folder/ })).toBeInTheDocument();
    expect(vi.mocked(dstu.list)).toHaveBeenCalledTimes(listCallsBeforeEvent + 2);
    expect(courseFolder).toHaveAttribute('aria-expanded', 'false');
    expect(tree.scrollTop).toBe(24);
    expect(tree).toHaveAttribute('aria-busy', 'false');
  });

  it('keeps the icon-button base class when opening the compact explorer handle', async () => {
    render(<NotesWorkspaceApp {...props()} />);
    await screen.findByText('课堂笔记');

    fireEvent.click(screen.getByRole('button', { name: /文件浏览器|File explorer/ }));
    expect(document.querySelector('.notes-explorer-handle')).toHaveClass('notes-icon-button');
  });

  it('closes an unchanged rename on Enter and validates an empty rename inline', async () => {
    render(<NotesWorkspaceApp {...props()} />);
    const resource = await screen.findByText('课堂笔记');

    fireEvent.contextMenu(resource);
    fireEvent.click(screen.getByRole('menuitem', { name: /重命名|Rename/ }));
    const input = screen.getByRole('textbox', { name: /名称|Name/ });
    expect(input).toHaveFocus();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.contextMenu(resource);
    fireEvent.click(screen.getByRole('menuitem', { name: /重命名|Rename/ }));
    const retryInput = screen.getByRole('textbox', { name: /名称|Name/ });
    fireEvent.change(retryInput, { target: { value: '' } });
    fireEvent.keyDown(retryInput, { key: 'Enter' });
    expect(screen.getByRole('alert')).toHaveTextContent(/请输入名称|Enter a name/);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('bridges workbench note commands to workspace actions without routing to Learning Hub', async () => {
    const { createEmpty } = await import('@/dstu');
    vi.mocked(createEmpty).mockResolvedValueOnce({ ok: true, value: nodes[0] } as never);
    render(<NotesWorkspaceApp {...props()} />);
    await screen.findByText('课堂笔记');

    act(() => {
      window.dispatchEvent(new CustomEvent(NOTES_WORKSPACE_COMMAND_EVENT, {
        detail: { action: 'create-note' },
      }));
    });

    await waitFor(() => expect(createEmpty).toHaveBeenCalledWith({ type: 'note', folderId: undefined }));
  });

  it('opens the quick switcher from a workspace command and opens its selected resource', async () => {
    render(<NotesWorkspaceApp {...props()} />);
    await screen.findByText('课堂笔记');

    dispatchWorkspaceCommand('quick-switch');

    const dialog = await screen.findByRole('dialog', { name: /Search notes|搜索笔记/ });
    expect(within(dialog).getByRole('button', { name: /Quick open|快速切换/ })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(within(dialog).getByRole('option', { name: /课堂笔记/ }));

    expect(await screen.findByTestId('note-editor-note_1')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: /Search notes|搜索笔记/ })).toBeNull();
    });
  });

  it('opens full-text search from a workspace command and queries DSTU content', async () => {
    search.mockResolvedValue({
      ok: true,
      value: [{ ...nodes[0], name: '匹配笔记', metadata: { snippet: '命中 <b>内容</b>' } }],
    });
    render(<NotesWorkspaceApp {...props()} />);
    await screen.findByText('课堂笔记');

    dispatchWorkspaceCommand('search-content');

    const dialog = await screen.findByRole('dialog', { name: /Search notes|搜索笔记/ });
    expect(within(dialog).getByRole('button', { name: /Search content|搜索内容/ })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.change(within(dialog).getByRole('combobox'), { target: { value: '内容' } });

    await waitFor(() => expect(search).toHaveBeenCalledWith('内容', expect.objectContaining({
      types: ['note', 'mindmap'],
    })));
    expect(await within(dialog).findByRole('option', { name: /匹配笔记/ })).toBeInTheDocument();
  });

  it('toggles the backlinks panel from a workspace command', async () => {
    render(<NotesWorkspaceApp {...props({ launchPayload: { resourceType: 'note', resourceId: 'note_1' } })} />);
    await screen.findByTestId('note-editor-note_1');

    dispatchWorkspaceCommand('toggle-backlinks');

    expect(await screen.findByRole('complementary', { name: /Linked notes|Links|关联笔记/ })).toBeInTheDocument();
    await waitFor(() => expect(getContent).toHaveBeenCalledWith('/course/note_1'));

    dispatchWorkspaceCommand('toggle-backlinks');
    expect(screen.queryByRole('complementary', { name: /Linked notes|Links|关联笔记/ })).toBeNull();
  });

  it('opens full-text search through the ribbon search control', async () => {
    render(<NotesWorkspaceApp {...props()} />);
    await screen.findByText('课堂笔记');

    fireEvent.click(screen.getByRole('button', { name: /Search notes|搜索笔记/ }));

    const dialog = await screen.findByRole('dialog', { name: /Search notes|搜索笔记/ });
    expect(within(dialog).getByRole('button', { name: /Search content|搜索内容/ })).toHaveAttribute('aria-pressed', 'true');
  });

  it('opens the backlinks panel through the ribbon link control', async () => {
    render(<NotesWorkspaceApp {...props({ launchPayload: { resourceType: 'note', resourceId: 'note_1' } })} />);
    await screen.findByTestId('note-editor-note_1');

    fireEvent.click(screen.getByRole('button', { name: /Linked notes|关联笔记/ }));

    expect(await screen.findByRole('complementary', { name: /Linked notes|Links|关联笔记/ })).toBeInTheDocument();
    await waitFor(() => expect(getContent).toHaveBeenCalledWith('/course/note_1'));
  });

  it('offers an in-workspace trash restore path', async () => {
    vi.mocked(trashApi.listTrash).mockResolvedValueOnce({ ok: true, value: [nodes[0]] } as never);
    render(<NotesWorkspaceApp {...props()} />);
    await screen.findByText('课堂笔记');

    fireEvent.click(screen.getByRole('button', { name: /回收站|Trash/ }));
    expect(await screen.findByRole('dialog', { name: /回收站|Trash/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /恢复|Restore/ }));
    await waitFor(() => expect(trashApi.restoreItem).toHaveBeenCalledWith('note_1', 'note'));
  });

  it('lists and restores folders from the workspace trash', async () => {
    const deletedFolder = {
      id: 'fld_archived', sourceId: 'fld_archived', path: '/_trash/fld_archived', name: 'Archived', type: 'folder',
      createdAt: 1, updatedAt: 1,
    } as const;
    vi.mocked(trashApi.listTrash).mockResolvedValueOnce({ ok: true, value: [deletedFolder] } as never);
    render(<NotesWorkspaceApp {...props()} />);
    await screen.findByText('课堂笔记');

    fireEvent.click(screen.getByRole('button', { name: /回收站|Trash/ }));
    expect(await screen.findByText('Archived')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /恢复 Archived|Restore Archived/ }));
    await waitFor(() => expect(trashApi.restoreItem).toHaveBeenCalledWith('fld_archived', 'folder'));
  });

  it('keeps the trash dialog keyboard-contained and closes it with Escape', async () => {
    render(<NotesWorkspaceApp {...props()} />);
    await screen.findByText('课堂笔记');
    const trigger = screen.getByRole('button', { name: /回收站|Trash/ });

    trigger.focus();
    fireEvent.click(trigger);
    const dialog = await screen.findByRole('dialog', { name: /回收站|Trash/ });
    const close = within(dialog).getByRole('button', { name: /关闭回收站|Close trash/ });
    await waitFor(() => expect(close).toHaveFocus());
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /回收站|Trash/ })).toBeNull());
    expect(trigger).toHaveFocus();
  });

  it('moves a resource back to the library root through the root drop target', async () => {
    render(<NotesWorkspaceApp {...props()} />);
    const note = await screen.findByRole('treeitem', { name: '课堂笔记' });
    const root = screen.getByRole('treeitem', { name: /根目录|Library root/ });
    const dataTransfer = {
      effectAllowed: '',
      dropEffect: '',
      setData: vi.fn(),
    };

    fireEvent.dragStart(note, { dataTransfer });
    fireEvent.dragOver(root, { dataTransfer });
    fireEvent.drop(root, { dataTransfer });

    await waitFor(() => expect(folderApi.moveItem).toHaveBeenCalledWith('note', 'note_1', undefined));
  });

  it('includes the library root in tree semantics and keyboard navigation', async () => {
    render(<NotesWorkspaceApp {...props()} />);
    await screen.findByText('课堂笔记');

    const tree = screen.getByRole('tree');
    const root = within(tree).getByRole('treeitem', { name: /根目录|Library root/ });
    const folder = screen.getByText('course').closest('[role="treeitem"]') as HTMLElement;

    expect(root).toHaveAttribute('aria-level', '1');
    expect(folder).toHaveAttribute('aria-level', '2');

    root.focus();
    fireEvent.keyDown(root, { key: 'ArrowDown' });
    expect(folder).toHaveFocus();

    fireEvent.keyDown(folder, { key: 'ArrowLeft' });
    expect(folder).toHaveAttribute('aria-expanded', 'false');
    fireEvent.keyDown(folder, { key: 'ArrowLeft' });
    expect(root).toHaveFocus();
  });

  it('finishes the initial loading state when a silent refresh supersedes it', async () => {
    let resolveInitialNotes!: (value: unknown) => void;
    let resolveInitialMindmaps!: (value: unknown) => void;
    let resolveRefreshNotes!: (value: unknown) => void;
    let resolveRefreshMindmaps!: (value: unknown) => void;
    const pending = [
      new Promise((resolve) => { resolveInitialNotes = resolve; }),
      new Promise((resolve) => { resolveInitialMindmaps = resolve; }),
      new Promise((resolve) => { resolveRefreshNotes = resolve; }),
      new Promise((resolve) => { resolveRefreshMindmaps = resolve; }),
    ];
    vi.mocked(dstu.list).mockImplementation(() => pending.shift() as never);

    render(<NotesWorkspaceApp {...props()} />);
    await waitFor(() => expect(dstu.list).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole('button', { name: /刷新|Refresh/ }));
    await waitFor(() => expect(dstu.list).toHaveBeenCalledTimes(4));

    await act(async () => {
      resolveRefreshNotes({ ok: true, value: [] });
      resolveRefreshMindmaps({ ok: true, value: [] });
    });
    expect(await screen.findByText(/知识库中还没有文件|No files in this library yet/)).toBeInTheDocument();
    expect(screen.getByRole('tree')).toHaveAttribute('aria-busy', 'false');

    await act(async () => {
      resolveInitialNotes({ ok: true, value: [] });
      resolveInitialMindmaps({ ok: true, value: [] });
    });
  });

  it('makes a closed compact explorer inert until it is reopened', async () => {
    let onResize: ((entries: ResizeObserverEntry[]) => void) | undefined;
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: (entries: ResizeObserverEntry[]) => void) {
        onResize = callback;
      }
      observe() {}
      disconnect() {}
    });
    render(<NotesWorkspaceApp {...props()} />);
    await screen.findByText('课堂笔记');
    act(() => onResize?.([{ contentRect: { width: 600 } } as ResizeObserverEntry]));

    fireEvent.click(screen.getByRole('button', { name: /文件浏览器|File explorer/ }));
    const explorer = document.querySelector<HTMLElement>('[data-notes-explorer]')!;
    await waitFor(() => expect(explorer).toHaveAttribute('inert', ''));

    fireEvent.click(screen.getByRole('button', { name: /打开文件浏览器|Open file explorer/ }));
    await waitFor(() => expect(explorer).not.toHaveAttribute('inert'));
  });
});
