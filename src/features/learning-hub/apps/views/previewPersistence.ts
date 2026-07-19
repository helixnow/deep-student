/**
 * 预览阅读进度 / 书签持久化控制器
 *
 * - textbook：进度走 dstu.setMetadata；书签双写 updateBookmarks + setMetadata（保持历史行为）
 * - file：仅 dstu.setMetadata（禁止 textbooks_update_bookmarks）
 *
 * NOTE(backend): dstu_set_metadata persists files readingProgress / bookmarks
 * to the shared files table and file_to_dstu_node exposes the values on reload.
 */

import { dstu } from '@/dstu';
import { vfsFileApi } from '@/api/vfsFileApi';
import { reportError } from '@/shared/result';
import type {
  Bookmark,
  ReadingProgress,
} from '@/features/pdf/components/TextbookPdfViewer';

export type PreviewPersistKind = 'textbook' | 'file';

export interface PreviewPersistTarget {
  kind: PreviewPersistKind;
  nodeId: string;
  nodePath: string;
  /** 始终读最新 metadata，供 merge，避免覆盖并发字段 */
  getMetadata: () => Record<string, unknown> | undefined | null;
}

export interface PreviewPersistOptions {
  progressDebounceMs?: number;
  bookmarksDebounceMs?: number;
  onProgressError?: (error: unknown) => void;
  onBookmarksError?: (error: unknown) => void;
}

export interface PreviewPersistController {
  scheduleProgress: (progress: ReadingProgress) => void;
  scheduleBookmarks: (bookmarks: Bookmark[]) => void;
  /** node 切换 / unmount：合并一次 flush */
  flush: () => Promise<void>;
  dispose: () => Promise<void>;
}

export function createPreviewPersistController(
  target: PreviewPersistTarget,
  options?: PreviewPersistOptions,
): PreviewPersistController {
  const progressDebounceMs = options?.progressDebounceMs ?? 2000;
  const bookmarksDebounceMs = options?.bookmarksDebounceMs ?? 1000;

  let progressTimer: number | null = null;
  let bookmarksTimer: number | null = null;
  let pendingProgress: ReadingProgress | null = null;
  let pendingBookmarks: Bookmark[] | null = null;
  let disposed = false;
  // Metadata props can lag behind a successful write. Keep the two fields
  // owned by this controller as a local overlay so a later debounced write
  // cannot restore an older progress/bookmark value from React props.
  let latestProgress: ReadingProgress | null = null;
  let latestBookmarks: Bookmark[] | null = null;
  // Every write, including unmount flushing, follows this chain. This prevents
  // an older debounce callback from completing after a newer user action.
  let writeChain: Promise<void> = Promise.resolve();

  const currentTarget = { ...target };

  const mergeBase = (): Record<string, unknown> => {
    const meta = currentTarget.getMetadata();
    const merged = meta && typeof meta === 'object' ? { ...meta } : {};
    if (latestProgress) {
      merged.readingProgress = {
        page: latestProgress.page,
        lastReadAt: latestProgress.lastReadAt,
      };
    }
    if (latestBookmarks) merged.bookmarks = latestBookmarks;
    return merged;
  };

  const persistProgress = async (progress: ReadingProgress) => {
    latestProgress = progress;
    const newMetadata = {
      ...mergeBase(),
      readingProgress: {
        page: progress.page,
        lastReadAt: progress.lastReadAt,
      },
    };
    const result = await dstu.setMetadata(currentTarget.nodePath, newMetadata);
    if (!result.ok) {
      reportError(result.error, '保存阅读进度');
      options?.onProgressError?.(result.error);
    }
  };

  const persistBookmarks = async (bookmarks: Bookmark[]) => {
    latestBookmarks = bookmarks;
    const newMetadata = {
      ...mergeBase(),
      bookmarks,
    };

    if (currentTarget.kind === 'textbook') {
      try {
        await vfsFileApi.updateBookmarks(currentTarget.nodeId, bookmarks);
      } catch (err: unknown) {
        options?.onBookmarksError?.(err);
        throw err;
      }
    }
    // file：仅 DSTU metadata（见文件头 NOTE(backend)）

    const result = await dstu.setMetadata(currentTarget.nodePath, newMetadata);
    if (!result.ok) {
      reportError(result.error, '保存书签');
      options?.onBookmarksError?.(result.error);
    }
  };

  const enqueue = (write: () => Promise<void>) => {
    writeChain = writeChain.then(write, write);
    return writeChain;
  };

  const clearTimers = () => {
    if (progressTimer != null) {
      window.clearTimeout(progressTimer);
      progressTimer = null;
    }
    if (bookmarksTimer != null) {
      window.clearTimeout(bookmarksTimer);
      bookmarksTimer = null;
    }
  };

  const flush = (): Promise<void> => {
    if (disposed) return writeChain;

    clearTimers();

    const progress = pendingProgress;
    const bookmarks = pendingBookmarks;
    pendingProgress = null;
    pendingBookmarks = null;

    if (!progress && !bookmarks) return writeChain;

    const pendingWrite = enqueue(async () => {
      const mergedMetadata = mergeBase();
      if (progress) {
        mergedMetadata.readingProgress = {
          page: progress.page,
          lastReadAt: progress.lastReadAt,
        };
      }
      if (bookmarks) {
        mergedMetadata.bookmarks = bookmarks;
        if (currentTarget.kind === 'textbook') {
          try {
            await vfsFileApi.updateBookmarks(currentTarget.nodeId, bookmarks);
          } catch (err: unknown) {
            options?.onBookmarksError?.(err);
            throw err;
          }
        }
      }

      const result = await dstu.setMetadata(currentTarget.nodePath, mergedMetadata);
      if (!result.ok) {
        reportError(result.error, '保存未持久化的阅读进度/书签');
        if (progress) options?.onProgressError?.(result.error);
        if (bookmarks) options?.onBookmarksError?.(result.error);
      }
    });
    // Cleanup callers intentionally do not await; mark errors handled while
    // still returning the queue for callers that do want to await it.
    void pendingWrite.catch(() => {});
    return pendingWrite;
  };

  return {
    scheduleProgress: (progress) => {
      if (disposed) return;
      latestProgress = progress;
      pendingProgress = progress;
      if (progressTimer != null) window.clearTimeout(progressTimer);
      progressTimer = window.setTimeout(() => {
        progressTimer = null;
        const next = pendingProgress;
        pendingProgress = null;
        if (next) {
          void enqueue(() => persistProgress(next)).catch((err: unknown) => {
            options?.onProgressError?.(err);
          });
        }
      }, progressDebounceMs);
    },

    scheduleBookmarks: (bookmarks) => {
      if (disposed) return;
      latestBookmarks = bookmarks;
      pendingBookmarks = bookmarks;
      if (bookmarksTimer != null) window.clearTimeout(bookmarksTimer);
      bookmarksTimer = window.setTimeout(() => {
        bookmarksTimer = null;
        const next = pendingBookmarks;
        pendingBookmarks = null;
        if (next) {
          void enqueue(() => persistBookmarks(next)).catch((err: unknown) => {
            options?.onBookmarksError?.(err);
          });
        }
      }, bookmarksDebounceMs);
    },

    flush,

    dispose: () => {
      if (disposed) return writeChain;
      const pendingWrites = flush();
      disposed = true;
      clearTimers();
      return pendingWrites;
    },
  };
}
