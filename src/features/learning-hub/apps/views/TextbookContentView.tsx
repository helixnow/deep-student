/**
 * TextbookContentView - 教材内容视图
 *
 * 统一应用面板中的教材阅读视图。
 * 根据 previewType 路由到不同的预览组件：
 * - pdf: PDF 查看器
 * - docx: DOCX 富文本预览
 * - xlsx: Excel 表格预览
 * - text: 纯文本预览
 * 
 * 元数据字段：
 * - filePath: string - 文件路径
 * - readingProgress: { page: number; lastReadAt?: number } - 阅读进度（PDF专用）
 * - pageCount: number - 总页数
 */

import React, { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { CircleNotch } from '@phosphor-icons/react';
import { TextbookPdfViewer, type ReadingProgress, type Bookmark } from '@/features/pdf/components/TextbookPdfViewer';
import type { ContentViewProps } from '../UnifiedAppPanel';
import { getErrorMessage } from '@/utils/errorUtils';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { invoke } from '@tauri-apps/api/core';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { usePdfLoader } from '@/hooks/usePdfLoader';
import {
  estimateBase64Size,
  LARGE_FILE_THRESHOLD,
  uint8ArrayToBase64,
} from '@/utils/base64FileUtils';
import { PreviewProvider, usePreviewContext } from './PreviewContext';
import type { ToolbarPreviewType } from './UnifiedPreviewToolbar';
import { resolveTextbookPreviewType } from './textbookPreviewResolver';
import { RichDocumentPreview } from './RichDocumentPreview';
import { TextFilePreview } from './TextFilePreview';
import EpubPreview from './EpubPreview';
import { loadTextPreviewContent } from './textPreviewLoader';
import { usePdfFocusListener } from './usePdfFocusListener';
import { PreviewStatus } from './PreviewStatus';
import { createPreviewPersistController } from './previewPersistence';
import { useReferenceToChat } from '@/features/learning-hub/useReferenceToChat';
import {
  buildSelectionLocator,
  type PdfSelectionPayload,
} from '@/features/pdf/pdfSelectionActions';

const toToolbarPreviewType = (type: string | null): ToolbarPreviewType => {
  if (type === 'docx' || type === 'xlsx' || type === 'pptx' || type === 'text') {
    return type;
  }
  return 'other' as const;
};

// ★ 模块级定义，保持组件身份跨渲染稳定（避免作为 Suspense fallback 时被反复重挂载）
const LoadingSpinner: React.FC = () => {
  const { t } = useTranslation('common');
  return (
    <div className="flex items-center justify-center h-full" role="status" aria-label={t('loading')}>
      <CircleNotch className="h-8 w-8 animate-spin text-primary" aria-hidden="true" />
    </div>
  );
};

/**
 * 教材内容视图
 */
const TextbookContentViewInner: React.FC<ContentViewProps> = ({
  node,
  isActive,
}) => {
  const { t } = useTranslation(['textbook', 'common', 'learningHub', 'pdf']);
  const {
    zoomScale,
    fontScale,
    previewType,
    setZoomScale,
    setFontScale,
    resetZoom,
    resetFont,
    setPreviewType,
  } = usePreviewContext();

  // 页面选择状态
  const [selectedPages, setSelectedPages] = useState<Set<number>>(new Set());

  // ★ 追踪最新值的 ref（persist controller merge 用）
  const nodePathRef = useRef(node.path);
  const nodeIdRef = useRef(node.id);
  const nodeMetadataRef = useRef(node.metadata);

  // 同步最新值到 ref
  useEffect(() => {
    nodePathRef.current = node.path;
    nodeIdRef.current = node.id;
    nodeMetadataRef.current = node.metadata;
  }, [node.path, node.id, node.metadata]);

  const persistControllerRef = useRef(
    createPreviewPersistController(
      {
        kind: 'textbook',
        nodeId: node.id,
        nodePath: node.path,
        // ★ 创建时快照：控制器内部只提取 readingProgress/bookmarks 白名单字段，
        // dispose flush 不回读活 ref（避免 node 切换后串写新节点数据）
        metadata: node.metadata as Record<string, unknown> | undefined,
      },
      {
        onBookmarksError: (err) => {
          console.error('[TextbookContentView] Failed to save bookmarks:', err);
          showGlobalNotification('error', t('textbook:bookmarkSaveFailed'));
        },
      },
    ),
  );
  
  // 非 PDF 文件的内容状态（富文档为 base64；text 模式为已解码/提取后的文本）
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [contentLoading, setContentLoading] = useState(false);
  const [contentError, setContentError] = useState<string | null>(null);
  
  // ★ 非 PDF 内容重新加载的触发计数器
  const [contentRetryCount, setContentRetryCount] = useState(0);

  // ★ PDF 初始态 spinner 超时检测（防止无限旋转）
  const [pdfInitTimedOut, setPdfInitTimedOut] = useState(false);

  // ★ 非 PDF 内容加载超时检测（同 PDF 初始态：避免 invoke 挂起时用户被困在 spinner）
  const [contentLoadTimedOut, setContentLoadTimedOut] = useState(false);

  // 从 node.metadata 提取书签列表（声明提前到渲染期重置块之前）
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);

  // 处理页面选择变化 + 广播给 Chat InputBar
  const handlePageSelectionChange = useCallback((pages: Set<number>) => {
    setSelectedPages(pages);
    // 广播选中页码到 Chat InputBar（通过自定义 DOM 事件）
    document.dispatchEvent(new CustomEvent('pdf-page-refs:update', {
      detail: {
        sourceId: node.sourceId,
        sourceName: node.name,
        pages: Array.from(pages).sort((a, b) => a - b),
      },
    }));
  }, [node.sourceId, node.name]);

  // 监听 Chat 侧发来的清除/移除选择事件
  // ★ 标签页：通过 sourceId 过滤，避免多个 PDF tab 互相干扰
  useEffect(() => {
    const handleClear = (event: Event) => {
      const detail = (event as CustomEvent<{ sourceId?: string }>).detail;
      if (detail?.sourceId && detail.sourceId !== node.sourceId) return;
      setSelectedPages(new Set());
    };
    const handleRemove = (event: Event) => {
      const detail = (event as CustomEvent<{ page: number; sourceId?: string }>).detail;
      if (detail?.sourceId && detail.sourceId !== node.sourceId) return;
      setSelectedPages((prev) => {
        const next = new Set(prev);
        next.delete(detail.page);
        return next;
      });
    };
    document.addEventListener('pdf-page-refs:clear', handleClear);
    document.addEventListener('pdf-page-refs:remove', handleRemove);
    return () => {
      document.removeEventListener('pdf-page-refs:clear', handleClear);
      document.removeEventListener('pdf-page-refs:remove', handleRemove);
      // ★ 卸载（关闭 tab）时广播空选择，避免聊天 chips 残留指向已关闭的 PDF
      document.dispatchEvent(new CustomEvent('pdf-page-refs:update', {
        detail: { sourceId: node.sourceId, sourceName: '', pages: [] },
      }));
    };
  }, [node.sourceId]);

  // 处理导出选中页面（已废弃，保留空回调以兼容 TextbookPdfViewer 接口）
  const handleExportSelectedPages = useCallback(() => {}, []);

  // 从 node.metadata.filePath 获取文件路径
  const filePath = node.metadata?.filePath as string | undefined;
  // ★ 2026-06-12（审阅问题 R1/R4）：filePathStat.path 记录实际可用的路径。
  // original_path 失效时回退到 VFS blob 文件（导入时已复制），
  // PDF 继续走 pdfstream:// 流式加载而非整文件 base64 过 IPC。
  const [filePathStat, setFilePathStat] = useState<{ available: boolean; size?: number; path?: string } | null>(
    filePath ? { available: true, path: filePath } : { available: false }
  );
  // ★ 2026-06-12（审阅 UI/UX）：文件失联后的"重新关联"支持
  const [relinkTick, setRelinkTick] = useState(0);
  const [isRelinking, setIsRelinking] = useState(false);
  // ★ 不支持预览的文件用系统默认应用打开（避免死胡同）
  const [isOpeningExternal, setIsOpeningExternal] = useState(false);

  // ★ 同一挂载实例可能收到不同的 node（UnifiedAppPanel 未按 node.id 加 key）。
  // 渲染期重置派生状态，避免旧节点的内容/错误/选页/路径探测结果泄漏到新节点
  // （例如旧 docx 的 contentError 会让新打开的 PDF 直接显示错误态）。
  const [prevNodeId, setPrevNodeId] = useState(node.id);
  if (prevNodeId !== node.id) {
    setPrevNodeId(node.id);
    setSelectedPages(new Set());
    setFileContent(null);
    setContentError(null);
    setContentLoading(false);
    setPdfInitTimedOut(false);
    setContentLoadTimedOut(false);
    setFilePathStat(filePath ? { available: true, path: filePath } : { available: false });
    // ★ 书签也在渲染期同步重置，避免新节点首帧短暂显示旧节点书签
    const nextBookmarks = node.metadata?.bookmarks as Bookmark[] | undefined;
    setBookmarks(Array.isArray(nextBookmarks) ? nextBookmarks : []);
  }
  
  // 根据 previewType 确定渲染模式（优先使用数据库值，若为 none 则根据扩展名推断）
  const resolvedPreviewType = resolveTextbookPreviewType(node.previewType, node.name);
  const isPdf = resolvedPreviewType === 'pdf';
  const isDocx = resolvedPreviewType === 'docx';
  const isXlsx = resolvedPreviewType === 'xlsx';
  const isPptx = resolvedPreviewType === 'pptx';
  const isEpub = resolvedPreviewType === 'epub';
  const isText = resolvedPreviewType === 'text';
  const isUnsupported = resolvedPreviewType === 'none';
  const needsFileContent = isDocx || isXlsx || isPptx || isEpub || isText;

  // ★ 使用共享 Hook 监听 PDF 页码跳转事件
  const [focusRequest, handleFocusHandled] = usePdfFocusListener({
    enabled: isPdf,
    nodeId: node.id,
    nodeSourceId: node.sourceId,
    nodePath: node.path,
    nodeName: node.name,
  });

  useEffect(() => {
    const contextPreviewType = (isDocx || isXlsx || isPptx || isText)
      ? resolvedPreviewType
      : null;
    setPreviewType(contextPreviewType);
  }, [isDocx, isPptx, isText, isXlsx, resolvedPreviewType, setPreviewType]);

  // 校验 filePath 是否可访问（用于失效回退）
  // #59: PDF 走 pdfstream:// 协议加载，探测必须使用与协议一致的白名单规则，
  // 否则 get_file_size 成功但实际加载 403，且永远不会回退到数据库。
  useEffect(() => {
    let isActive = true;
    const checkPdfStreamAccess = async (candidate: string) => {
      try {
        return await invoke<{ available: boolean; size?: number; reason?: string }>(
          'pdfstream_check_access',
          { path: candidate }
        );
      } catch {
        return { available: false } as { available: boolean; size?: number; reason?: string };
      }
    };

    const checkFilePath = async () => {
      try {
        if (isPdf) {
          // 1. 优先尝试 original_path
          if (filePath) {
            const access = await checkPdfStreamAccess(filePath);
            if (!isActive) return;
            if (access.available) {
              setFilePathStat({ available: true, size: access.size, path: filePath });
              return;
            }
            console.warn(
              '[TextbookContentView] filePath not streamable, trying VFS blob:',
              filePath,
              access.reason
            );
          }

          // 2. ★ 回退到 VFS blob 文件（导入时复制的内容副本）
          try {
            const blobPath = await invoke<string | null>('vfs_get_file_blob_path', { id: node.id });
            if (!isActive) return;
            if (blobPath) {
              const access = await checkPdfStreamAccess(blobPath);
              if (!isActive) return;
              if (access.available) {
                setFilePathStat({ available: true, size: access.size, path: blobPath });
                return;
              }
            }
          } catch (blobErr: unknown) {
            console.warn('[TextbookContentView] blob path lookup failed:', blobErr);
          }

          if (!isActive) return;
          setFilePathStat({ available: false });
          return;
        }

        if (!filePath) {
          setFilePathStat({ available: false });
          return;
        }

        const size = await invoke<number>('get_file_size', { path: filePath });
        if (!isActive) return;
        setFilePathStat({ available: true, size, path: filePath });
      } catch (err: unknown) {
        if (!isActive) return;
        console.warn('[TextbookContentView] filePath not accessible, fallback to DB:', filePath, err);
        setFilePathStat({ available: false });
      }
    };

    void checkFilePath();
    return () => {
      isActive = false;
    };
  }, [filePath, isPdf, node.id, relinkTick]);

  const effectiveFilePath = filePathStat?.available ? (filePathStat.path ?? filePath) : undefined;
  const effectiveFileSize = filePathStat?.available ? filePathStat.size : undefined;

  // 使用统一的 PDF 加载 Hook（支持缓存、去重、大文件检测）
  const {
    file: pdfFile,
    loading: pdfLoading,
    error: pdfError,
    isLargeFile: isPdfLargeFile,
    retry: retryPdfLoad,
  } = usePdfLoader({
    nodeId: node.id,
    fileName: node.name,
    filePath: effectiveFilePath,
    cacheKey: `${node.id}:${node.updatedAt || ''}`,
    enabled: isPdf && !effectiveFilePath, // 只有当是 PDF 且没有可用 filePath 时才从数据库加载
  });
  
  // 加载非 PDF 文件内容
  useEffect(() => {
    if (!needsFileContent) return;
    
    let isMounted = true;
    setContentLoading(true);
    setContentError(null);
    
    const loadContent = async () => {
      try {
        // ★ text 模式：走后端 DocumentParser 提取（epub/xls/ods/rtf/html）或 UTF-8 解码，
        // 避免对二进制格式直接 decodeBase64ToText 产生乱码。
        if (isText) {
          let rawBase64: string | null = null;

          if (effectiveFilePath) {
            try {
              const fileSize = effectiveFileSize ?? await invoke<number>('get_file_size', { path: effectiveFilePath });
              if (!isMounted) return;
              if (fileSize > LARGE_FILE_THRESHOLD) {
                setContentError(t('learningHub:file.previewTooLarge'));
                setContentLoading(false);
                return;
              }
              const buffer = await invoke<ArrayBuffer>('read_file_bytes', { path: effectiveFilePath });
              if (!isMounted) return;
              rawBase64 = uint8ArrayToBase64(new Uint8Array(buffer));
            } catch (err: unknown) {
              console.warn('[TextbookContentView] Failed to read filePath for text preview, fallback to VFS:', err);
            }
          }

          if (!rawBase64) {
            const result = await invoke<{ content: string | null; found: boolean }>('vfs_get_attachment_content', {
              attachmentId: node.id,
              maxBytes: LARGE_FILE_THRESHOLD,
            });
            if (!isMounted) return;
            if (result?.found && result?.content) {
              const estimatedSize = estimateBase64Size(result.content);
              if (estimatedSize > LARGE_FILE_THRESHOLD) {
                setContentError(t('learningHub:file.previewTooLarge'));
                setContentLoading(false);
                return;
              }
              rawBase64 = result.content;
            }
          }

          const text = await loadTextPreviewContent({
            nodeId: node.id,
            fileName: node.name,
            rawBase64,
          });

          if (!isMounted) return;
          // ★ 空字符串是合法内容（空文件），只有 null 才代表"未找到"（与 FileContentView 一致）
          if (text !== null) {
            setFileContent(text);
            setContentLoading(false);
          } else {
            setContentError(t('learningHub:file.contentNotFound', { id: node.id }));
            setContentLoading(false);
          }
          return;
        }

        let base64Content: string | null = null;
        const knownSize = typeof node.size === 'number' ? node.size : null;
        if (knownSize && knownSize > LARGE_FILE_THRESHOLD) {
          setContentError(t('learningHub:file.previewTooLarge'));
          setContentLoading(false);
          return;
        }

        // ★ 用标记区分"内容过大"与"内容不存在"，避免外层用"未找到文件内容"覆盖"文件过大"错误
        let vfsContentTooLarge = false;
        const loadFromVfs = async () => {
          const result = await invoke<{ content: string | null; found: boolean }>('vfs_get_attachment_content', {
            attachmentId: node.id,
            maxBytes: LARGE_FILE_THRESHOLD,
          });
          if (!isMounted) return null;

          if (result?.found && result?.content) {
            const estimatedSize = estimateBase64Size(result.content);
            if (estimatedSize > LARGE_FILE_THRESHOLD) {
              vfsContentTooLarge = true;
              return null;
            }
            return result.content;
          }
          return null;
        };
        
        // ★ 优先使用可用的 filePath 读取本地文件，失败则回退到 VFS
        if (effectiveFilePath) {
          try {
            const fileSize = effectiveFileSize ?? await invoke<number>('get_file_size', { path: effectiveFilePath });
            if (!isMounted) return;
            if (fileSize > LARGE_FILE_THRESHOLD) {
              setContentError(t('learningHub:file.previewTooLarge'));
              setContentLoading(false);
              return;
            }

            const buffer = await invoke<ArrayBuffer>('read_file_bytes', { path: effectiveFilePath });
            if (!isMounted) return;
            // 转换为 base64（分块，避免大数组字符串拼接造成卡顿）
            base64Content = uint8ArrayToBase64(new Uint8Array(buffer));
          } catch (err: unknown) {
            console.warn('[TextbookContentView] Failed to read filePath, fallback to VFS:', err);
            if (!isMounted) return;
            base64Content = await loadFromVfs();
          }
        } else {
          base64Content = await loadFromVfs();
        }
        
        if (!isMounted) return;
        if (base64Content) {
          setFileContent(base64Content);
          setContentLoading(false);
        } else {
          setContentError(vfsContentTooLarge
            ? t('learningHub:file.previewTooLarge')
            : t('learningHub:file.contentNotFound', { id: node.id }));
          setContentLoading(false);
        }
      } catch (err: unknown) {
        console.error('[TextbookContentView] Failed to load file:', err);
        if (isMounted) {
          setContentError(err instanceof Error ? err.message : t('learningHub:file.loadFailed'));
          setContentLoading(false);
        }
      }
    };
    
    void loadContent();
    
    return () => {
      isMounted = false;
    };

  }, [needsFileContent, isText, effectiveFilePath, effectiveFileSize, node.id, node.name, node.size, t, contentRetryCount]);
  
  // 从 node.metadata 提取阅读进度
  const readingProgress = useMemo<ReadingProgress | undefined>(() => {
    const progress = node.metadata?.readingProgress as { page?: number; lastReadAt?: number } | undefined;
    if (progress && typeof progress.page === 'number' && progress.page > 0) {
      return {
        page: progress.page,
        lastReadAt: progress.lastReadAt,
      };
    }
    return undefined;
  }, [node.metadata?.readingProgress]);
  
  // 初始化书签数据
  useEffect(() => {
    const savedBookmarks = node.metadata?.bookmarks as Bookmark[] | undefined;
    if (savedBookmarks && Array.isArray(savedBookmarks)) {
      setBookmarks(savedBookmarks);
    } else {
      setBookmarks([]);
    }
  }, [node.metadata?.bookmarks]);

  const handleProgressChange = useCallback((progress: ReadingProgress) => {
    persistControllerRef.current.scheduleProgress(progress);
  }, []);

  const handleBookmarksChange = useCallback((newBookmarks: Bookmark[]) => {
    setBookmarks(newBookmarks);
    persistControllerRef.current.scheduleBookmarks(newBookmarks);
  }, []);

  // 划词「引用到对话」：selectedText + 页码 locator 随资源引用进入会话上下文
  const { referenceToChat } = useReferenceToChat();
  const handleQuoteToChat = useCallback((payload: PdfSelectionPayload) => {
    void referenceToChat({
      sourceType: 'textbook',
      sourceId: node.sourceId || node.id,
      metadata: {
        title: node.name,
        selectedText: payload.text,
        locator: buildSelectionLocator(payload.page),
      },
    });
  }, [referenceToChat, node.sourceId, node.id, node.name]);

  // ★ node 切换 / unmount：flush 旧控制器再换新（避免串写邻文档）。
  // 旧控制器 dispose 用的是它创建时的快照；新控制器在 refs 同步 effect
  // 之后创建，此时 ref 已指向新 node 的 metadata。
  useEffect(() => {
    persistControllerRef.current.dispose();
    persistControllerRef.current = createPreviewPersistController(
      {
        kind: 'textbook',
        nodeId: nodeIdRef.current,
        nodePath: nodePathRef.current,
        metadata: nodeMetadataRef.current as Record<string, unknown> | undefined,
      },
      {
        onBookmarksError: (err) => {
          console.error('[TextbookContentView] Failed to save bookmarks:', err);
          showGlobalNotification('error', t('textbook:bookmarkSaveFailed'));
        },
      },
    );
    return () => {
      persistControllerRef.current.dispose();
    };
  }, [node.id]);

  // ★ 非 PDF 文件重试加载
  const retryContentLoad = useCallback(() => {
    setFileContent(null);
    setContentError(null);
    setContentLoadTimedOut(false);
    setContentRetryCount((c) => c + 1);
  }, []);

  // ★ 2026-06-12（审阅 UI/UX）：原文件失联时让用户挑选新位置重新关联。
  // 后端 textbooks_relink 校验 SHA-256 一致后更新 original_path 并自愈 blob。
  const handleRelink = useCallback(async () => {
    setIsRelinking(true);
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const ext = node.name.includes('.') ? node.name.split('.').pop()?.toLowerCase() : undefined;
      const selected = await open({
        multiple: false,
        title: t('textbook:relink.dialogTitle'),
        filters: ext ? [{ name: node.name, extensions: [ext] }] : undefined,
      });
      if (!selected || typeof selected !== 'string') return;

      await invoke('textbooks_relink', { id: node.id, newPath: selected });
      showGlobalNotification('success', t('textbook:relink.success'));
      setRelinkTick((c) => c + 1);
    } catch (err: unknown) {
      showGlobalNotification('error', getErrorMessage(err), t('textbook:relink.failed'));
    } finally {
      setIsRelinking(false);
    }
  }, [node.id, node.name, t]);

  // ★ 用系统默认应用打开原文件（不支持预览类型的逃生出口）
  const handleOpenExternal = useCallback(async (path: string) => {
    setIsOpeningExternal(true);
    try {
      const { openPath } = await import('@tauri-apps/plugin-opener');
      await openPath(path);
    } catch (err: unknown) {
      showGlobalNotification('error', getErrorMessage(err));
    } finally {
      setIsOpeningExternal(false);
    }
  }, []);

  const relinkAction = {
    id: 'relink',
    label: t('textbook:relink.action'),
    onClick: () => { void handleRelink(); },
    variant: 'default' as const,
    loading: isRelinking,
  };

  // ★ PDF 初始态 spinner 超时检测（10 秒后显示提示 + 重试按钮，避免无限旋转）
  useEffect(() => {
    if (!isPdf || effectiveFilePath || pdfFile || pdfLoading || pdfError) {
      setPdfInitTimedOut(false);
      return;
    }
    const timer = window.setTimeout(() => {
      setPdfInitTimedOut(true);
    }, 10_000);
    return () => window.clearTimeout(timer);
  }, [isPdf, effectiveFilePath, pdfFile, pdfLoading, pdfError]);

  // ★ 非 PDF 内容加载超时检测（读文件 / VFS invoke 挂起时给用户重试出口）
  useEffect(() => {
    if (!needsFileContent || fileContent || contentError || !contentLoading) {
      setContentLoadTimedOut(false);
      return;
    }
    const timer = window.setTimeout(() => {
      setContentLoadTimedOut(true);
    }, 10_000);
    return () => window.clearTimeout(timer);
  }, [needsFileContent, fileContent, contentError, contentLoading, contentRetryCount]);

  // 非 PDF 内容首次加载视图（超时后显示提示 + 重试/重新关联按钮，与 PDF 初始态一致）
  const contentLoadingView = (
    <PreviewStatus
      tone="loading"
      title={t('common:loading')}
      description={contentLoadTimedOut ? t('textbook:loading.timeout') : undefined}
      actions={
        contentLoadTimedOut
          ? [
              { id: 'retry', label: t('common:retry'), onClick: retryContentLoad, variant: 'default' },
              relinkAction,
            ]
          : undefined
      }
    />
  );

  // ★ 移除 filePath 为空时的硬性错误，改为在内容加载失败时显示错误
  // 因为从 attachments 迁移的文件可能没有 filePath，但可以通过 vfs_get_attachment_content 获取内容
  
  // PDF 文件：如果没有 filePath 且没有 pdfFile，显示加载中或错误
  if (isPdf && !effectiveFilePath && !pdfFile) {
    if (pdfLoading) {
      return (
        <PreviewStatus
          tone="loading"
          title={t('common:loading')}
          description={isPdfLargeFile ? t('textbook:loading.largeFile') : undefined}
        />
      );
    }
    if (pdfError) {
      return (
        <PreviewStatus
          tone="error"
          title={pdfError}
          description={t('textbook:relink.hint')}
          actions={[
            { id: 'retry', label: t('common:retry'), onClick: retryPdfLoad, variant: 'default' },
            relinkAction,
          ]}
        />
      );
    }
    // 初始状态，等待加载（超时后显示提示 + 重试按钮）
    return (
      <PreviewStatus
        tone="loading"
        title={t('common:loading')}
        description={pdfInitTimedOut ? t('textbook:loading.timeout') : undefined}
        actions={
          pdfInitTimedOut
            ? [
                { id: 'retry', label: t('common:retry'), onClick: retryPdfLoad, variant: 'default' },
                relinkAction,
              ]
            : undefined
        }
      />
    );
  }
  
  // 错误状态
  if (contentError) {
    return (
      <PreviewStatus
        tone="error"
        title={contentError}
        actions={[
          { id: 'retry', label: t('common:retry'), onClick: retryContentLoad, variant: 'default' },
          relinkAction,
        ]}
      />
    );
  }
  
  const showRichToolbar = (isDocx || isXlsx || isPptx) && !!fileContent && !!previewType;
  const renderRichDocumentPreview = (
    kind: 'docx' | 'xlsx' | 'pptx',
    content: string
  ) => (
    <RichDocumentPreview
      kind={kind}
      base64Content={content}
      fileName={node.name}
      showToolbar={showRichToolbar}
      previewType={toToolbarPreviewType(previewType)}
      zoomScale={zoomScale}
      fontScale={fontScale}
      onZoomChange={setZoomScale}
      onFontChange={setFontScale}
      onZoomReset={resetZoom}
      onFontReset={resetFont}
      fallback={<LoadingSpinner />}
      rootClassName="bg-background"
    />
  );

  // ★ stale-while-revalidate：同一节点重新加载（如重新关联后刷新）时保留已渲染内容，
  // 仅在完全没有内容时显示加载视图；节点切换时 fileContent 已在渲染期重置为 null，不会串文档。

  // DOCX 预览
  if (isDocx) {
    if (!fileContent) {
      return contentLoadingView;
    }
    return renderRichDocumentPreview('docx', fileContent);
  }
  
  // XLSX 预览
  if (isXlsx) {
    if (!fileContent) {
      return contentLoadingView;
    }
    return renderRichDocumentPreview('xlsx', fileContent);
  }
  
  // PPTX 预览
  if (isPptx) {
    if (!fileContent) {
      return contentLoadingView;
    }
    return renderRichDocumentPreview('pptx', fileContent);
  }

  if (isEpub) {
    if (!fileContent) {
      return contentLoadingView;
    }
    return (
      <EpubPreview
        base64Content={fileContent}
        fileName={node.name}
        resourceId={node.id}
        metadataProgress={readingProgress}
        onProgressChange={handleProgressChange}
        isActive={isActive}
      />
    );
  }

  // 纯文本预览
  if (isText) {
    // ★ 空字符串是合法内容（空文件），由 TextFilePreview 渲染空状态；仅 null 表示仍在加载
    if (fileContent === null) {
      return contentLoadingView;
    }
    return (
      <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
        {/* orientation="both"：代码类（whitespace-pre）/CSV 表格（w-max）会横向溢出，
            仅纵向滚动时溢出内容不可达（窄屏尤甚）；真实 overflow-x:auto 同时让
            三屏手势豁免逻辑正确识别横向可滚动容器 */}
        <CustomScrollArea className="min-h-0 flex-1" orientation="both">
          <TextFilePreview content={fileContent} fileName={node.name} />
        </CustomScrollArea>
      </div>
    );
  }
  
  // 不支持预览的文件类型（如 PPTX）
  if (isUnsupported) {
    // 从文件名获取扩展名
    const ext = node.name.split('.').pop()?.toUpperCase() || '';
    return (
      <PreviewStatus
        tone="empty"
        icon="file"
        title={node.name}
        description={t('learningHub:textbook.unsupportedPreview', { ext })}
        actions={
          effectiveFilePath
            ? [{
                id: 'openExternal',
                label: t('common:openExternal'),
                onClick: () => { void handleOpenExternal(effectiveFilePath); },
                variant: 'default',
                loading: isOpeningExternal,
              }]
            : undefined
        }
      />
    );
  }

  // PDF 预览
  // 优先使用 filePath（本地文件），否则使用从数据库加载的 pdfFile
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
      <TextbookPdfViewer
        file={pdfFile}
        filePath={effectiveFilePath || ''}
        fileName={node.name}
        selectedPages={selectedPages}
        onPageSelectionChange={handlePageSelectionChange}
        onExportSelectedPages={handleExportSelectedPages}
        focusRequest={focusRequest}
        onFocusHandled={handleFocusHandled}
        readingProgress={readingProgress}
        onProgressChange={handleProgressChange}
        resourcePath={node.path}
        bookmarks={bookmarks}
        onBookmarksChange={handleBookmarksChange}
        onQuoteToChat={handleQuoteToChat}
      />
    </div>
  );
};

const TextbookContentView: React.FC<ContentViewProps> = (props) => (
  <PreviewProvider>
    <TextbookContentViewInner {...props} />
  </PreviewProvider>
);

export default TextbookContentView;
