import type React from 'react';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { textbookDstuAdapter } from '@/dstu/adapters/textbookDstuAdapter';
import { attachmentDstuAdapter } from '@/dstu/adapters/attachmentDstuAdapter';
import {
  extractFileName,
  extractDisplayFileName,
  extractFileExtension,
  resolveImportFileInfo,
  type ResolvedImportInfo,
} from '@/utils/fileManager';
import type { DstuNode } from '@/dstu';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { debugLog } from '@/debug-panel/debugMasterSwitch';
import { pLimit } from '@/utils/concurrency';
import type { ImportProgressState, ImportStage } from '../components/ImportProgressModal';
import type { FinderPath } from '../stores/finderStore';
import { dstuNodeToResourceListItem } from '../types';
import type { LearningHubSidebarProps } from '../types';
import {
  consumePathsDropHandledFlag,
  isDragDropBlockedView,
  partitionMarkdownNoteImports,
} from '../dragDropRouting';
import {
  DOCUMENT_EXTENSIONS,
  IMAGE_EXTENSIONS,
  MEDIA_EXTENSIONS,
  MODULE_GUIDANCE_EXTENSIONS,
  getFileExtension,
  type SidebarT,
  type TextbookImportProgress,
} from './sidebarConstants';
import type { MarkdownNoteImport } from './useMarkdownNoteImport';

type AttachImportProgress = { done: number; total: number } | null;

/**
 * 旧 URI 名称回退：仅在 native 描述解析失败、且路径本身带明确扩展名时使用，
 * 保持“普通有后缀路径”的既有分流行为。
 */
function legacyImportInfo(path: string): ResolvedImportInfo | null {
  const displayName = extractFileName(path);
  // 必须使用真正的“最后一个点号后的非空后缀”语义：
  // opaque ID（msf:1000000099）没有点号，不能被 split('.') 误当成扩展名。
  const extension = extractFileExtension(path);
  if (!extension) return null;
  const kind = IMAGE_EXTENSIONS.has(extension)
    ? 'image'
    : MEDIA_EXTENSIONS.has(extension)
      ? 'media'
      : DOCUMENT_EXTENSIONS.has(extension)
        ? 'document'
        : 'file';
  return { displayName, extension, mimeType: '', kind };
}

/** native 描述可能缺少扩展名；归一化后再用于分流和落库命名。 */
function normalizeResolvedImportInfo(path: string, info: ResolvedImportInfo): ResolvedImportInfo {
  const fallbackName = extractFileName(path);
  const rawName = info.displayName.trim() || fallbackName;
  const extension = (info.extension ?? extractFileExtension(rawName)).trim().toLowerCase() || null;
  const displayName = extension && !extractFileExtension(rawName)
    ? `${rawName}.${extension}`
    : rawName;
  return {
    displayName,
    extension,
    mimeType: info.mimeType || 'application/octet-stream',
    kind: info.kind,
  };
}


export interface ImportPathsContext {
  importProgress: Pick<ImportProgressState, 'isImporting'>;
  t: SidebarT;
  currentCreatableFolderId: string | null;
  importMarkdownPathNotes: MarkdownNoteImport['importMarkdownPathNotes'];
  isMountedRef: React.MutableRefObject<boolean>;
  setImportProgress: React.Dispatch<React.SetStateAction<ImportProgressState>>;
  setAttachImportProgress: React.Dispatch<React.SetStateAction<AttachImportProgress>>;
  handleRefresh: () => Promise<void>;
  openImportedMarkdownNote: MarkdownNoteImport['openImportedMarkdownNote'];
  onOpenApp: LearningHubSidebarProps['onOpenApp'];
}

/**
 * 按文件路径导入（拖拽与「导入资料…」对话框共用）
 * 按扩展名分类后分发到对应适配器
 */
export async function importPathsIntoLibrary(
  {
    importProgress,
    t,
    currentCreatableFolderId,
    importMarkdownPathNotes,
    isMountedRef,
    setImportProgress,
    setAttachImportProgress,
    handleRefresh,
    openImportedMarkdownNote,
    onOpenApp,
  }: ImportPathsContext,
  paths: string[],
): Promise<void> {
  if (paths.length === 0) return;
  if (importProgress.isImporting) return;

  debugLog.log('[LearningHub] 导入文件:', paths.length, '个文件');

  // Markdown 本身就是笔记：任何位置拖入都导入为笔记（用笔记应用打开、可编辑），
  // 不再只在「笔记」视图才这样——在「全部文件」拖入会变成只读预览的资料
  const shouldImportMarkdownAsNotes = true;

  // 按类型分组
  const docPaths: string[] = [];
  const imagePaths: string[] = [];
  const otherPaths: string[] = [];
  const resolvedInfoByPath = new Map<string, ResolvedImportInfo>();

  const guidanceNames: Record<'flashcards' | 'mindmap', string[]> = {
    flashcards: [],
    mindmap: [],
  };

  // ★ Android 修复：SAF opaque document ID 的末段不含真实文件名/扩展名。
  // 分流前先向 native 请求有界内容检测后的描述；只有带明确后缀的普通路径
  // 才允许在 IPC 失败时回退到旧行为。opaque 且无描述的文件必须显式失败，
  // 不能以 octet-stream 静默落库。
  // ★ 2026-07-20：失败文件明细（文件名 + 具体原因），toast 不再只报笼统"导入失败"
  const failedDetails: { name: string; reason?: string }[] = [];
  let totalFailed = 0;

  for (const p of paths) {
    let info: ResolvedImportInfo;
    try {
      info = await resolveImportFileInfo(p);
    } catch (resolveError) {
      const fallback = legacyImportInfo(p);
      if (!fallback) {
        debugLog.error('[LearningHub] 无法解析导入文件描述:', extractDisplayFileName(p), resolveError);
        failedDetails.push({ name: extractDisplayFileName(p), reason: t('finder.dragDrop.readFileFailed') });
        totalFailed += 1;
        continue;
      }
      info = fallback;
    }

    const resolved = normalizeResolvedImportInfo(p, info);
    resolvedInfoByPath.set(p, resolved);
    const name = resolved.displayName;
    const ext = (resolved.extension ?? extractFileExtension(name)).toLowerCase();
    const guidance = MODULE_GUIDANCE_EXTENSIONS[ext];
    if (guidance) {
      // ★ P3 引导：apkg/xmind 等不进资源库，提示到对应模块导入
      guidanceNames[guidance].push(name);
      continue;
    }
    if (resolved.kind === 'image') {
      imagePaths.push(p);
    } else if (resolved.kind === 'document') {
      docPaths.push(p);
    } else {
      otherPaths.push(p);
    }
  }

  const buildFailedSummary = () => failedDetails.length > 0
    ? t('finder.dragDrop.importFailedFiles', {
        names: failedDetails
          .slice(0, 3)
          .map((f) => (f.reason ? `${f.name}（${f.reason}）` : f.name))
          .join('；'),
      })
    : undefined;

  if (guidanceNames.flashcards.length > 0) {
    showGlobalNotification('info', t('finder.dragDrop.guidanceFlashcards', {
      names: guidanceNames.flashcards.join('、'),
    }));
  }
  if (guidanceNames.mindmap.length > 0) {
    showGlobalNotification('info', t('finder.dragDrop.guidanceMindmap', {
      names: guidanceNames.mindmap.join('、'),
    }));
  }
  if (docPaths.length === 0 && imagePaths.length === 0 && otherPaths.length === 0) {
    if (failedDetails.length > 0) {
      showGlobalNotification('error', t('finder.dragDrop.importFailed'), buildFailedSummary());
    }
    return;
  }

  debugLog.log('[LearningHub] 文件分类:', {
    documents: docPaths.length,
    images: imagePaths.length,
    others: otherPaths.length,
    markdownAsNotes: shouldImportMarkdownAsNotes,
  });

  const { markdownItems: markdownNotePaths, otherItems: textbookPaths } = partitionMarkdownNoteImports(
    docPaths,
    (path) => resolvedInfoByPath.get(path)?.displayName ?? extractFileName(path),
    shouldImportMarkdownAsNotes,
  );

  let totalSuccess = 0;
  let unlisten: UnlistenFn | null = null;
  let firstImportedNode: DstuNode | null = null;
  // 后端按内容哈希去重：拖入已有的同一份文件会返回旧条目，不能报「已导入」
  const duplicateNames: string[] = [];
  const importStartedAt = Date.now();

  try {
    const dropTargetFolderId = currentCreatableFolderId;

    if (markdownNotePaths.length > 0) {
      const markdownResult = await importMarkdownPathNotes(markdownNotePaths, dropTargetFolderId);

      if (!isMountedRef.current) return;

      totalSuccess += markdownResult.importedNodes.length;
      totalFailed += markdownResult.failedCount;
      firstImportedNode = markdownResult.importedNodes[0] ?? firstImportedNode;

      if (markdownResult.importedNodes.length === 0 && markdownResult.failedCount > 0) {
        debugLog.error('[LearningHub] Markdown 笔记导入失败:', markdownResult.firstError);
      }
    }

    // 1. 文档类：通过 textbookDstuAdapter 导入（支持 PDF 渲染、哈希去重等）
    if (textbookPaths.length > 0) {
      const firstFileName = textbookPaths[0]
        ? resolvedInfoByPath.get(textbookPaths[0])?.displayName ?? extractDisplayFileName(textbookPaths[0])
        : '';
      setImportProgress({
        isImporting: true,
        fileName: firstFileName,
        stage: 'hashing',
        progress: 0,
      });

      // 监听后端进度事件
      unlisten = await listen<TextbookImportProgress>('textbook-import-progress', (event) => {
        const { file_name, stage, current_page, total_pages, progress, error: progressError } = event.payload;
        setImportProgress(prev => ({
          ...prev,
          fileName: file_name,
          stage: stage as ImportStage,
          currentPage: current_page,
          totalPages: total_pages,
          progress,
          error: progressError,
        }));
      });

      const docResult = await textbookDstuAdapter.addTextbooks(textbookPaths, dropTargetFolderId);

      if (unlisten) { unlisten(); unlisten = null; }

      if (!isMountedRef.current) return;

      if (docResult.ok) {
        const existing = docResult.value.filter((node) => node.createdAt < importStartedAt - 5_000);
        duplicateNames.push(...existing.map((node) => node.name));
        totalSuccess += docResult.value.length - existing.length;
        if (!firstImportedNode) {
          firstImportedNode = docResult.value[0] ?? null;
        }
      } else {
        totalFailed += textbookPaths.length;
        debugLog.error('[LearningHub] 文档导入失败:', docResult.error.toUserMessage());
      }

      setImportProgress(prev => ({ ...prev, isImporting: false }));
    }

    // 2. 图片类/其他文件：通过 attachmentDstuAdapter 创建
    const attachmentPaths = [...imagePaths, ...otherPaths];
    if (attachmentPaths.length > 0) {
      // ★ 由 Rust 直接把文件（含 Android content:// URI、含中文/空格的 Windows 路径）
      // 流式复制进暂存区，WebView 不再经手字节（旧路径 read_file_bytes → File →
      // base64 → JSON IPC，3 个并发的 200MB 文件在手机上会撑爆渲染进程）。
      const { stagePathUpload, abortStagedUpload, createByteBudgetLimiter } = await import('@/utils/stagedUpload');
      const { mimeTypeFromFileName } = await import('@/hooks/useTauriDragAndDrop');
      const limit = pLimit(3);
      // 后端创建时会把暂存文件整份读入内存：按字节预算串行化大文件
      const byteBudget = createByteBudgetLimiter(64 * 1024 * 1024);

      // ★ 2026-06-12（审阅问题 FE-M5）：批量导入显示进度横幅
      if (attachmentPaths.length > 1) {
        setAttachImportProgress({ done: 0, total: attachmentPaths.length });
      }

      const attachResults = await Promise.all(
        attachmentPaths.map((filePath) =>
          limit(async () => {
            const resolved = resolvedInfoByPath.get(filePath);
            const name = resolved?.displayName ?? extractFileName(filePath);
            const ext = (resolved?.extension ?? extractFileExtension(name)).toLowerCase();
            const isImage = resolved ? resolved.kind === 'image' : IMAGE_EXTENSIONS.has(ext);
            const isMedia = resolved ? resolved.kind === 'media' : MEDIA_EXTENSIONS.has(ext);

            try {
              let staged: { uploadId: string; size: number };
              try {
                staged = await stagePathUpload(filePath);
              } catch (readError) {
                debugLog.error('[LearningHub] 读取文件失败:', name, readError);
                return { ok: false as const, name, reason: t('finder.dragDrop.readFileFailed') };
              }

              // 可靠描述优先；provider 只给 octet-stream 时再用名称兜底。
              const resolvedMime = resolved?.mimeType && resolved.mimeType !== 'application/octet-stream'
                ? resolved.mimeType
                : undefined;
              const mimeType = resolvedMime
                || mimeTypeFromFileName(name)
                || (isImage ? `image/${ext === 'jpg' ? 'jpeg' : ext}` : 'application/octet-stream');

              let result;
              try {
                result = await byteBudget(staged.size, () => attachmentDstuAdapter.createFromStagedUpload(
                  { uploadId: staged.uploadId, name, mimeType, size: staged.size },
                  isImage ? 'image' : 'file',
                  currentCreatableFolderId ? { folderId: currentCreatableFolderId } : undefined,
                ));
              } catch (createError) {
                // 后端未消费（如 IPC 异常）时主动清理暂存文件；已消费则为幂等空操作
                void abortStagedUpload(staged.uploadId);
                throw createError;
              }
              if (!result.ok) {
                void abortStagedUpload(staged.uploadId);
                // ★ 携带后端结构化拒绝原因（如"不支持的文件类型 .xyz"）
                return { ok: false as const, name, reason: result.error.toUserMessage() };
              }
              return { ok: true as const, name, node: result.value, isMedia };
            } catch (e) {
              debugLog.error('[LearningHub] 附件导入失败:', name, e);
              return {
                ok: false as const,
                name,
                reason: e instanceof Error ? e.message : undefined,
              };
            } finally {
              if (isMountedRef.current) {
                setAttachImportProgress(p => (p ? { ...p, done: p.done + 1 } : p));
              }
            }
          })
        )
      );

      if (!isMountedRef.current) return;
      setAttachImportProgress(null);

      for (const r of attachResults) {
        if (r.ok) totalSuccess++;
        else {
          totalFailed++;
          failedDetails.push({ name: r.name, reason: r.reason });
        }
      }
      // 没有文档时打开第一个导入的音视频：直接进入转写 / 字幕界面
      if (!firstImportedNode) {
        firstImportedNode = attachResults.find((r) => r.ok && 'isMedia' in r && r.isMedia)?.node ?? null;
      }
    }

    // 3. 显示结果通知（失败时附具体文件与原因，最多 3 条）
    const failedSummary = buildFailedSummary();
    const duplicateSummary = duplicateNames.length > 0
      ? t('finder.dragDrop.alreadyInLibrary', { names: duplicateNames.slice(0, 3).join('、') })
      : undefined;
    if (duplicateSummary && totalSuccess === 0 && totalFailed === 0) {
      showGlobalNotification('info', duplicateSummary);
    } else if (totalSuccess > 0 && totalFailed === 0) {
      showGlobalNotification('success',
        t('finder.dragDrop.importSuccess', { count: totalSuccess }),
        duplicateSummary,
      );
    } else if (totalSuccess > 0 && totalFailed > 0) {
      showGlobalNotification('warning',
        t('finder.dragDrop.importPartial', {
          success: totalSuccess,
          failed: totalFailed,
        }),
        failedSummary
      );
    } else if (totalFailed > 0) {
      showGlobalNotification('error',
        t('finder.dragDrop.importFailed'),
        failedSummary
      );
    }

    // 4. 刷新文件列表（全是已有文件时也打开它，让用户看到在哪）
    if (totalSuccess > 0 || duplicateNames.length > 0) {
      handleRefresh();
      if (firstImportedNode) {
        if (firstImportedNode.type === 'note') {
          openImportedMarkdownNote(firstImportedNode);
        } else if (onOpenApp) {
          onOpenApp(dstuNodeToResourceListItem(
            firstImportedNode,
            firstImportedNode.type === 'file' ? 'file' : 'textbook',
          ));
        }
      }
    }
  } catch (error) {
    if (unlisten) unlisten();
    debugLog.error('[LearningHub] 导入异常:', error);
    setImportProgress(prev => ({ ...prev, isImporting: false }));
    setAttachImportProgress(null);
    showGlobalNotification('error', t('finder.dragDrop.importFailed'));
  }
}

export interface ImportDroppedFilesContext {
  pathsDropHandledRef: React.MutableRefObject<boolean>;
  currentPath: FinderPath;
  t: SidebarT;
  importMarkdownFileObjects: MarkdownNoteImport['importMarkdownFileObjects'];
  currentCreatableFolderId: string | null;
  isMountedRef: React.MutableRefObject<boolean>;
  setAttachImportProgress: React.Dispatch<React.SetStateAction<AttachImportProgress>>;
  handleRefresh: () => Promise<void>;
  openImportedMarkdownNote: MarkdownNoteImport['openImportedMarkdownNote'];
}

/**
 * 处理浏览器 File 对象拖拽（非 Tauri 环境兜底）
 */
export async function importDroppedFiles(
  {
    pathsDropHandledRef,
    currentPath,
    t,
    importMarkdownFileObjects,
    currentCreatableFolderId,
    isMountedRef,
    setAttachImportProgress,
    handleRefresh,
    openImportedMarkdownNote,
  }: ImportDroppedFilesContext,
  files: File[],
): Promise<void> {
  if (files.length === 0) return;
  if (consumePathsDropHandledFlag(pathsDropHandledRef)) {
    debugLog.log('[LearningHub] 跳过 files 回调，统一走 paths 导入链路');
    return;
  }
  if (isDragDropBlockedView(currentPath)) {
    showGlobalNotification('warning', t('finder.dragDrop.notAllowedHere'));
    return;
  }

  debugLog.log('[LearningHub] 浏览器拖拽导入:', files.length, '个文件');

  // ★ P3 引导：apkg/xmind 等不进资源库，提示到对应模块导入
  const guidanceNames: Record<'flashcards' | 'mindmap', string[]> = {
    flashcards: [],
    mindmap: [],
  };
  const importableFiles = files.filter((file) => {
    const guidance = MODULE_GUIDANCE_EXTENSIONS[getFileExtension(file.name)];
    if (guidance) {
      guidanceNames[guidance].push(file.name);
      return false;
    }
    return true;
  });
  if (guidanceNames.flashcards.length > 0) {
    showGlobalNotification('info', t('finder.dragDrop.guidanceFlashcards', {
      names: guidanceNames.flashcards.join('、'),
    }));
  }
  if (guidanceNames.mindmap.length > 0) {
    showGlobalNotification('info', t('finder.dragDrop.guidanceMindmap', {
      names: guidanceNames.mindmap.join('、'),
    }));
  }
  if (importableFiles.length === 0) return;

  // Markdown 本身就是笔记：任何位置拖入都导入为笔记（用笔记应用打开、可编辑），
  // 不再只在「笔记」视图才这样——在「全部文件」拖入会变成只读预览的资料
  const shouldImportMarkdownAsNotes = true;
  const { markdownItems: markdownFiles, otherItems: attachmentFiles } = partitionMarkdownNoteImports(
    importableFiles,
    (file) => file.name,
    shouldImportMarkdownAsNotes,
  );

  let totalSuccess = 0;
  let totalFailed = 0;
  const limit = pLimit(3);
  let firstImportedNode: DstuNode | null = null;

  if (markdownFiles.length > 0) {
    const markdownResult = await importMarkdownFileObjects(markdownFiles, currentCreatableFolderId);
    if (!isMountedRef.current) return;

    totalSuccess += markdownResult.importedNodes.length;
    totalFailed += markdownResult.failedCount;
    firstImportedNode = markdownResult.importedNodes[0] ?? null;
  }

  // ★ 2026-06-12（审阅问题 FE-M5）：批量导入显示进度横幅
  if (attachmentFiles.length > 1) {
    setAttachImportProgress({ done: 0, total: attachmentFiles.length });
  }

  const results = await Promise.all(
    attachmentFiles.map((file) =>
      limit(async () => {
        const ext = getFileExtension(file.name);
        const isImage = IMAGE_EXTENSIONS.has(ext);

        try {
          // ★ 2026-06-12（审阅问题 FE-M1）：传递当前文件夹 ID，
          // 修复浏览器拖入的附件总是落到根目录的问题（Tauri paths 链路本就正确）。
          const result = await attachmentDstuAdapter.create(
            file,
            isImage ? 'image' : 'file',
            currentCreatableFolderId ? { folderId: currentCreatableFolderId } : undefined,
          );
          if (!result.ok) {
            return { ok: false as const, name: file.name, reason: result.error.toUserMessage() };
          }
          return { ok: true as const, name: file.name };
        } catch (e) {
          return {
            ok: false as const,
            name: file.name,
            reason: e instanceof Error ? e.message : undefined,
          };
        } finally {
          if (isMountedRef.current) {
            setAttachImportProgress(p => (p ? { ...p, done: p.done + 1 } : p));
          }
        }
      })
    )
  );

  if (!isMountedRef.current) return;
  setAttachImportProgress(null);

  const failedDetails: { name: string; reason?: string }[] = [];
  for (const r of results) {
    if (r.ok) totalSuccess++;
    else {
      totalFailed++;
      failedDetails.push({ name: r.name, reason: r.reason });
    }
  }

  // ★ 失败时附具体文件与原因（最多 3 条），不再只报笼统"导入失败"
  const failedSummary = failedDetails.length > 0
    ? t('finder.dragDrop.importFailedFiles', {
        names: failedDetails
          .slice(0, 3)
          .map((f) => (f.reason ? `${f.name}（${f.reason}）` : f.name))
          .join('；'),
      })
    : undefined;
  if (totalSuccess > 0 && totalFailed === 0) {
    showGlobalNotification('success',
      t('finder.dragDrop.importSuccess', { count: totalSuccess })
    );
  } else if (totalSuccess > 0) {
    showGlobalNotification('warning',
      t('finder.dragDrop.importPartial', {
        success: totalSuccess,
        failed: totalFailed,
      }),
      failedSummary
    );
  } else if (totalFailed > 0) {
    showGlobalNotification('error', t('finder.dragDrop.importFailed'), failedSummary);
  }

  if (totalSuccess > 0) {
    handleRefresh();
    if (firstImportedNode) {
      openImportedMarkdownNote(firstImportedNode);
    }
  }
}
