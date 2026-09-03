import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { setMetadata, updateBookmarks } = vi.hoisted(() => ({
  setMetadata: vi.fn(),
  updateBookmarks: vi.fn(),
}));

vi.mock('@/dstu', () => ({
  dstu: { setMetadata },
}));

vi.mock('@/api/vfsFileApi', () => ({
  vfsFileApi: { updateBookmarks },
}));

vi.mock('@/shared/result', () => ({
  reportError: vi.fn(),
  toVfsError: (err: unknown) => err,
}));

import {
  createPreviewPersistController,
  sanitizeProgressChannelMetadata,
} from '../previewPersistence';

describe('previewPersistence', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setMetadata.mockReset();
    setMetadata.mockResolvedValue({ ok: true });
    updateBookmarks.mockReset();
    updateBookmarks.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not overwrite a newer bookmark with stale snapshot metadata', async () => {
    const staleMetadata = {
      bookmarks: [],
      readingProgress: { page: 1, lastReadAt: 1 },
      custom: 'must-not-pass-through',
    };
    const controller = createPreviewPersistController({
      kind: 'file',
      nodeId: 'file-1',
      nodePath: '/file-1.pdf',
      metadata: staleMetadata,
    }, { progressDebounceMs: 20, bookmarksDebounceMs: 10 });
    const bookmarks = [{ id: 'b1', page: 7, title: 'Seven', createdAt: 10 }];

    controller.scheduleBookmarks(bookmarks);
    await vi.advanceTimersByTimeAsync(10);
    controller.scheduleProgress({ page: 8, lastReadAt: 20 });
    await vi.advanceTimersByTimeAsync(20);
    await controller.flush();

    // ★ 白名单 + 按字段写：书签写只含 bookmarks，翻页写只含 readingProgress
    //（不携带任何 bookmarks——跨窗口翻页不得覆盖另一窗口新书签），
    // 快照里的其他字段（custom 等）不得透传进进度通道
    expect(setMetadata).toHaveBeenNthCalledWith(1, '/file-1.pdf', { bookmarks });
    expect(setMetadata).toHaveBeenLastCalledWith('/file-1.pdf', {
      readingProgress: { page: 8, lastReadAt: 20 },
    });
  });

  it('cross-window interleave: a page turn in window B never clobbers window A\'s new bookmark (P5)', async () => {
    // 两个控制器模拟两个窗口打开同一资源，各自创建时快照里书签均为空
    const staleSnapshot = () => ({
      bookmarks: [],
      readingProgress: { page: 1, lastReadAt: 1 },
    });
    const windowA = createPreviewPersistController({
      kind: 'file',
      nodeId: 'shared',
      nodePath: '/shared.pdf',
      metadata: staleSnapshot(),
    }, { bookmarksDebounceMs: 10 });
    const windowB = createPreviewPersistController({
      kind: 'file',
      nodeId: 'shared',
      nodePath: '/shared.pdf',
      metadata: staleSnapshot(),
    }, { progressDebounceMs: 10 });

    // 窗口 A 新增书签并落盘
    const addedByA = [{ id: 'a1', page: 5, title: 'From A', createdAt: 100 }];
    windowA.scheduleBookmarks(addedByA);
    await vi.advanceTimersByTimeAsync(10);
    expect(setMetadata).toHaveBeenLastCalledWith('/shared.pdf', { bookmarks: addedByA });

    // 窗口 B 仅翻页（防抖写 + flush/dispose 兜底路径）：后端书签为无 OCC
    // 整数组覆盖，B 的进度 payload 一旦携带其空书签快照就会清掉 A 的新书签
    windowB.scheduleProgress({ page: 9, lastReadAt: 200 });
    await vi.advanceTimersByTimeAsync(10);
    windowB.scheduleProgress({ page: 10, lastReadAt: 210 });
    await windowB.dispose();

    const writesAfterA = setMetadata.mock.calls.slice(1);
    expect(writesAfterA.length).toBeGreaterThan(0);
    for (const call of writesAfterA) {
      expect(call[1]).not.toHaveProperty('bookmarks');
    }
    expect(setMetadata).toHaveBeenLastCalledWith('/shared.pdf', {
      readingProgress: { page: 10, lastReadAt: 210 },
    });
  });

  it('textbook: never leaks highlights/annotationRevision into the progress channel', async () => {
    const metadataWithHighlights = {
      readingProgress: { page: 2, lastReadAt: 5 },
      bookmarks: [{ id: 'b0', page: 1, title: 'One', createdAt: 1 }],
      highlights: [{ id: 'hl-1', pageIndex: 1, text: 'x', color: '#fef08a', rects: [], createdAt: 1 }],
      annotationRevision: '2026-08-01T00:00:00.000Z',
      title: 'stale-title',
    };
    const controller = createPreviewPersistController({
      kind: 'textbook',
      nodeId: 'tb-1',
      nodePath: '/tb-1',
      metadata: metadataWithHighlights,
    }, { progressDebounceMs: 10, bookmarksDebounceMs: 10 });

    controller.scheduleProgress({ page: 9, lastReadAt: 100 });
    await vi.advanceTimersByTimeAsync(10);
    await controller.flush();

    expect(setMetadata).toHaveBeenCalled();
    for (const call of setMetadata.mock.calls) {
      const payload = call[1] as Record<string, unknown>;
      expect(payload).not.toHaveProperty('highlights');
      expect(payload).not.toHaveProperty('annotationRevision');
      expect(payload).not.toHaveProperty('title');
      expect(Object.keys(payload).every((key) => key === 'readingProgress' || key === 'bookmarks')).toBe(true);
    }
    // ★ 翻页写不得携带 bookmarks（即便创建时快照里有）：后端书签为无 OCC
    // 整数组覆盖，跨窗口翻页不得覆盖另一窗口新书签
    expect(setMetadata).toHaveBeenLastCalledWith('/tb-1', {
      readingProgress: { page: 9, lastReadAt: 100 },
    });
  });

  it('textbook: dual-writes bookmarks via updateBookmarks and setMetadata', async () => {
    const controller = createPreviewPersistController({
      kind: 'textbook',
      nodeId: 'tb-2',
      nodePath: '/tb-2',
      metadata: { highlights: [{ id: 'hl' }] },
    }, { bookmarksDebounceMs: 10 });
    const bookmarks = [{ id: 'b1', page: 3, title: 'Three', createdAt: 30 }];

    controller.scheduleBookmarks(bookmarks);
    await vi.advanceTimersByTimeAsync(10);
    await controller.flush();

    expect(updateBookmarks).toHaveBeenCalledWith('tb-2', bookmarks);
    expect(setMetadata).toHaveBeenLastCalledWith('/tb-2', { bookmarks });
  });

  it('dispose flush with only pending progress never writes bookmarks (cross-node / cross-window isolation)', async () => {
    // 模拟组件层活 ref：控制器创建后对象被切换成"新 node"的 metadata
    const oldBookmark = { id: 'old', page: 4, title: 'Old', createdAt: 4 };
    const liveMetadata: Record<string, unknown> = {
      readingProgress: { page: 4, lastReadAt: 40 },
      bookmarks: [oldBookmark],
    };
    const controller = createPreviewPersistController({
      kind: 'file',
      nodeId: 'file-old',
      nodePath: '/file-old.pdf',
      metadata: liveMetadata,
    }, { progressDebounceMs: 50 });

    controller.scheduleProgress({ page: 5, lastReadAt: 50 });

    // node 切换：活对象被替换为新 node 的数据（含新 node 的书签）
    liveMetadata.bookmarks = [{ id: 'next-node', page: 99, title: 'Next', createdAt: 99 }];
    liveMetadata.readingProgress = { page: 99, lastReadAt: 999 };
    liveMetadata.highlights = [{ id: 'next-node-highlight' }];
    // 旧数组元素被调用方原地改写也无所谓：进度写压根不携带 bookmarks。
    oldBookmark.title = 'Mutated after snapshot';
    oldBookmark.page = 88;

    await controller.dispose();

    // ★ 仅 progress pending 的收尾 flush 不得携带 bookmarks：既不带创建时
    // 快照（跨窗口翻页不得覆盖另一窗口新书签），更不带活 ref 上新 node 的数据
    expect(setMetadata).toHaveBeenCalledTimes(1);
    expect(setMetadata).toHaveBeenLastCalledWith('/file-old.pdf', {
      readingProgress: { page: 5, lastReadAt: 50 },
    });
  });

  it('dispose flush clones scheduled values and writes bookmarks/progress as split payloads', async () => {
    const controller = createPreviewPersistController({
      kind: 'textbook',
      nodeId: 'tb-flush',
      nodePath: '/tb-flush',
      metadata: {
        highlights: [{ id: 'must-not-leak' }],
        annotationRevision: 'stale-revision',
      },
    }, { progressDebounceMs: 100, bookmarksDebounceMs: 100 });
    const progress = { page: 6, lastReadAt: 60 };
    const bookmarks = [{ id: 'scheduled', page: 6, title: 'Scheduled', createdAt: 6 }];

    controller.scheduleProgress(progress);
    controller.scheduleBookmarks(bookmarks);
    progress.page = 66;
    bookmarks[0].title = 'Mutated after scheduling';
    await controller.dispose();

    // ★ r3 契约：flush 不合并 payload——合并的 progress+bookmarks 且无版本
    // 会命中后端「防交错」规则被跳过书签。书签先走「仅 bookmarks」显式通道，
    // 进度随后单独写。
    expect(setMetadata).toHaveBeenCalledTimes(2);
    expect(setMetadata).toHaveBeenNthCalledWith(1, '/tb-flush', {
      bookmarks: [{ id: 'scheduled', page: 6, title: 'Scheduled', createdAt: 6 }],
    });
    expect(setMetadata).toHaveBeenLastCalledWith('/tb-flush', {
      readingProgress: { page: 6, lastReadAt: 60 },
    });
    for (const call of setMetadata.mock.calls) {
      const payload = call[1] as Record<string, unknown>;
      expect(payload).not.toHaveProperty('highlights');
      expect(payload).not.toHaveProperty('annotationRevision');
    }
  });

  it('flush without pending changes does not write', async () => {
    const controller = createPreviewPersistController({
      kind: 'file',
      nodeId: 'file-2',
      nodePath: '/file-2.pdf',
      metadata: { readingProgress: { page: 3 } },
    });
    await controller.flush();
    await controller.dispose();
    expect(setMetadata).not.toHaveBeenCalled();
  });
});

describe('sanitizeProgressChannelMetadata', () => {
  it('extracts only whitelisted fields and copies them', () => {
    const bookmarks = [{ id: 'b', page: 1, title: 't', createdAt: 1 }];
    const source = {
      readingProgress: { page: 3, lastReadAt: 30 },
      bookmarks,
      highlights: [{ id: 'h' }],
      annotationRevision: 'rev',
      title: 'name',
    };
    const snapshot = sanitizeProgressChannelMetadata(source);
    expect(snapshot).toEqual({
      readingProgress: { page: 3, lastReadAt: 30 },
      bookmarks,
    });
    expect(snapshot.bookmarks).not.toBe(bookmarks);
    expect(snapshot.bookmarks?.[0]).not.toBe(bookmarks[0]);
    expect(snapshot.readingProgress).not.toBe(source.readingProgress);
  });

  it('ignores malformed values', () => {
    expect(sanitizeProgressChannelMetadata(null)).toEqual({});
    expect(sanitizeProgressChannelMetadata(undefined)).toEqual({});
    expect(sanitizeProgressChannelMetadata({
      readingProgress: { page: 'x' },
      bookmarks: 'not-an-array',
    } as unknown as Record<string, unknown>)).toEqual({});
  });
});
