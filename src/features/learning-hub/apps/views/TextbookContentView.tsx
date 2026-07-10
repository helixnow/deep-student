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
import { WarningCircle, FileText, CircleNotch, ArrowClockwise, LinkSimple, ArrowSquareOut } from '@phosphor-icons/react';
import { NotionButton } from '@/components/ui/NotionButton';
import { TextbookPdfViewer, type ReadingProgress, type Bookmark } from '@/features/pdf/components/TextbookPdfViewer';
import type { ContentViewProps } from '../UnifiedAppPanel';
import { dstu } from '@/dstu';
import { reportError } from '@/shared/result';
import { getErrorMessage } from '@/utils/errorUtils';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { invoke } from '@tauri-apps/api/core';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { vfsFileApi } from '@/api/vfsFileApi';
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
import { loadTextPreviewContent } from './textPreviewLoader';
import { usePdfFocusListener } from './usePdfFocusListener';

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
    <div className="flex items-center justify-center h-full" role="status" aria-label={t('loading', '加载中...')}>
      <CircleNotch className="h-8 w-8 animate-spin text-primary" aria-hidden="true" />
    </div>
  );
};

/**
 * 教材内容视图
 */
const TextbookContentViewInner: React.FC<ContentViewProps> = ({
  node,
}) => {
  const { t } = useTranslation(['textbook', 'common', 'learningHub']);
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

  // 保存进度的防抖引用
  const saveProgressTimerRef = useRef<number | null>(null);

  // ★ 追踪最新值的 ref（用于 cleanup flush，避免闭包捕获过期值）
  const nodePathRef = useRef(node.path);
  const nodeIdRef = useRef(node.id);
  const nodeMetadataRef = useRef(node.metadata);
  const pendingProgressRef = useRef<ReadingProgress | null>(null);
  const pendingBookmarksRef = useRef<Bookmark[] | null>(null);

  // 同步最新值到 ref
  useEffect(() => {
    nodePathRef.current = node.path;
    nodeIdRef.current = node.id;
    nodeMetadataRef.current = node.metadata;
  }, [node.path, node.id, node.metadata]);
  
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
  const isText = resolvedPreviewType === 'text';
  const isUnsupported = resolvedPreviewType === 'none';
  const needsFileContent = isDocx || isXlsx || isPptx || isText;

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
                setContentError(t('learningHub:file.previewTooLarge', '文件过大，无法预览'));
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
            });
            if (!isMounted) return;
            if (result?.found && result?.content) {
              const estimatedSize = estimateBase64Size(result.content);
              if (estimatedSize > LARGE_FILE_THRESHOLD) {
                setContentError(t('learningHub:file.previewTooLarge', '文件过大，无法预览'));
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
          if (text) {
            setFileContent(text);
            setContentLoading(false);
          } else {
            setContentError(t('learningHub:file.contentNotFound', '未找到文件内容 (id: {{id}})', { id: node.id }));
            setContentLoading(false);
          }
          return;
        }

        let base64Content: string | null = null;
        const knownSize = typeof node.size === 'number' ? node.size : null;
        if (knownSize && knownSize > LARGE_FILE_THRESHOLD) {
          setContentError(t('learningHub:file.previewTooLarge', '文件过大，无法预览'));
          setContentLoading(false);
          return;
        }

        // ★ 用标记区分"内容过大"与"内容不存在"，避免外层用"未找到文件内容"覆盖"文件过大"错误
        let vfsContentTooLarge = false;
        const loadFromVfs = async () => {
          const result = await invoke<{ content: string | null; found: boolean }>('vfs_get_attachment_content', {
            attachmentId: node.id,
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
              setContentError(t('learningHub:file.previewTooLarge', '文件过大，无法预览'));
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
            ? t('learningHub:file.previewTooLarge', '文件过大，无法预览')
            : t('learningHub:file.contentNotFound', '未找到文件内容 (id: {{id}})', { id: node.id }));
          setContentLoading(false);
        }
      } catch (err: unknown) {
        console.error('[TextbookContentView] Failed to load file:', err);
        if (isMounted) {
          setContentError(err instanceof Error ? err.message : t('learningHub:file.loadFailed', '加载文件失败'));
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
  
  // 书签保存的防抖引用
  const saveBookmarksTimerRef = useRef<number | null>(null);
  
  // 初始化书签数据
  useEffect(() => {
    const savedBookmarks = node.metadata?.bookmarks as Bookmark[] | undefined;
    if (savedBookmarks && Array.isArray(savedBookmarks)) {
      setBookmarks(savedBookmarks);
    } else {
      setBookmarks([]);
    }
  }, [node.metadata?.bookmarks]);
  
  // 保存阅读进度到 DSTU
  const handleProgressChange = useCallback((progress: ReadingProgress) => {
    // ★ 记录 pending 值，供 unmount flush 使用
    pendingProgressRef.current = progress;

    // 防抖：清理之前的定时器
    if (saveProgressTimerRef.current) {
      window.clearTimeout(saveProgressTimerRef.current);
    }
    
    // 延迟保存，避免频繁写入
    saveProgressTimerRef.current = window.setTimeout(async () => {
      saveProgressTimerRef.current = null;
      pendingProgressRef.current = null; // 已提交，清除 pending
      
      // 构建新的元数据（保留原有字段）
      const newMetadata = {
        ...nodeMetadataRef.current,
        readingProgress: {
          page: progress.page,
          lastReadAt: progress.lastReadAt,
        },
      };

      // 通过 DSTU 保存元数据 (Result模式)
      const result = await dstu.setMetadata(nodePathRef.current, newMetadata);
      if (!result.ok) {
        reportError(result.error, '保存阅读进度');
        console.warn('[TextbookContentView] Failed to save reading progress:', result.error.toUserMessage());
      }
    }, 2000); // 2秒防抖，避免频繁保存
  }, []);
  
  // 保存书签到后端（通过 VFS API）
  const handleBookmarksChange = useCallback((newBookmarks: Bookmark[]) => {
    // 更新本地状态
    setBookmarks(newBookmarks);
    // ★ 记录 pending 值，供 unmount flush 使用
    pendingBookmarksRef.current = newBookmarks;
    
    // 防抖：清理之前的定时器
    if (saveBookmarksTimerRef.current) {
      window.clearTimeout(saveBookmarksTimerRef.current);
    }
    
    // 延迟保存，避免频繁写入
    saveBookmarksTimerRef.current = window.setTimeout(async () => {
      saveBookmarksTimerRef.current = null;
      pendingBookmarksRef.current = null; // 已提交，清除 pending
      
      try {
        const fileId = nodeIdRef.current;
        
        // 调用后端 API 保存书签
        await vfsFileApi.updateBookmarks(fileId, newBookmarks);
        
        // 同时更新 DSTU 元数据，保持数据一致性
        const newMetadata = {
          ...nodeMetadataRef.current,
          bookmarks: newBookmarks,
        };
        await dstu.setMetadata(nodePathRef.current, newMetadata);
      } catch (err: unknown) {
        console.error('[TextbookContentView] Failed to save bookmarks:', err);
        showGlobalNotification('error', t('textbook:bookmarkSaveFailed', '书签保存失败'));
      }
    }, 1000); // 1秒防抖
  }, [t]);
  
  // ★ 清理定时器并 flush 未保存的数据（防止卸载丢失）。
  // 依赖 [node.id]：同一挂载实例切换 node 时也要先 flush 旧节点，
  // 否则挂起的防抖定时器会在 refs 已指向新节点后触发，把旧文档的进度/书签写到新文档上。
  // cleanup 阶段各 ref 仍持有旧节点的值（ref 同步发生在所有 cleanup 之后的 setup 阶段）。
  React.useEffect(() => {
    return () => {
      // 清除定时器
      if (saveProgressTimerRef.current) {
        window.clearTimeout(saveProgressTimerRef.current);
        saveProgressTimerRef.current = null;
      }
      if (saveBookmarksTimerRef.current) {
        window.clearTimeout(saveBookmarksTimerRef.current);
        saveBookmarksTimerRef.current = null;
      }

      // ★ 合并 flush 未保存的阅读进度和书签（单次 setMetadata，避免竞态覆盖）
      const pendingProgress = pendingProgressRef.current;
      const pendingBookmarks = pendingBookmarksRef.current;
      pendingProgressRef.current = null;
      pendingBookmarksRef.current = null;

      if (pendingProgress || pendingBookmarks) {
        const mergedMetadata = { ...nodeMetadataRef.current };
        if (pendingProgress) {
          mergedMetadata.readingProgress = {
            page: pendingProgress.page,
            lastReadAt: pendingProgress.lastReadAt,
          };
        }
        if (pendingBookmarks) {
          mergedMetadata.bookmarks = pendingBookmarks;
          // 书签同时保存到 VFS API
          void vfsFileApi.updateBookmarks(nodeIdRef.current, pendingBookmarks);
        }
        dstu.setMetadata(nodePathRef.current, mergedMetadata).then(result => {
          if (!result.ok) {
            reportError(result.error, '保存未持久化的阅读进度/书签');
            console.warn('[TextbookContentView] flush setMetadata failed:', result.error.toUserMessage());
          }
        }).catch(err => {
          console.error('[TextbookContentView] flush setMetadata error:', err);
        });
      }
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
        title: t('textbook:relink.dialogTitle', '选择文件的新位置'),
        filters: ext ? [{ name: node.name, extensions: [ext] }] : undefined,
      });
      if (!selected || typeof selected !== 'string') return;

      await invoke('textbooks_relink', { id: node.id, newPath: selected });
      showGlobalNotification('success', t('textbook:relink.success', '文件已重新关联'));
      setRelinkTick((c) => c + 1);
    } catch (err: unknown) {
      showGlobalNotification('error', getErrorMessage(err), t('textbook:relink.failed', '重新关联失败'));
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

  // 失联场景下的"重新关联"按钮（PDF/非 PDF 错误态共用）
  const relinkButton = (
    <NotionButton
      variant="default"
      size="sm"
      disabled={isRelinking}
      onClick={() => {
        void handleRelink();
      }}
    >
      {isRelinking
        ? <CircleNotch className="h-3.5 w-3.5 mr-1.5 animate-spin" aria-hidden="true" />
        : <LinkSimple className="h-3.5 w-3.5 mr-1.5" aria-hidden="true" />}
      {t('textbook:relink.action', '重新关联文件')}
    </NotionButton>
  );

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
    <div
      className="flex flex-col items-center justify-center h-full gap-4"
      role="status"
      aria-label={t('common:loading', '加载中...')}
    >
      <CircleNotch className="h-8 w-8 animate-spin text-primary" aria-hidden="true" />
      {contentLoadTimedOut && (
        <>
          <p className="text-sm text-muted-foreground text-center">
            {t('textbook:loading.timeout', '加载时间较长，可能遇到问题')}
          </p>
          <div className="flex gap-2">
            <NotionButton
              variant="default"
              size="sm"
              onClick={retryContentLoad}
            >
              <ArrowClockwise className="h-3.5 w-3.5 mr-1.5" aria-hidden="true" />
              {t('common:retry', '重试')}
            </NotionButton>
            {relinkButton}
          </div>
        </>
      )}
    </div>
  );

  // ★ 移除 filePath 为空时的硬性错误，改为在内容加载失败时显示错误
  // 因为从 attachments 迁移的文件可能没有 filePath，但可以通过 vfs_get_attachment_content 获取内容
  
  // PDF 文件：如果没有 filePath 且没有 pdfFile，显示加载中或错误
  if (isPdf && !effectiveFilePath && !pdfFile) {
    if (pdfLoading) {
      return (
        <div
          className="flex flex-col items-center justify-center h-full gap-4"
          role="status"
          aria-label={t('common:loading', '加载中...')}
        >
          <CircleNotch className="h-8 w-8 animate-spin text-primary" aria-hidden="true" />
          {isPdfLargeFile && (
            <p className="text-sm text-muted-foreground">
              {t('textbook:loading.largeFile', '正在加载大文件，请稍候...')}
            </p>
          )}
        </div>
      );
    }
    if (pdfError) {
      return (
        <div className="flex flex-col items-center justify-center h-full gap-4" role="alert">
          <WarningCircle className="w-12 h-12 text-destructive" aria-hidden="true" />
          <p className="text-destructive text-center">{pdfError}</p>
          <div className="flex gap-2">
            <NotionButton
              variant="default"
              size="sm"
              onClick={retryPdfLoad}
            >
              <ArrowClockwise className="h-3.5 w-3.5 mr-1.5" aria-hidden="true" />
              {t('common:retry', '重试')}
            </NotionButton>
            {relinkButton}
          </div>
          <p className="text-xs text-muted-foreground max-w-md text-center">
            {t('textbook:relink.hint', '若原文件已被移动或重命名，可点击"重新关联文件"选择它的新位置。')}
          </p>
        </div>
      );
    }
    // 初始状态，等待加载（超时后显示提示 + 重试按钮）
    return (
      <div
        className="flex flex-col items-center justify-center h-full gap-4"
        role="status"
        aria-label={t('common:loading', '加载中...')}
      >
        <CircleNotch className="h-8 w-8 animate-spin text-primary" aria-hidden="true" />
        {pdfInitTimedOut && (
          <>
            <p className="text-sm text-muted-foreground text-center">
              {t('textbook:loading.timeout', '加载时间较长，可能遇到问题')}
            </p>
            <div className="flex gap-2">
              <NotionButton
                variant="default"
                size="sm"
                onClick={retryPdfLoad}
              >
                <ArrowClockwise className="h-3.5 w-3.5 mr-1.5" aria-hidden="true" />
                {t('common:retry', '重试')}
              </NotionButton>
              {relinkButton}
            </div>
          </>
        )}
      </div>
    );
  }
  
  // 错误状态
  if (contentError) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4" role="alert">
        <WarningCircle className="w-12 h-12 text-destructive" aria-hidden="true" />
        <p className="text-destructive text-center">{contentError}</p>
        <div className="flex gap-2">
          <NotionButton
            variant="default"
            size="sm"
            onClick={retryContentLoad}
          >
            <ArrowClockwise className="h-3.5 w-3.5 mr-1.5" aria-hidden="true" />
            {t('common:retry', '重试')}
          </NotionButton>
          {relinkButton}
        </div>
      </div>
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

  // 纯文本预览
  if (isText) {
    if (!fileContent) {
      return contentLoadingView;
    }
    return (
      <div className="flex flex-col h-full bg-background overflow-hidden">
        {/* orientation="both"：代码类（whitespace-pre）/CSV 表格（w-max）会横向溢出，
            仅纵向滚动时溢出内容不可达（窄屏尤甚）；真实 overflow-x:auto 同时让
            三屏手势豁免逻辑正确识别横向可滚动容器 */}
        <CustomScrollArea className="flex-1" orientation="both">
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
      <div className="flex flex-col items-center justify-center h-full gap-4">
        <FileText className="w-16 h-16 text-muted-foreground" aria-hidden="true" />
        <div className="text-center space-y-2">
          <p className="text-lg font-medium text-foreground">{node.name}</p>
          <p className="text-muted-foreground">
            {t('learningHub:textbook.unsupportedPreview', { ext })}
          </p>
        </div>
        {effectiveFilePath && (
          <NotionButton
            variant="default"
            size="sm"
            disabled={isOpeningExternal}
            onClick={() => {
              void handleOpenExternal(effectiveFilePath);
            }}
          >
            {isOpeningExternal
              ? <CircleNotch className="h-3.5 w-3.5 mr-1.5 animate-spin" aria-hidden="true" />
              : <ArrowSquareOut className="h-3.5 w-3.5 mr-1.5" aria-hidden="true" />}
            {t('common:openExternal', '在外部打开')}
          </NotionButton>
        )}
      </div>
    );
  }

  // PDF 预览
  // 优先使用 filePath（本地文件），否则使用从数据库加载的 pdfFile
  return (
    <div className="flex flex-col h-full bg-background">
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
