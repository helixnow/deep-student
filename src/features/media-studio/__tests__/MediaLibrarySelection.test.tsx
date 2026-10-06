/**
 * 音视频库多选与分组：选择模式（点行切换勾选、Esc 退出）、全选只作用于可见条目、
 * 批量删除逐个走 dstu.delete 并保留失败项、按分组视图（未分组在最后、收起记忆）、
 * 移动到分组 / 新建分组（预填公共标题前缀）/ 移出分组。
 */
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options && 'count' in options ? `${key}:${String(options.count)}` : key,
    i18n: { language: 'zh-CN', resolvedLanguage: 'zh-CN' },
  }),
}));
vi.mock('@/components/shared/UnifiedDragDropZone', () => ({
  FILE_TYPES: { AUDIO: {}, VIDEO: {} },
  UnifiedDragDropZone: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
const dstuMocks = vi.hoisted(() => ({
  delete: vi.fn(),
  rename: vi.fn(),
  moveItem: vi.fn(),
  createFolder: vi.fn(),
  updatePathCacheV2: vi.fn(),
}));
vi.mock('@/dstu', () => ({
  dstu: { rename: dstuMocks.rename, delete: dstuMocks.delete },
  folderApi: { moveItem: dstuMocks.moveItem, createFolder: dstuMocks.createFolder },
}));
vi.mock('@/features/chat/context/vfsRefApi', () => ({ updatePathCacheV2: dstuMocks.updatePathCacheV2 }));
vi.mock('@/components/UnifiedNotification', () => ({ showGlobalNotification: vi.fn() }));

import type { MediaLibraryItem } from '../api';
import type { MediaLibraryState } from '../useMediaLibrary';
import type { MediaImportController } from '../useMediaImport';
import {
  MEDIA_LIBRARY_COLLAPSED_KEY,
  MEDIA_LIBRARY_VIEW_KEY,
  MediaLibraryPage,
} from '../components/MediaLibraryPage';

const T0 = Date.now() - 3_600_000;

function item(id: string, over: Partial<MediaLibraryItem> = {}): MediaLibraryItem {
  return {
    id,
    name: `${id}.mp4`,
    kind: 'video',
    mimeType: 'video/mp4',
    isLink: false,
    coverUrl: null,
    size: 1,
    folderId: null,
    folderName: null,
    folderPath: [],
    createdAt: T0,
    updatedAt: T0,
    durationMs: 600_000,
    transcript: { status: 'none', completedSegments: 0, totalSegments: 0, failedSegments: 0, source: null },
    progress: { lastPositionMs: 0, watchedMs: 0, finished: false },
    lastWatchedAt: null,
    handoutCount: 0,
    ...over,
  };
}

const done = { status: 'completed', completedSegments: 3, totalSegments: 3, failedSegments: 0, source: 'asr' } as const;

function library(items: MediaLibraryItem[]): MediaLibraryState {
  return { items, loading: false, loaded: true, error: null, refresh: vi.fn(async () => undefined), removeLocal: vi.fn() };
}

const importer: MediaImportController = {
  importing: false,
  progress: null,
  pick: vi.fn(),
  importSources: vi.fn(async () => undefined),
  inputRef: { current: null },
  onInputChange: vi.fn(),
  usesFileInput: false,
};

const ok = <T,>(value: T) => ({ ok: true as const, value });
const fail = (message: string) => ({ ok: false as const, error: { toUserMessage: () => message } });

function renderPage(items: MediaLibraryItem[], onOpen = vi.fn(), isSmallScreen = false) {
  const lib = library(items);
  render(
    <MediaLibraryPage library={lib} importer={importer} onOpen={onOpen} isSmallScreen={isSmallScreen} titlebarTarget={null} />,
  );
  return lib;
}

const rowIds = () => Array.from(document.querySelectorAll('[data-media-row]')).map((el) => el.getAttribute('data-media-row'));
const countText = () => document.querySelector('[data-media-select-count]')?.textContent;
const enterSelect = () => fireEvent.click(document.querySelector('[data-media-select-toggle]') as HTMLElement);

beforeEach(() => {
  window.localStorage.clear();
  Object.values(dstuMocks).forEach((fn) => fn.mockReset());
  dstuMocks.updatePathCacheV2.mockResolvedValue(ok(1));
});
afterEach(() => cleanup());

describe('MediaLibraryPage select mode', () => {
  it('row click toggles selection instead of opening; Esc leaves select mode', () => {
    const onOpen = vi.fn();
    renderPage([item('a'), item('b')], onOpen);
    expect(document.querySelector('[data-media-select-bar]')).toBeNull();

    enterSelect();
    expect(document.querySelector('[data-media-select-bar]')).toBeTruthy();
    const boxes = screen.getAllByRole('checkbox', { name: 'mediaStudio:select.row' });
    expect(boxes).toHaveLength(2);
    // ⋯ 菜单在多选时隐藏
    expect(screen.queryByRole('button', { name: 'mediaStudio:row.more' })).toBeNull();

    fireEvent.click(boxes[0]);
    expect(onOpen).not.toHaveBeenCalled();
    expect(boxes[0].getAttribute('aria-checked')).toBe('true');
    expect(countText()).toBe('mediaStudio:select.count:1');
    fireEvent.click(boxes[0]);
    expect(countText()).toBe('mediaStudio:select.count:0');

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(document.querySelector('[data-media-select-bar]')).toBeNull();
    fireEvent.click(screen.getAllByRole('button', { name: 'mediaStudio:row.open' })[0]);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('select-all covers only the filtered + searched items, and toggles to deselect-all', () => {
    renderPage([
      item('t1', { name: '高数 1.mp4', transcript: done }),
      item('t2', { name: '线代 1.mp4', transcript: done }),
      item('u1', { name: '高数 2.mp4' }),
    ]);
    enterSelect();
    fireEvent.click(screen.getByRole('radio', { name: /mediaStudio:filter.transcribed/ }));
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: '高数' } });
    expect(rowIds()).toEqual(['t1']);

    fireEvent.click(screen.getByRole('button', { name: 'mediaStudio:select.selectAll' }));
    expect(countText()).toBe('mediaStudio:select.count:1');
    fireEvent.click(screen.getByRole('button', { name: 'mediaStudio:select.deselectAll' }));
    expect(countText()).toBe('mediaStudio:select.count:0');

    // 放宽筛选后全选覆盖全部可见
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('radio', { name: /mediaStudio:filter.all/ }));
    fireEvent.click(screen.getByRole('button', { name: 'mediaStudio:select.selectAll' }));
    expect(countText()).toBe('mediaStudio:select.count:3');
  });

  it('batch delete confirms, deletes sequentially through dstu and keeps failures selected', async () => {
    dstuMocks.delete.mockImplementation(async (path: string) => (path === '/b' ? fail('locked') : ok(undefined)));
    const lib = renderPage([item('a'), item('b'), item('c')]);
    enterSelect();
    fireEvent.click(screen.getByRole('button', { name: 'mediaStudio:select.selectAll' }));
    fireEvent.click(document.querySelector('[data-media-select-delete]') as HTMLElement);

    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('mediaStudio:select.deleteTitle:3')).toBeTruthy();
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'mediaStudio:row.delete' }));
    });

    await waitFor(() => expect(dstuMocks.delete).toHaveBeenCalledTimes(3));
    expect(dstuMocks.delete.mock.calls.map((call) => call[0])).toEqual(['/a', '/b', '/c']);
    expect(lib.removeLocal).toHaveBeenCalledWith('a');
    expect(lib.removeLocal).toHaveBeenCalledWith('c');
    expect(lib.removeLocal).not.toHaveBeenCalledWith('b');
    // 仍在多选，只剩失败项被选中（removeLocal 是 mock，列表不变）
    await waitFor(() => expect(countText()).toBe('mediaStudio:select.count:1'));
    expect(screen.getAllByRole('checkbox', { name: 'mediaStudio:select.row' }).map((el) => el.getAttribute('aria-checked')))
      .toEqual(['false', 'true', 'false']);
  });
});

describe('MediaLibraryPage grouped view', () => {
  const grouped = [
    item('loose'),
    item('c10', { folderId: 'fld_10', folderName: '第 10 章', folderPath: ['第 10 章'], transcript: done }),
    item('c2', { folderId: 'fld_2', folderName: '第 2 章', folderPath: ['第 2 章'] }),
  ];

  it('renders a collapsible section per folder with root files last, remembers mode and collapse state', () => {
    renderPage(grouped);
    expect(document.querySelector('[data-media-groups]')).toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: 'mediaStudio:view.grouped' }));
    expect(window.localStorage.getItem(MEDIA_LIBRARY_VIEW_KEY)).toBe('grouped');

    const sections = Array.from(document.querySelectorAll('[data-media-group]')).map((el) => el.getAttribute('data-media-group'));
    expect(sections).toEqual(['fld_2', 'fld_10', '__ungrouped__']);
    expect(within(document.querySelector('[data-media-group="__ungrouped__"]') as HTMLElement)
      .getByText('mediaStudio:group.ungrouped')).toBeTruthy();

    const toggle = document.querySelector('[data-media-group-toggle="fld_2"]') as HTMLElement;
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(rowIds()).toEqual(['c10', 'loose']);
    expect(JSON.parse(window.localStorage.getItem(MEDIA_LIBRARY_COLLAPSED_KEY) ?? '[]')).toEqual(['fld_2']);

    // 筛选在分组内依旧生效
    fireEvent.click(screen.getByRole('radio', { name: /mediaStudio:filter.transcribed/ }));
    expect(Array.from(document.querySelectorAll('[data-media-group]')).map((el) => el.getAttribute('data-media-group')))
      .toEqual(['fld_10']);

    // 重新挂载：视图与收起状态都记住
    cleanup();
    renderPage(grouped);
    expect(document.querySelector('[data-media-groups]')).toBeTruthy();
    expect(document.querySelector('[data-media-group-toggle="fld_2"]')?.getAttribute('aria-expanded')).toBe('false');
  });

  it('group header checkbox selects every item in that group', () => {
    window.localStorage.setItem(MEDIA_LIBRARY_VIEW_KEY, 'grouped');
    renderPage([...grouped, item('c2b', { folderId: 'fld_2', folderName: '第 2 章', folderPath: ['第 2 章'] })]);
    enterSelect();
    const groupBox = within(document.querySelector('[data-media-group="fld_2"]') as HTMLElement)
      .getByRole('checkbox', { name: 'mediaStudio:select.group' });
    fireEvent.click(groupBox);
    expect(countText()).toBe('mediaStudio:select.count:2');
    expect(groupBox.getAttribute('aria-checked')).toBe('true');
  });

  it('moves the selection into an existing folder, a new folder, or back to the root', async () => {
    dstuMocks.moveItem.mockResolvedValue(ok(undefined));
    dstuMocks.createFolder.mockResolvedValue(ok({ id: 'fld_new', title: '线性代数' }));
    const items = [
      item('p2', { name: '线性代数 P2 矩阵.bilibili', isLink: true, mimeType: 'video/x-bilibili' }),
      item('p3', { name: '线性代数 P3 向量.bilibili', isLink: true, mimeType: 'video/x-bilibili' }),
      item('c2', { folderId: 'fld_2', folderName: '第 2 章', folderPath: ['第 2 章'] }),
    ];
    const lib = renderPage(items);
    const pickRows = (...ids: string[]) => {
      for (const id of ids) {
        fireEvent.click(within(document.querySelector(`[data-media-row="${id}"]`) as HTMLElement).getByRole('checkbox'));
      }
    };

    // 1) 移到已有分组
    enterSelect();
    pickRows('p2', 'p3');
    fireEvent.click(document.querySelector('[data-media-select-move]') as HTMLElement);
    await act(async () => {
      fireEvent.click(await screen.findByRole('menuitem', { name: '第 2 章' }));
    });
    await waitFor(() => expect(dstuMocks.moveItem).toHaveBeenCalledTimes(2));
    expect(dstuMocks.moveItem).toHaveBeenCalledWith('file', 'p2', 'fld_2', { skipCacheRefresh: true });
    expect(dstuMocks.moveItem).toHaveBeenCalledWith('file', 'p3', 'fld_2', { skipCacheRefresh: true });
    expect(dstuMocks.updatePathCacheV2).toHaveBeenCalledWith('fld_2');
    expect(lib.refresh).toHaveBeenCalled();
    // 全部成功后退出多选
    await waitFor(() => expect(document.querySelector('[data-media-select-bar]')).toBeNull());

    // 2) 新建分组：名称预填公共标题前缀，先建文件夹再移动
    dstuMocks.moveItem.mockClear();
    enterSelect();
    pickRows('p2', 'p3');
    fireEvent.click(document.querySelector('[data-media-select-move]') as HTMLElement);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'mediaStudio:group.new' }));
    const nameInput = (await screen.findByRole('alertdialog')).querySelector('[data-media-new-group-name]') as HTMLInputElement;
    expect(nameInput.value).toBe('线性代数');
    await act(async () => {
      fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'mediaStudio:group.create' }));
    });
    await waitFor(() => expect(dstuMocks.moveItem).toHaveBeenCalledTimes(2));
    expect(dstuMocks.createFolder).toHaveBeenCalledWith('线性代数');
    expect(dstuMocks.moveItem).toHaveBeenCalledWith('file', 'p2', 'fld_new', { skipCacheRefresh: true });

    // 3) 移出分组：只移动确实在分组里的条目，目标为根
    dstuMocks.moveItem.mockClear();
    await waitFor(() => expect(document.querySelector('[data-media-select-bar]')).toBeNull());
    enterSelect();
    pickRows('p2', 'c2');
    fireEvent.click(document.querySelector('[data-media-select-move]') as HTMLElement);
    await act(async () => {
      fireEvent.click(await screen.findByRole('menuitem', { name: 'mediaStudio:group.moveOut' }));
    });
    await waitFor(() => expect(dstuMocks.moveItem).toHaveBeenCalledTimes(1));
    expect(dstuMocks.moveItem).toHaveBeenCalledWith('file', 'c2', undefined, { skipCacheRefresh: true });
  });

  it('phone: the selection bar replaces the bottom import bar', () => {
    renderPage([item('a')], vi.fn(), true);
    expect(document.querySelector('[data-media-import-bar]')).toBeTruthy();
    enterSelect();
    expect(document.querySelector('[data-media-import-bar]')).toBeNull();
    const bar = document.querySelector('[data-media-select-bar]') as HTMLElement;
    expect(within(bar).getByRole('button', { name: 'mediaStudio:select.done' })).toBeTruthy();
    fireEvent.click(within(bar).getByRole('button', { name: 'mediaStudio:select.done' }));
    expect(document.querySelector('[data-media-import-bar]')).toBeTruthy();
  });
});
