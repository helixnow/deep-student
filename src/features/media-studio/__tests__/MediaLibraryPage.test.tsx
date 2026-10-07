/**
 * 音视频库页：空态（三点能力 + 导入 + 字幕说明）、列表行（状态徽章 / 进度 / 打开）、
 * 筛选计数、手机布局（底部导入条 + 媒体 accept 的系统选择器）。
 */
import React from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

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
  UnifiedDragDropZone: ({ children, enabled }: { children: React.ReactNode; enabled?: boolean }) => (
    <div data-testid="dropzone" data-enabled={String(enabled)}>{children}</div>
  ),
}));
vi.mock('@/dstu', () => ({ dstu: { rename: vi.fn(), delete: vi.fn() } }));

import type { MediaLibraryItem } from '../api';
import type { MediaLibraryState } from '../useMediaLibrary';
import type { MediaImportController } from '../useMediaImport';
import { MediaLibraryPage } from '../components/MediaLibraryPage';

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

function library(items: MediaLibraryItem[]): MediaLibraryState {
  return { items, loading: false, loaded: true, error: null, refresh: vi.fn(async () => undefined), removeLocal: vi.fn() };
}

function importer(usesFileInput: boolean): MediaImportController {
  return {
    importing: false,
    progress: null,
    pick: vi.fn(),
    importSources: vi.fn(async () => undefined),
    inputRef: { current: null },
    onInputChange: vi.fn(),
    usesFileInput,
  };
}

afterEach(() => cleanup());

describe('MediaLibraryPage', () => {
  it('empty library explains the three capabilities and offers import (desktop)', () => {
    const imp = importer(false);
    render(<MediaLibraryPage library={library([])} importer={imp} onOpen={vi.fn()} isSmallScreen={false} titlebarTarget={null} />);
    const empty = document.querySelector('[data-media-library-empty]') as HTMLElement;
    expect(within(empty).getByText('mediaStudio:empty.transcribe')).toBeTruthy();
    expect(within(empty).getByText('mediaStudio:empty.ask')).toBeTruthy();
    expect(within(empty).getByText('mediaStudio:empty.review')).toBeTruthy();
    expect(within(empty).getByText('mediaStudio:empty.subtitleNote')).toBeTruthy();
    fireEvent.click(within(empty).getByRole('button', { name: /mediaStudio:import.button/ }));
    expect(imp.pick).toHaveBeenCalled();
    expect(screen.getByTestId('dropzone').dataset.enabled).toBe('true');
    expect(document.querySelector('[data-media-import-bar]')).toBeNull();
  });

  it('empty library offers import only once: the classic titlebar keeps just the title', () => {
    const titlebar = document.createElement('div');
    document.body.appendChild(titlebar);
    render(<MediaLibraryPage library={library([])} importer={importer(false)} onOpen={vi.fn()} isSmallScreen={false} titlebarTarget={titlebar} />);
    expect(within(titlebar).getByText('mediaStudio:title')).toBeTruthy();
    expect(within(titlebar).queryByRole('button', { name: /mediaStudio:import.button/ })).toBeNull();
    expect(screen.getAllByRole('button', { name: /mediaStudio:import.button/ })).toHaveLength(1);
    titlebar.remove();
  });

  it('titlebar keeps import when the list has items or failed to load', () => {
    const titlebar = document.createElement('div');
    document.body.appendChild(titlebar);
    const failed = { ...library([]), error: 'boom' };
    const { unmount } = render(<MediaLibraryPage library={failed} importer={importer(false)} onOpen={vi.fn()} isSmallScreen={false} titlebarTarget={titlebar} />);
    expect(within(titlebar).getByRole('button', { name: /mediaStudio:import.button/ })).toBeTruthy();
    unmount();
    render(<MediaLibraryPage library={library([item('a')])} importer={importer(false)} onOpen={vi.fn()} isSmallScreen={false} titlebarTarget={titlebar} />);
    expect(within(titlebar).getByRole('button', { name: /mediaStudio:import.button/ })).toBeTruthy();
    titlebar.remove();
  });

  it('lists rows by recent activity with status chips, progress and filter counts', () => {
    const onOpen = vi.fn();
    const items = [
      item('fresh'),
      item('watching', { progress: { lastPositionMs: 300_000, watchedMs: 300_000, finished: false }, lastWatchedAt: T0 + 1000 }),
      item('running', { transcript: { status: 'running', completedSegments: 2, totalSegments: 8, failedSegments: 0, source: 'asr' }, updatedAt: T0 + 500 }),
      item('done', { transcript: { status: 'completed', completedSegments: 8, totalSegments: 8, failedSegments: 0, source: 'import' } }),
    ];
    render(<MediaLibraryPage library={library(items)} importer={importer(false)} onOpen={onOpen} isSmallScreen={false} titlebarTarget={null} />);

    const rows = Array.from(document.querySelectorAll('[data-media-row]')).map((el) => el.getAttribute('data-media-row'));
    expect(rows).toEqual(['watching', 'running', 'done', 'fresh']);
    const chip = (id: string) => document.querySelector(`[data-media-row="${id}"] [data-transcript-chip]`)?.getAttribute('data-transcript-chip');
    expect(chip('running')).toBe('running');
    expect(chip('done')).toBe('imported');
    expect(chip('fresh')).toBe('none');
    expect(document.querySelector('[data-media-row="watching"] [role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('50');
    expect(document.querySelector('[data-media-row="fresh"] [role="progressbar"]')).toBeNull();

    // 筛选：已转写 → 只剩 done
    fireEvent.click(screen.getByRole('radio', { name: /mediaStudio:filter.transcribed/ }));
    expect(Array.from(document.querySelectorAll('[data-media-row]')).map((el) => el.getAttribute('data-media-row'))).toEqual(['done']);

    fireEvent.click(screen.getByRole('button', { name: 'mediaStudio:row.open' }));
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: 'done' }));
  });

  it('phone: import pinned at the bottom, system picker accepts audio/video MIME first, no drag zone', () => {
    const imp = importer(true);
    render(<MediaLibraryPage library={library([item('a')])} importer={imp} onOpen={vi.fn()} isSmallScreen titlebarTarget={null} />);
    const bar = document.querySelector('[data-media-import-bar]') as HTMLElement;
    expect(bar).toBeTruthy();
    fireEvent.click(within(bar).getByRole('button', { name: /mediaStudio:import.button/ }));
    expect(imp.pick).toHaveBeenCalled();
    expect(within(bar).getByRole('button', { name: /mediaStudio:import.bilibili/ })).toBeTruthy();
    const input = document.querySelector('[data-media-import-input]') as HTMLInputElement;
    expect(input.multiple).toBe(true);
    expect(input.accept.startsWith('audio/*,video/*')).toBe(true);
    expect(screen.getByTestId('dropzone').dataset.enabled).toBe('false');
    // 每行的 ⋯ 菜单按钮可达
    expect(screen.getByRole('button', { name: 'mediaStudio:row.more' })).toBeTruthy();
  });

  it('Bilibili link button opens the import dialog; link rows show a badge without the .bilibili suffix', () => {
    const items = [
      item('link', {
        name: '线性代数 P2 矩阵.bilibili',
        mimeType: 'video/x-bilibili',
        isLink: true,
        coverUrl: 'https://i0.hdslb.com/bfs/archive/a.jpg',
      }),
      item('local'),
    ];
    render(<MediaLibraryPage library={library(items)} importer={importer(false)} onOpen={vi.fn()} isSmallScreen={false} titlebarTarget={null} />);

    const linkRow = document.querySelector('[data-media-row="link"]') as HTMLElement;
    expect(within(linkRow).getByText('线性代数 P2 矩阵')).toBeTruthy();
    expect(linkRow.querySelector('[data-media-link-badge]')).toBeTruthy();
    expect(document.querySelector('[data-media-row="local"] [data-media-link-badge]')).toBeNull();
    // 封面：referrerpolicy 必须先于 src 设置（WebKit 设 src 即发请求，B 站图床拒绝本地 Referer）
    const cover = linkRow.querySelector('img') as HTMLImageElement;
    expect(cover.getAttribute('src')).toBe('https://i0.hdslb.com/bfs/archive/a.jpg');
    const attrs = [...cover.attributes].map((attr) => attr.name);
    expect(attrs.indexOf('referrerpolicy')).toBeLessThan(attrs.indexOf('src'));
    expect(document.querySelector('[data-media-row="local"] img')).toBeNull();
    // 封面加载失败退回图标
    fireEvent.error(cover);
    expect(linkRow.querySelector('img')).toBeNull();

    expect(document.querySelector('[data-bilibili-dialog]')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /mediaStudio:import.bilibili/ }));
    expect(document.querySelector('[data-bilibili-dialog="create"]')).toBeTruthy();
  });
});
