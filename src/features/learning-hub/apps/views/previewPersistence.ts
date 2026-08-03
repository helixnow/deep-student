/**
 * 预览阅读进度 / 书签持久化控制器
 *
 * - textbook：进度走 dstu.setMetadata；书签双写 updateBookmarks + setMetadata（保持历史行为）
 * - file：仅 dstu.setMetadata（禁止 textbooks_update_bookmarks）
 *
 * NOTE(backend): dstu_set_metadata persists files readingProgress / bookmarks
 * to the shared files table and file_to_dstu_node exposes the values on reload.
 * （2026-07-19 核实：src-tauri/src/dstu/handlers.rs 对 textbook 与 file 分支均
 * 落库 readingProgress.page / bookmarks；node_converters.rs 在 textbook 与 file
 * 的 metadata 中回读 readingProgress / bookmarks。）
 *
 * 防抖契约：阅读进度防抖只在本层做一次（默认 1s），Viewer 包装层
 * （TextbookPdfViewer）为直通上报——不要再在调用侧叠加防抖。
 * 关 tab / 切换 node 时由 dispose() 内的 flush 兜底落盘。
 */

import { dstu } from '@/dstu';
import { vfsFileApi } from '@/api/vfsFileApi';
import { reportError, toVfsError, type Result } from '@/shared/result';
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
  // 1s：Viewer 层已改为直通上报，这里是链路上唯一一层防抖
  const progressDebounceMs = options?.progressDebounceMs ?? 1000;
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

  /**
   * setMetadata 写失败不再静默吞掉首错：console.warn 后原样重试一次，
   * 仍失败才走 reportError + 调用方错误回调。
   */
  const setMetadataWithRetry = async (
    metadata: Record<string, unknown>,
    label: string,
  ): Promise<Result<void>> => {
    const first = await dstu.setMetadata(currentTarget.nodePath, metadata);
    if (first.ok) return first;
    console.warn(
      `[previewPersistence] ${label} write failed, retrying once:`,
      currentTarget.nodePath,
      first.error,
    );
    return dstu.setMetadata(currentTarget.nodePath, metadata);
  };

  /** textbook 双写通道同样重试一次（幂等的整表覆盖写） */
  const updateBookmarksWithRetry = async (bookmarks: Bookmark[]): Promise<void> => {
    try {
      await vfsFileApi.updateBookmarks(currentTarget.nodeId, bookmarks);
    } catch (firstErr: unknown) {
      console.warn(
        '[previewPersistence] updateBookmarks write failed, retrying once:',
        currentTarget.nodeId,
        firstErr,
      );
      await vfsFileApi.updateBookmarks(currentTarget.nodeId, bookmarks);
    }
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
    const result = await setMetadataWithRetry(newMetadata, 'readingProgress');
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
        await updateBookmarksWithRetry(bookmarks);
      } catch (err: unknown) {
        options?.onBookmarksError?.(err);
        throw err;
      }
    }
    // file：仅 DSTU metadata（见文件头 NOTE(backend)）

    const result = await setMetadataWithRetry(newMetadata, 'bookmarks');
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
            await updateBookmarksWithRetry(bookmarks);
          } catch (err: unknown) {
            // ★ flush 常在关窗/切 node 前的最后一次落盘：书签双写通道失败
            // 不能连带丢掉 pending 的阅读进度，继续走 setMetadata。
            reportError(toVfsError(err, '保存书签失败'), '保存书签');
            options?.onBookmarksError?.(err);
          }
        }
      }

      const result = await setMetadataWithRetry(mergedMetadata, 'flush');
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
