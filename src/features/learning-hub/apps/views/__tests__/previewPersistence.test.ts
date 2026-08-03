import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { setMetadata } = vi.hoisted(() => ({ setMetadata: vi.fn() }));

vi.mock('@/dstu', () => ({
  dstu: { setMetadata },
}));

vi.mock('@/api/vfsFileApi', () => ({
  vfsFileApi: { updateBookmarks: vi.fn() },
}));

vi.mock('@/shared/result', () => ({ reportError: vi.fn() }));

import { createPreviewPersistController } from '../previewPersistence';

describe('previewPersistence', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setMetadata.mockReset();
    setMetadata.mockResolvedValue({ ok: true });
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
      custom: 'keep',
    }));
  });
});
