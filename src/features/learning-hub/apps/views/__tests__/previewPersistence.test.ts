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

vi.mock('@/shared/result', () => ({ reportError: vi.fn() }));

import { createPreviewPersistController } from '../previewPersistence';

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

  it('does not overwrite a newer bookmark with stale React metadata', async () => {
    const staleMetadata = {
      bookmarks: [],
      readingProgress: { page: 1, lastReadAt: 1 },
      custom: 'keep',
    };
    const controller = createPreviewPersistController({
      kind: 'file',
      nodeId: 'file-1',
      nodePath: '/file-1.pdf',
      getMetadata: () => staleMetadata,
    }, { progressDebounceMs: 20, bookmarksDebounceMs: 10 });
    const bookmarks = [{ id: 'b1', page: 7, title: 'Seven', createdAt: 10 }];

    controller.scheduleBookmarks(bookmarks);
    await vi.advanceTimersByTimeAsync(10);
    controller.scheduleProgress({ page: 8, lastReadAt: 20 });
    await vi.advanceTimersByTimeAsync(20);
    await controller.flush();

    expect(setMetadata).toHaveBeenLastCalledWith('/file-1.pdf', expect.objectContaining({
      bookmarks,
      readingProgress: { page: 8, lastReadAt: 20 },
    }));
    // 白名单：控制器只写自己拥有的字段，不再回写 metadata 里的其他字段
    const lastPayload = setMetadata.mock.calls.at(-1)?.[1] as Record<string, unknown>;
    expect(lastPayload).not.toHaveProperty('custom');
  });

  it('never echoes stale highlights back when persisting textbook progress', async () => {
    // textbook 的 dstu_set_metadata 一旦收到 highlights 就走「整表替换高亮」
    // 分支（要求 expected_updated_at 且跳过进度/书签写入）；
    // 阅读进度写入若把 props 里的陈旧 highlights 一并展开回写，
    // 会覆盖 Agent/UI 的并发标注或直接写失败。
    const metadataWithHighlights = {
      highlights: [{ id: 'h1', page: 3, color: 'yellow' }],
      readingProgress: { page: 1, lastReadAt: 1 },
      bookmarks: [{ id: 'b0', page: 1, title: 'Old', createdAt: 1 }],
    };
    const controller = createPreviewPersistController({
      kind: 'textbook',
      nodeId: 'tb-1',
      nodePath: '/tb-1.pdf',
      getMetadata: () => metadataWithHighlights,
    }, { progressDebounceMs: 10, bookmarksDebounceMs: 10 });

    controller.scheduleProgress({ page: 42, lastReadAt: 100 });
    await vi.advanceTimersByTimeAsync(10);
    await controller.flush();

    expect(setMetadata).toHaveBeenCalled();
    for (const call of setMetadata.mock.calls) {
      const payload = call[1] as Record<string, unknown>;
      expect(payload).not.toHaveProperty('highlights');
    }
    expect(setMetadata).toHaveBeenLastCalledWith('/tb-1.pdf', {
      readingProgress: { page: 42, lastReadAt: 100 },
      // 白名单基线：快照里的 bookmarks 仍随写保留
      bookmarks: metadataWithHighlights.bookmarks,
    });
  });

  it('textbook bookmarks still dual-write via updateBookmarks without highlights leakage', async () => {
    const controller = createPreviewPersistController({
      kind: 'textbook',
      nodeId: 'tb-2',
      nodePath: '/tb-2.pdf',
      getMetadata: () => ({
        highlights: [{ id: 'h1', page: 3 }],
      }),
    }, { progressDebounceMs: 10, bookmarksDebounceMs: 10 });
    const bookmarks = [{ id: 'b1', page: 9, title: 'Nine', createdAt: 5 }];

    controller.scheduleBookmarks(bookmarks);
    await vi.advanceTimersByTimeAsync(10);
    await controller.flush();

    expect(updateBookmarks).toHaveBeenCalledWith('tb-2', bookmarks);
    expect(setMetadata).toHaveBeenLastCalledWith('/tb-2.pdf', { bookmarks });
  });

  it('snapshots metadata at creation so a swapped node ref cannot cross-write', async () => {
    // 调用方传共享的 nodeMetadataRef 闭包：node 切换后该闭包会返回
    // 新 node 的 metadata。旧控制器 dispose 时的 flush 若再读，
    // 会把新 node 的书签串写到旧 node。
    const nodeAMetadata = {
      bookmarks: [{ id: 'a1', page: 2, title: 'A', createdAt: 1 }],
      readingProgress: { page: 2, lastReadAt: 1 },
    };
    const nodeBMetadata = {
      bookmarks: [{ id: 'b1', page: 99, title: 'B', createdAt: 2 }],
      readingProgress: { page: 99, lastReadAt: 2 },
    };
    const metadataRef = { current: nodeAMetadata as Record<string, unknown> };
    const controller = createPreviewPersistController({
      kind: 'file',
      nodeId: 'file-a',
      nodePath: '/file-a.pdf',
      getMetadata: () => metadataRef.current,
    }, { progressDebounceMs: 10, bookmarksDebounceMs: 10 });

    controller.scheduleProgress({ page: 3, lastReadAt: 10 });
    // 模拟 React 切换 node：共享 ref 已指向 node B 的 metadata
    metadataRef.current = nodeBMetadata;
    await controller.dispose();

    expect(setMetadata).toHaveBeenLastCalledWith('/file-a.pdf', {
      readingProgress: { page: 3, lastReadAt: 10 },
      bookmarks: nodeAMetadata.bookmarks,
    });
  });
});
