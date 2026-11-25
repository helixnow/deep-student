import type React from 'react';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { textbookDstuAdapter } from '@/dstu/adapters/textbookDstuAdapter';
import { attachmentDstuAdapter } from '@/dstu/adapters/attachmentDstuAdapter';
import { extractFileName, extractDisplayFileName } from '@/utils/fileManager';
import type { DstuNode } from '@/dstu';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { debugLog } from '@/debug-panel/debugMasterSwitch';
import { pLimit } from '@/utils/concurrency';
import i18n from '@/i18n';
import type { ImportProgressState, ImportStage } from '../components/ImportProgressModal';
import type { FinderPath } from '../stores/finderStore';
import { dstuNodeToResourceListItem } from '../types';
import type { LearningHubSidebarProps } from '../types';
import {
  consumePathsDropHandledFlag,
  formatFailedImportSummary,
  isDragDropBlockedView,
  partitionMarkdownNoteImports,
  resolveImportFormatOptions,
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
import { canParseAsMobileTextbook, withStagedTextbookFile } from '../textbookFileImport';

type AttachImportProgress = { done: number; total: number } | null;

// U03 弱网连点幂等锁：按侧栏实例（isMountedRef）隔离，跨重渲染稳定且卸载自动 GC
const inFlightImportLocks = new WeakMap<object, Set<string>>();

function getImportLocks(instanceKey: object): Set<string> {
  let locks = inFlightImportLocks.get(instanceKey);
  if (!locks) {
    locks = new Set<string>();
    inFlightImportLocks.set(instanceKey, locks);
  }
  return locks;
}

/** 当前侧栏实例是否存在在途导入（供工具栏「导入资料」防连点复用） */
export function isImportActionInFlight(isMountedRef: object): boolean {
  const locks = inFlightImportLocks.get(isMountedRef);
  return Boolean(locks && locks.size > 0);
}

const UPLOAD_MIME_FALLBACKS: Record<string, string> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls: 'application/vnd.ms-excel',
  xlsb: 'application/vnd.ms-excel.sheet.binary.macroEnabled.12',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  epub: 'application/epub+zip',
  rtf: 'application/rtf',
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  json: 'application/json',
  jsonc: 'application/jsonc',
  jsonl: 'text/plain',
  xml: 'application/xml',
  html: 'text/html',
  htm: 'text/html',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  toml: 'application/toml',
  vtt: 'text/vtt',
  xmind: 'application/vnd.xmind.workbook',
  zip: 'application/zip',
  rar: 'application/vnd.rar',
  '7z': 'application/x-7z-compressed',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  m4a: 'audio/mp4',
  flac: 'audio/flac',
  aac: 'audio/aac',
  opus: 'audio/opus',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  avi: 'video/x-msvideo',
  mkv: 'video/x-matroska',
  m4v: 'video/x-m4v',
};

/**
 * 浏览器/OS 对 Office（本质为 ZIP 容器）或无注册关联的文件常上报空串、
 * application/octet-stream 或 application/zip；若扩展名有明确规范 MIME，
 * 优先使用规范 MIME，避免后端按 .bin/.zip 落盘或误判格式。
 */
const GENERIC_BROWSER_MIME_TYPES = new Set([
  'application/octet-stream',
  'binary/octet-stream',
  'application/zip',
  'application/x-zip-compressed',
  'application/x-msdownload',
]);

export function resolveUploadMimeType(fileName: string, providedType?: string, isImage = false): string {
  const trimmed = providedType?.trim() ?? '';
  const normalized = trimmed.toLowerCase();
  const ext = getFileExtension(fileName);
  const canonicalByExt = UPLOAD_MIME_FALLBACKS[ext];
  if (canonicalByExt && (!normalized || GENERIC_BROWSER_MIME_TYPES.has(normalized))) {
    return canonicalByExt;
  }
  if (trimmed) return trimmed;
  if (isImage) return `image/${ext === 'jpg' ? 'jpeg' : ext || 'png'}`;
  return 'application/octet-stream';
}

function stripFileExtension(name: string): string {
  const idx = name.lastIndexOf('.');
  return idx > 0 ? name.slice(0, idx) : name;
}

/** Match returned textbook nodes back to requested paths so skipped items never vanish silently. */
function findUnmatchedTextbookPaths(paths: string[], nodes: DstuNode[]): string[] {
  if (nodes.length === 0) return [...paths];
  const remainingNames = nodes.map((node) => node.name.trim().toLowerCase());
  const unmatched: string[] = [];
  for (const filePath of paths) {
    const fileName = extractDisplayFileName(filePath).trim().toLowerCase();
    const stem = stripFileExtension(fileName);
    const matchIndex = remainingNames.findIndex((name) => name === fileName || stripFileExtension(name) === stem);
    if (matchIndex >= 0) {
      remainingNames.splice(matchIndex, 1);
    } else {
      unmatched.push(filePath);
    }
  }
  return unmatched;
}

function canFallbackToVfsFile(ext: string): boolean {
  return ext !== 'pdf';
}

export interface ImportPathsContext {
  importProgress: Pick<ImportProgressState, 'isImporting'>;
  currentPath?: FinderPath;
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
    currentPath,
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
  const locks = getImportLocks(isMountedRef);
  if (importProgress.isImporting || locks.has('importPaths')) return;

  debugLog.log('[LearningHub] 导入文件:', paths.length, '个文件');

  // Markdown 本身就是笔记：任何位置拖入都导入为笔记（用笔记应用打开、可编辑），
  // 不再只在「笔记」视图才这样——在「全部文件」拖入会变成只读预览的资料
  const shouldImportMarkdownAsNotes = true;
  const preferVfsFilesView = currentPath?.typeFilter === 'file';

  // 按类型分组
  const docPaths: string[] = [];
  const imagePaths: string[] = [];
  const otherPaths: string[] = [];

  const guidanceNames: Record<'flashcards' | 'mindmap', string[]> = {
    flashcards: [],
    mindmap: [],
  };

  for (const p of paths) {
    const name = extractFileName(p);
    const ext = getFileExtension(name);
    const guidance = MODULE_GUIDANCE_EXTENSIONS[ext];
    if (guidance) {
      // ★ P3 引导：apkg/xmind 等不进资源库，提示到对应模块导入
      guidanceNames[guidance].push(name);
      continue;
    }
    const isMarkdown = ext === 'md' || ext === 'markdown';
    if (DOCUMENT_EXTENSIONS.has(ext)) {
      if (!isMarkdown && (preferVfsFilesView || !canParseAsMobileTextbook(ext))) {
        otherPaths.push(p);
      } else {
        docPaths.push(p);
      }
    } else if (IMAGE_EXTENSIONS.has(ext)) {
      imagePaths.push(p);
    } else {
      otherPaths.push(p);
    }
  }

  const format = resolveImportFormatOptions(t, i18n.language);

  if (guidanceNames.flashcards.length > 0) {
    showGlobalNotification('info', t('finder.dragDrop.guidanceFlashcards', {
      names: guidanceNames.flashcards.join(format.listSeparator),
    }));
  }
  if (guidanceNames.mindmap.length > 0) {
    showGlobalNotification('info', t('finder.dragDrop.guidanceMindmap', {
      names: guidanceNames.mindmap.join(format.listSeparator),
    }));
  }
  if (docPaths.length === 0 && imagePaths.length === 0 && otherPaths.length === 0) {
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
    (path) => extractFileName(path),
    shouldImportMarkdownAsNotes,
  );

  let totalSuccess = 0;
  let totalFailed = 0;
  let unlisten: UnlistenFn | null = null;
  let firstImportedNode: DstuNode | null = null;
  // ★ 2026-07-20：失败文件明细（文件名 + 具体原因），toast 不再只报笼统"导入失败"
  const failedDetails: { name: string; reason?: string }[] = [];
  // 后端按内容哈希去重：拖入已有的同一份文件会返回旧条目，不能报「已导入」
  const duplicateNames: string[] = [];
  const importStartedAt = Date.now();
  let textbookProgressStarted = false;
  let attachProgressStarted = false;
  locks.add('importPaths');

  try {
    const dropTargetFolderId = currentCreatableFolderId;

    if (markdownNotePaths.length > 0) {
      const markdownResult = await importMarkdownPathNotes(markdownNotePaths, dropTargetFolderId);

      totalSuccess += markdownResult.importedNodes.length;
      totalFailed += markdownResult.failedCount;
      firstImportedNode = markdownResult.importedNodes[0] ?? firstImportedNode;
      for (const failedFile of markdownResult.failedFiles ?? []) {
        failedDetails.push({
          name: failedFile,
          reason: markdownResult.firstError || undefined,
        });
      }
      if (markdownResult.failedCount > 0 && (markdownResult.failedFiles?.length ?? 0) === 0) {
        failedDetails.push({
          name: markdownNotePaths[0] ? extractDisplayFileName(markdownNotePaths[0]) : 'markdown',
          reason: markdownResult.firstError || undefined,
        });
      }

      if (markdownResult.importedNodes.length === 0 && markdownResult.failedCount > 0) {
        debugLog.error('[LearningHub] Markdown 笔记导入失败:', markdownResult.firstError);
      }
    }

    // 1. 文档类：通过 textbookDstuAdapter 导入（未接收的非 PDF 文档自动兜底进入 VFS 文件表）
    const fallbackAttachmentPaths: string[] = [];
    if (textbookPaths.length > 0) {
      const firstFileName = textbookPaths[0] ? extractDisplayFileName(textbookPaths[0]) : '';
      let lastTextbookError: string | undefined;
      textbookProgressStarted = true;
      setImportProgress({
        isImporting: true,
        fileName: firstFileName,
        stage: 'hashing',
        progress: 0,
      });

      // 监听后端进度事件
      unlisten = await listen<TextbookImportProgress>('textbook-import-progress', (event) => {
        const { file_name, stage, current_page, total_pages, progress, error: progressError } = event.payload;
        if (progressError) {
          lastTextbookError = progressError;
        }
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

      let docResult: Awaited<ReturnType<typeof textbookDstuAdapter.addTextbooks>>;
      try {
        docResult = await textbookDstuAdapter.addTextbooks(textbookPaths, dropTargetFolderId);
      } catch (addErr) {
        const message = addErr instanceof Error ? addErr.message : String(addErr);
        docResult = {
          ok: false,
          error: { toUserMessage: () => message },
        } as Awaited<ReturnType<typeof textbookDstuAdapter.addTextbooks>>;
      } finally {
        if (unlisten) { unlisten(); unlisten = null; }
      }

      if (docResult.ok) {
        const existing = docResult.value.filter((node) => node.createdAt < importStartedAt - 5_000);
        duplicateNames.push(...existing.map((node) => node.name));
        totalSuccess += docResult.value.length - existing.length;
        if (!firstImportedNode) {
          firstImportedNode = docResult.value[0] ?? null;
        }
        const skippedPaths = findUnmatchedTextbookPaths(textbookPaths, docResult.value);
        for (const skippedPath of skippedPaths) {
          const ext = getFileExtension(extractFileName(skippedPath));
          if (canFallbackToVfsFile(ext)) {
            fallbackAttachmentPaths.push(skippedPath);
          } else {
            totalFailed += 1;
            failedDetails.push({
              name: extractDisplayFileName(skippedPath),
              reason: lastTextbookError || t('finder.dragDrop.importFailed'),
            });
          }
        }
      } else {
        const reason = docResult.error.toUserMessage();
        debugLog.error('[LearningHub] 文档导入失败:', reason);
        for (const failedPath of textbookPaths) {
          const ext = getFileExtension(extractFileName(failedPath));
          if (canFallbackToVfsFile(ext)) {
            fallbackAttachmentPaths.push(failedPath);
          } else {
            totalFailed += 1;
            failedDetails.push({ name: extractDisplayFileName(failedPath), reason });
          }
        }
      }

      textbookProgressStarted = false;
      if (isMountedRef.current) {
        setImportProgress(prev => ({ ...prev, isImporting: false }));
      }
    }

    // 2. 图片类/其他文件（含被教材管道跳过的 Office/文本兜底）：通过 attachmentDstuAdapter 创建
    const attachmentPaths = [...imagePaths, ...otherPaths, ...fallbackAttachmentPaths];
    if (attachmentPaths.length > 0) {
      // ★ 由 Rust 直接把文件（含 Android content:// URI、含中文/空格的 Windows 路径）
      // 流式复制进暂存区，WebView 不再经手字节（旧路径 read_file_bytes → File →
      // base64 → JSON IPC，3 个并发的 200MB 文件在手机上会撑爆渲染进程）。
      const { stagePathUpload, abortStagedUpload, createByteBudgetLimiter } = await import('@/utils/stagedUpload');
      const { mimeTypeFromFileName } = await import('@/hooks/useTauriDragAndDrop');
      const limit = pLimit(3);
      // 后端创建时会把暂存文件整份读入内存：按字节预算串行化大文件
      const byteBudget = createByteBudgetLimiter(64 * 1024 * 1024);

      attachProgressStarted = true;
      setAttachImportProgress({ done: 0, total: attachmentPaths.length });

      const attachResults = await Promise.all(
        attachmentPaths.map((filePath) =>
          limit(async () => {
            const name = extractFileName(filePath);
            const ext = getFileExtension(name);
            const isImage = IMAGE_EXTENSIONS.has(ext);

            try {
              let staged: { uploadId: string; size: number };
              try {
                staged = await stagePathUpload(filePath);
              } catch (readError) {
                debugLog.error('[LearningHub] 读取文件失败:', name, readError);
                return { ok: false as const, name, reason: t('finder.dragDrop.readFileFailed') };
              }

              const mimeType = resolveUploadMimeType(name, mimeTypeFromFileName(name), isImage);

              let result;
              try {
                result = await byteBudget(staged.size, () => attachmentDstuAdapter.createFromStagedUpload(
                  { uploadId: staged.uploadId, name, mimeType, size: staged.size },
                  isImage ? 'image' : 'file',
                  dropTargetFolderId ? { folderId: dropTargetFolderId } : undefined,
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
              return { ok: true as const, name, node: result.value, isMedia: MEDIA_EXTENSIONS.has(ext) };
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

      attachProgressStarted = false;
      if (isMountedRef.current) {
        setAttachImportProgress(null);
      }

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
    const failedSummary = failedDetails.length > 0
      ? t('finder.dragDrop.importFailedFiles', {
          names: formatFailedImportSummary(failedDetails, format),
        })
      : undefined;
    const duplicateSummary = duplicateNames.length > 0
      ? t('finder.dragDrop.alreadyInLibrary', { names: duplicateNames.slice(0, 3).join(format.listSeparator) })
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
      await handleRefresh();
      if (isMountedRef.current && firstImportedNode) {
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
    debugLog.error('[LearningHub] 导入异常:', error);
    showGlobalNotification('error', t('finder.dragDrop.importFailed'));
  } finally {
    locks.delete('importPaths');
    if (unlisten) {
      unlisten();
      unlisten = null;
    }
    if (textbookProgressStarted && isMountedRef.current) {
      setImportProgress(prev => ({ ...prev, isImporting: false }));
    }
    if (attachProgressStarted && isMountedRef.current) {
      setAttachImportProgress(null);
    }
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
  onOpenApp?: LearningHubSidebarProps['onOpenApp'];
}

async function readBlobHeadBytes(blob: Blob): Promise<Uint8Array | null> {
  if (typeof blob.arrayBuffer === 'function') {
    return new Uint8Array(await blob.arrayBuffer());
  }
  if (typeof FileReader !== 'undefined') {
    return new Promise<Uint8Array | null>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => {
        resolve(reader.result instanceof ArrayBuffer ? new Uint8Array(reader.result) : null);
      };
      reader.onerror = () => resolve(null);
      reader.readAsArrayBuffer(blob);
    });
  }
  return null;
}

/**
 * 导入前快速校验空文件与明显损坏/截断的 PDF（避免静默丢弃或无报错失败）。
 * 返回本地化失败原因；校验通过返回 null。
 */
export async function validateImportFileObject(
  file: File,
  ext: string,
  t: SidebarT,
): Promise<string | null> {
  if (file.size === 0) {
    return t('finder.dragDrop.emptyFileReason', { defaultValue: '文件为空（0 字节）' });
  }
  if (ext === 'pdf') {
    if (file.size < 64) {
      return t('finder.dragDrop.corruptPdfReason', { defaultValue: 'PDF 文件已损坏或内容不完整' });
    }
    try {
      const slice = typeof file.slice === 'function' ? file.slice(0, 1024) : file;
      const bytes = await readBlobHeadBytes(slice);
      if (bytes) {
        let header = '';
        for (let i = 0; i < bytes.length; i += 1) {
          header += String.fromCharCode(bytes[i]);
        }
        if (!header.includes('%PDF-')) {
          return t('finder.dragDrop.corruptPdfReason', { defaultValue: 'PDF 文件已损坏或格式无效' });
        }
      }
    } catch {
      // 读取片段失败时交由后端处理，不在前置校验阶段误杀
    }
  }
  return null;
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
    onOpenApp,
  }: ImportDroppedFilesContext,
  files: File[],
  fromPicker = false,
): Promise<void> {
  if (files.length === 0) return;
  if (!fromPicker && consumePathsDropHandledFlag(pathsDropHandledRef)) {
    debugLog.log('[LearningHub] 跳过 files 回调，统一走 paths 导入链路');
    return;
  }
  if (!fromPicker && isDragDropBlockedView(currentPath)) {
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
  const format = resolveImportFormatOptions(t, i18n.language);

  if (guidanceNames.flashcards.length > 0) {
    showGlobalNotification('info', t('finder.dragDrop.guidanceFlashcards', {
      names: guidanceNames.flashcards.join(format.listSeparator),
    }));
  }
  if (guidanceNames.mindmap.length > 0) {
    showGlobalNotification('info', t('finder.dragDrop.guidanceMindmap', {
      names: guidanceNames.mindmap.join(format.listSeparator),
    }));
  }
  if (importableFiles.length === 0) return;

  const locks = getImportLocks(isMountedRef);
  if (locks.has('importDroppedFiles')) return;
  locks.add('importDroppedFiles');
  let attachProgressStarted = false;

  try {
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
    // On mobile each staged document is fully parsed in the Host, so consume one at a time.
    const limit = pLimit(fromPicker ? 1 : 3);
    let firstImportedNode: DstuNode | null = null;
    const failedDetails: { name: string; reason?: string }[] = [];

    if (markdownFiles.length > 0) {
      try {
        const markdownResult = await importMarkdownFileObjects(markdownFiles, currentCreatableFolderId);

        totalSuccess += markdownResult.importedNodes.length;
        totalFailed += markdownResult.failedCount;
        firstImportedNode = markdownResult.importedNodes[0] ?? null;
        for (const failedFile of markdownResult.failedFiles ?? []) {
          failedDetails.push({
            name: failedFile,
            reason: markdownResult.firstError || undefined,
          });
        }
        if (markdownResult.failedCount > 0 && (markdownResult.failedFiles?.length ?? 0) === 0) {
          failedDetails.push({
            name: markdownFiles[0]?.name ?? 'markdown',
            reason: markdownResult.firstError || undefined,
          });
        }
      } catch (e) {
        totalFailed += markdownFiles.length;
        const reason = e instanceof Error ? e.message : String(e);
        for (const mdFile of markdownFiles) {
          failedDetails.push({ name: mdFile.name, reason });
        }
      }
    }

    if (attachmentFiles.length > 0 && isMountedRef.current) {
      attachProgressStarted = true;
      setAttachImportProgress({ done: 0, total: attachmentFiles.length });
    }

    const preferVfsFilesView = currentPath.typeFilter === 'file';

    let results: Array<
      | { ok: true; name: string; node: DstuNode; isMedia: boolean }
      | { ok: false; name: string; reason?: string }
    >;
    try {
      results = await Promise.all(
        attachmentFiles.map((file) =>
          limit(async () => {
            const ext = getFileExtension(file.name);
            const isImage = IMAGE_EXTENSIONS.has(ext);
            const mimeType = resolveUploadMimeType(file.name, file.type, isImage);

            try {
              const invalidReason = await validateImportFileObject(file, ext, t);
              if (invalidReason) {
                return { ok: false as const, name: file.name, reason: invalidReason };
              }
              let textbookFailureReason: string | undefined;
              // 仅 PDF/EPUB 从「导入资料…」优先尝试教材解析；若浏览器/WebUI 环境未解析出教材条目，
              // 统一兜底写入 VFS files 表（前置已拦截 0 字节与损坏 PDF），绝不静默丢弃。
              const shouldTryTextbookImport =
                fromPicker && !preferVfsFilesView && (ext === 'pdf' || ext === 'epub') && canParseAsMobileTextbook(ext);
              if (shouldTryTextbookImport) {
                try {
                  const result = await withStagedTextbookFile(file, (source) =>
                    textbookDstuAdapter.addTextbooks([source], currentCreatableFolderId));
                  if (result.ok && result.value[0]) {
                    return { ok: true as const, name: file.name, node: result.value[0], isMedia: false };
                  }
                  textbookFailureReason = result.ok
                    ? t('finder.dragDrop.importFailed')
                    : result.error.toUserMessage();
                } catch (stageErr) {
                  textbookFailureReason = stageErr instanceof Error ? stageErr.message : String(stageErr);
                }
              }
              // ★ 2026-06-12（审阅问题 FE-M1）：传递当前文件夹 ID，并补齐扩展名对应的 MIME（避免浏览器空/通用 type 落盘失败）
              const result = await attachmentDstuAdapter.create(
                file, isImage ? 'image' : 'file',
                {
                  ...(currentCreatableFolderId ? { folderId: currentCreatableFolderId } : {}),
                  mimeType,
                },
              );
              if (!result.ok) {
                return {
                  ok: false as const,
                  name: file.name,
                  reason: result.error.toUserMessage() || textbookFailureReason,
                };
              }
              return { ok: true as const, name: file.name, node: result.value, isMedia: MEDIA_EXTENSIONS.has(ext) };
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
    } finally {
      if (attachProgressStarted) {
        attachProgressStarted = false;
        if (isMountedRef.current) {
          setAttachImportProgress(null);
        }
      }
    }

    for (const r of results) {
      if (r.ok) totalSuccess++;
      else {
        totalFailed++;
        failedDetails.push({ name: r.name, reason: 'reason' in r ? r.reason : undefined });
      }
    }

    // ★ 失败时附具体文件与原因（最多 3 条），不再只报笼统"导入失败"
    const failedSummary = failedDetails.length > 0
      ? t('finder.dragDrop.importFailedFiles', {
          names: formatFailedImportSummary(failedDetails, format),
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
      await handleRefresh();
      if (isMountedRef.current) {
        if (firstImportedNode) openImportedMarkdownNote(firstImportedNode);
        else if (fromPicker && onOpenApp) {
          const firstPreview = results.find((entry) => entry.ok && (entry.node.type === 'textbook' || entry.isMedia));
          if (firstPreview?.ok) {
            onOpenApp(dstuNodeToResourceListItem(firstPreview.node, firstPreview.node.type === 'textbook' ? 'textbook' : 'file'));
          }
        }
      }
    }
  } finally {
    locks.delete('importDroppedFiles');
    if (attachProgressStarted && isMountedRef.current) {
      setAttachImportProgress(null);
    }
  }
}
