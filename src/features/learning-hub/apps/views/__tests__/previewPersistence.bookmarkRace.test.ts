/**
 * 0824 Wave2-B 第 3 轮「书签测试」：双窗口书签覆盖竞态（红测试）。
 *
 * 场景：窗口 A、B 以空书签打开同一资源（各自持有 bookmarks: [] 的创建时快照）。
 * A 新增书签并落盘；B 只翻页（只走进度通道，从未 scheduleBookmarks）。
 * 后端 dstu_set_metadata 是字段级覆盖写：payload 里出现的字段整体替换存量值。
 *
 * 当前缺陷（本测试为红）：previewPersistence 的 mergeBase() 会把创建时
 * 快照里的 bookmarks: [] 折进每一次进度写的 payload——B 翻页落盘时携带
 * bookmarks: []，把 A 刚写入的书签整表清空。
 *
 * 红→绿预期：第 3 轮前端修复「进度写不再携带 bookmarks」（本控制器从未
 * scheduleBookmarks 过的情况下，进度通道 payload 不得出现 bookmarks 字段）
 * 落地后，第 8 轮验证时本文件应转绿。
 *
 * 本轮只新增测试，不改产品实现；禁止执行 vitest/npm。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PreviewPersistTarget } from '../previewPersistence';

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

import { createPreviewPersistController } from '../previewPersistence';

const NODE_PATH = '/shared-resource.pdf';
const NODE_ID = 'shared-resource';

/** 模拟后端：setMetadata 为字段级覆盖写（payload 出现的字段整体替换存量） */
function createSharedStore() {
  const store: { metadata: Record<string, unknown> } = { metadata: {} };
  setMetadata.mockImplementation(async (_path: string, payload: Record<string, unknown>) => {
    store.metadata = { ...store.metadata, ...payload };
    return { ok: true };
  });
  return store;
}

function openWindow(kind: PreviewPersistTarget['kind']) {
  // 两个窗口都以「空书签」打开同一资源：创建时快照为 bookmarks: []
  return createPreviewPersistController(
    {
      kind,
      nodeId: NODE_ID,
      nodePath: NODE_PATH,
      metadata: { bookmarks: [] },
    },
    { progressDebounceMs: 10, bookmarksDebounceMs: 10 },
  );
}

describe('previewPersistence bookmark race (window A adds bookmark, window B only turns pages)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setMetadata.mockReset();
    updateBookmarks.mockReset();
    updateBookmarks.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("file: B's progress flush must not wipe the bookmark A just persisted", async () => {
    const store = createSharedStore();
    const windowA = openWindow('file');
    const windowB = openWindow('file');
    const bookmarkFromA = [{ id: 'a-1', page: 7, title: 'Added by A', createdAt: 100 }];

    // A 新增书签并落盘
    windowA.scheduleBookmarks(bookmarkFromA);
    await vi.advanceTimersByTimeAsync(10);
    await windowA.flush();
    expect(store.metadata.bookmarks).toEqual(bookmarkFromA);

    // B 只翻页并落盘（防抖触发 + 关窗前 dispose flush 兜底）
    const callsBeforeB = setMetadata.mock.calls.length;
    windowB.scheduleProgress({ page: 12, lastReadAt: 200 });
    await vi.advanceTimersByTimeAsync(10);
    windowB.scheduleProgress({ page: 13, lastReadAt: 210 });
    await windowB.dispose();

    // 进度确实写进去了
    expect(store.metadata.readingProgress).toEqual({ page: 13, lastReadAt: 210 });

    // ★ 核心断言：B 从未 scheduleBookmarks，它的进度写不得携带 bookmarks
    // 字段——否则创建时快照的 [] 会把 A 的书签整表清空。
    const callsFromB = setMetadata.mock.calls.slice(callsBeforeB);
    expect(callsFromB.length).toBeGreaterThan(0);
    for (const call of callsFromB) {
      expect(call[1]).not.toHaveProperty('bookmarks');
    }

    // 共享存量上 A 的书签必须幸存
    expect(store.metadata.bookmarks).toEqual(bookmarkFromA);
  });

  it("textbook: B's page turns must not clear A's bookmark either", async () => {
    const store = createSharedStore();
    const windowA = openWindow('textbook');
    const windowB = openWindow('textbook');
    const bookmarkFromA = [{ id: 'a-tb', page: 3, title: 'Chapter 3', createdAt: 300 }];

    windowA.scheduleBookmarks(bookmarkFromA);
    await vi.advanceTimersByTimeAsync(10);
    await windowA.flush();
    expect(store.metadata.bookmarks).toEqual(bookmarkFromA);
    // A 的书签双写通道各只走一次（新增一枚书签）
    expect(updateBookmarks).toHaveBeenCalledTimes(1);
    expect(updateBookmarks).toHaveBeenCalledWith(NODE_ID, bookmarkFromA);

    const callsBeforeB = setMetadata.mock.calls.length;
    windowB.scheduleProgress({ page: 4, lastReadAt: 400 });
    await vi.advanceTimersByTimeAsync(10);
    await windowB.dispose();

    expect(store.metadata.readingProgress).toEqual({ page: 4, lastReadAt: 400 });

    const callsFromB = setMetadata.mock.calls.slice(callsBeforeB);
    expect(callsFromB.length).toBeGreaterThan(0);
    for (const call of callsFromB) {
      expect(call[1]).not.toHaveProperty('bookmarks');
    }
    // 纯翻页的窗口绝不能触发书签双写通道
    expect(updateBookmarks).toHaveBeenCalledTimes(1);

    expect(store.metadata.bookmarks).toEqual(bookmarkFromA);
  });
});
