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
 * ★ 进度通道白名单：本控制器的 setMetadata payload 只允许携带
 * readingProgress / bookmarks 两个字段，且每次写入只携带本次真正变更的
 * 字段。禁止把 node metadata 里的 highlights / annotationRevision / title
 * 等字段透传进来——后端 textbook 分支一旦看到 highlights 就切换到批注
 * OCC 通道并要求 expected_updated_at，进度写入会直接 CONFLICT 失败；
 * stale 的 title 透传则会回滚并发重命名。
 *
 * ★ 跨窗口书签覆盖（wave2-B P5/r3）：后端 bookmarks 为三态契约（handlers.rs
 * textbook 与 files/file/image 两分支一致）——带 expected_updated_at 走 OCC
 * 原子替换；无版本且同请求带 readingProgress 时跳过书签（防进度捎带的陈旧
 * 快照）；无版本的纯书签请求 = 显式书签通道，整数组覆盖写。因此本控制器：
 * 进度写入（persistProgress 与 flush 的进度段）payload 绝不携带 bookmarks，
 * 包括创建时快照与本控制器写过的值——否则窗口 A 加书签落盘 → 窗口 B 翻页
 * 把 B 视角的旧书签数组随进度写回 → A 的新书签被清。**跨窗口翻页不得覆盖
 * 另一窗口新书签。** bookmarks 只随显式书签写入落盘（payload 仅含
 * bookmarks，命中后端显式通道）：textbook 继续走 updateBookmarks 双写通道，
 * file 仅 setMetadata。flush 时两者同时 pending 也按通道分写、不合并 payload
 * ——合并会命中后端「无版本跳过书签」防交错规则，丢掉显式书签变更。
 *
 * ★ target.metadata（创建时入参）现已不再并入任何写入 payload：写入只来自
 * 调用方显式 schedule 的值（schedule 时即深拷贝），因此 dispose()/flush()
 * 天然不会回读组件层的活 ref，node 切换时也不会把新 node 的数据串写进
 * 旧 node 的路径。
 *
 * 防抖契约：阅读进度防抖只在本层做一次（默认 1s），Viewer 包装层
 * （TextbookPdfViewer）为直通上报——不要再在调用侧叠加防抖。
 * 关 tab / 切换 node 时由 dispose() 内的 flush 兜底落盘。
 */

import i18n from '@/i18n';
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
  /**
   * 创建时的 node metadata（保留入参仅为调用方兼容）。
   * ★ 不会并入任何写入 payload：进度写只含 readingProgress，书签写只含
   * bookmarks，快照值一律不回写——见文件头「跨窗口书签覆盖」说明。
   */
  metadata?: Record<string, unknown> | null;
}

/** 进度通道允许写入的字段快照（创建时 sanitize + 拷贝，与源对象解耦） */
interface ProgressChannelSnapshot {
  readingProgress?: { page: number; lastReadAt?: number };
  bookmarks?: Bookmark[];
}

function cloneReadingProgress(progress: ReadingProgress): ReadingProgress {
  return {
    page: progress.page,
    ...(typeof progress.lastReadAt === 'number' ? { lastReadAt: progress.lastReadAt } : {}),
  };
}

function cloneBookmarks(bookmarks: Bookmark[]): Bookmark[] {
  return bookmarks.map((bookmark) => ({ ...bookmark }));
}

/**
 * 从 node metadata 中提取进度通道白名单字段（readingProgress / bookmarks）。
 * 返回值为拷贝，调用方后续修改源对象不影响快照。
 * NOTE：控制器的写入 payload 已不再并入该快照（见文件头「跨窗口书签覆盖」），
 * 此函数保留导出供读取侧做白名单提取 / 校验。
 */
export function sanitizeProgressChannelMetadata(
  metadata: Record<string, unknown> | undefined | null,
): ProgressChannelSnapshot {
  const snapshot: ProgressChannelSnapshot = {};
  if (!metadata || typeof metadata !== 'object') return snapshot;

  const progress = metadata.readingProgress as
    | { page?: unknown; lastReadAt?: unknown }
    | undefined;
  if (progress && typeof progress === 'object' && typeof progress.page === 'number') {
    snapshot.readingProgress = {
      page: progress.page,
      ...(typeof progress.lastReadAt === 'number'
        ? { lastReadAt: progress.lastReadAt }
        : {}),
    };
  }

  const bookmarks = metadata.bookmarks;
  if (Array.isArray(bookmarks)) {
    snapshot.bookmarks = cloneBookmarks(bookmarks as Bookmark[]);
  }

  return snapshot;
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
  // Every write, including unmount flushing, follows this chain. This prevents
  // an older debounce callback from completing after a newer user action.
  let writeChain: Promise<void> = Promise.resolve();

  const currentTarget = { ...target };
  // ★ 不做 metadata 快照回写、不维护 merge 基底：每次 setMetadata 只携带
  // 本次 schedule 的字段。尤其是翻页写不得携带 bookmarks——后端书签为
  // 无 OCC 整数组覆盖，跨窗口翻页不得覆盖另一窗口新书签（见文件头）。

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
    const ownedProgress = cloneReadingProgress(progress);
    // ★ payload 只含 readingProgress：翻页绝不携带 bookmarks（无论创建时
    // 快照还是本控制器写过的值）。跨窗口翻页不得覆盖另一窗口新书签。
    const newMetadata = { readingProgress: ownedProgress };
    const result = await setMetadataWithRetry(newMetadata, 'readingProgress');
    if (!result.ok) {
      reportError(
        result.error,
        i18n.t('practice:preview_persist.save_progress', { defaultValue: '保存阅读进度' }),
      );
      options?.onProgressError?.(result.error);
    }
  };

  const persistBookmarks = async (bookmarks: Bookmark[]) => {
    const ownedBookmarks = cloneBookmarks(bookmarks);
    // ★ payload 只含 bookmarks：对称地，书签写也不回带 readingProgress，
    // 避免把本窗口的旧进度覆盖到另一窗口刚写入的新进度上。
    const newMetadata = { bookmarks: ownedBookmarks };

    if (currentTarget.kind === 'textbook') {
      try {
        await updateBookmarksWithRetry(ownedBookmarks);
      } catch (err: unknown) {
        // ★ 与 flush 的书签段同一口径（r6 复核对齐）：双写通道失败不 rethrow
        // ——rethrow 会 ① 跳过下方 setMetadata，书签在两条通道上一条都没落；
        // ② 沿 enqueue 链传到 scheduleBookmarks 的 catch，onBookmarksError
        // 对同一次失败二次触发。此处报错后继续走 DSTU 通道。
        reportError(
          toVfsError(
            err,
            i18n.t('practice:preview_persist.save_bookmarks_failed', {
              defaultValue: '保存书签失败',
            }),
          ),
          i18n.t('practice:preview_persist.save_bookmarks', { defaultValue: '保存书签' }),
        );
        options?.onBookmarksError?.(err);
      }
    }
    // file：仅 DSTU metadata（见文件头 NOTE(backend)）

    const result = await setMetadataWithRetry(newMetadata, 'bookmarks');
    if (!result.ok) {
      reportError(
        result.error,
        i18n.t('practice:preview_persist.save_bookmarks', { defaultValue: '保存书签' }),
      );
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
      // ★ 按通道分写、不合并 payload：后端书签三态契约是「progress+bookmarks
      // 且无版本 → 跳过 bookmarks（防跨窗口交错）」，合并写会让关窗前的显式
      // 书签变更被后端静默丢弃。书签走「仅 bookmarks」显式通道先落盘（用户
      // 显式动作优先于环境性进度），进度写只含 readingProgress——跨窗口翻页
      // 不得覆盖另一窗口新书签。
      if (bookmarks) {
        const ownedBookmarks = cloneBookmarks(bookmarks);
        if (currentTarget.kind === 'textbook') {
          try {
            await updateBookmarksWithRetry(ownedBookmarks);
          } catch (err: unknown) {
            // ★ flush 常在关窗/切 node 前的最后一次落盘：书签双写通道失败
            // 不能连带丢掉 pending 的阅读进度，继续走 setMetadata。
            reportError(
              toVfsError(
                err,
                i18n.t('practice:preview_persist.save_bookmarks_failed', {
                  defaultValue: '保存书签失败',
                }),
              ),
              i18n.t('practice:preview_persist.save_bookmarks', { defaultValue: '保存书签' }),
            );
            options?.onBookmarksError?.(err);
          }
        }
        const bookmarksResult = await setMetadataWithRetry(
          { bookmarks: ownedBookmarks },
          'flush(bookmarks)',
        );
        if (!bookmarksResult.ok) {
          reportError(
            bookmarksResult.error,
            i18n.t('practice:preview_persist.flush_unsaved', {
              defaultValue: '保存未持久化的阅读进度/书签',
            }),
          );
          options?.onBookmarksError?.(bookmarksResult.error);
        }
      }

      if (progress) {
        const progressResult = await setMetadataWithRetry(
          { readingProgress: cloneReadingProgress(progress) },
          'flush(readingProgress)',
        );
        if (!progressResult.ok) {
          reportError(
            progressResult.error,
            i18n.t('practice:preview_persist.flush_unsaved', {
              defaultValue: '保存未持久化的阅读进度/书签',
            }),
          );
          options?.onProgressError?.(progressResult.error);
        }
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
      pendingProgress = cloneReadingProgress(progress);
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
      pendingBookmarks = cloneBookmarks(bookmarks);
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
