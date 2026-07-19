/**
 * 文件内容视图
 * 
 * 用于在 Learning Hub 中预览文档附件（PDF、DOCX、XLSX 等）。
 * 根据文件类型路由到不同的预览组件：
 * - DOCX: 富文本预览（docx-preview）
 * - XLSX: 表格预览（ExcelJS）
 * - PPTX: 演示文稿预览（pptx-preview）
 * - 其他: 纯文本预览
 * 
 * 统一工具栏架构：
 * - 缩放控制：所有预览类型
 * - 字号控制：仅 DOCX/XLSX
 * - 使用 PreviewContext 统一管理预览状态
 * - 使用 UnifiedPreviewToolbar 显示控制项
 */

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { CircleNotch } from '@phosphor-icons/react';
import type { ContentViewProps } from '../UnifiedAppPanel';
import { invoke } from '@tauri-apps/api/core';
import { PreviewProvider, usePreviewContext, type PreviewType } from './PreviewContext';
import type { ToolbarPreviewType } from './UnifiedPreviewToolbar';
import { usePdfLoader } from '@/hooks/usePdfLoader';
import { usePdfFocusListener } from './usePdfFocusListener';
import {
  base64ToBlob,
  base64ToUint8Array,
  estimateBase64Size,
  LARGE_FILE_THRESHOLD,
  uint8ArrayToBase64,
} from '@/utils/base64FileUtils';
import { getErrorMessage } from '@/utils/errorUtils';
import { fileManager } from '@/utils/fileManager';
import { showGlobalNotification } from '@/components/UnifiedNotification';

// PDF 预览组件
import {
  TextbookPdfViewer,
  type Bookmark,
  type ReadingProgress,
} from '@/features/pdf/components/TextbookPdfViewer';
import { resolveFilePreviewMode } from './filePreviewResolver';
import { formatFileSize } from './previewUtils';
import { RichDocumentPreview } from './RichDocumentPreview';
import { TextFilePreview } from './TextFilePreview';
import EpubPreview from './EpubPreview';
import { loadTextPreviewContent } from './textPreviewLoader';
import {
  isLikelyUnsupportedMedia,
  resolveAudioMimeType,
  resolveVideoMimeType,
} from './mediaPreviewUtils';
import { PreviewStatus } from './PreviewStatus';
import { createPreviewPersistController } from './previewPersistence';

/**
 * 将文件预览模式映射到 PreviewContext 类型
 */
const toContextPreviewType = (mode: ReturnType<typeof resolveFilePreviewMode>): PreviewType => {
  if (mode === 'docx' || mode === 'xlsx' || mode === 'pptx' || mode === 'text') {
    return mode;
  }
  return null;
};

/**
 * 将 PreviewType 转换为 ToolbarPreviewType
 */
const toToolbarPreviewType = (type: PreviewType): ToolbarPreviewType => {
  if (type === 'docx' || type === 'xlsx' || type === 'pptx' || type === 'image' || type === 'text') {
    return type;
  }
  return 'other';
};

/**
 * 文件内容视图内部组件
 * 包含主要逻辑，使用 PreviewContext 管理预览状态
 */
const FileContentViewInner: React.FC<ContentViewProps> = ({
  node,
  // onClose 暂未使用，保留接口以便后续扩展
}) => {
  const { t } = useTranslation(['learningHub', 'common']);
  
  // 从 PreviewContext 获取状态和方法
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
  
  // 状态
  const [textContent, setTextContent] = useState<string | null>(null);
  const [base64Content, setBase64Content] = useState<string | null>(null);
  const [mediaObjectUrl, setMediaObjectUrl] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPreviewTooLarge, setIsPreviewTooLarge] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [mediaRenderFailed, setMediaRenderFailed] = useState(false);

  // 从 node 的 metadata 获取文件信息
  const metadata = node.metadata as Record<string, unknown> | undefined;
  const mimeType = (metadata?.mimeType as string) || 'application/octet-stream';
  const contentHash = (metadata?.contentHash as string) || '';

  // 解析文件预览模式
  const previewMode = resolveFilePreviewMode(mimeType, node.name, node.previewType);
  const isDocx = previewMode === 'docx';
  const isExcel = previewMode === 'xlsx';
  const isPptx = previewMode === 'pptx';
  const isEpub = previewMode === 'epub';
  const isPdf = previewMode === 'pdf';
  const isAudio = previewMode === 'audio';
  const isVideo = previewMode === 'video';
  const needsRichPreview = isDocx || isExcel || isPptx;
  const needsBinaryPreview = needsRichPreview || isEpub || isAudio || isVideo;
  const canPreviewText = previewMode === 'text';

  // 使用统一的 PDF 加载 Hook（支持缓存、去重、大文件检测）
  const {
    file: pdfFile,
    filePath: pdfFilePath,
    loading: pdfLoading,
    error: pdfError,
    isLargeFile: isPdfLargeFile,
    retry: retryPdfLoad,
  } = usePdfLoader({
    nodeId: node.id,
    fileName: node.name,
    cacheKey: `${node.id}:${node.updatedAt || ''}`,
    enabled: isPdf,
  });
  
  // PDF 页面选择状态
  const [selectedPages, setSelectedPages] = useState<Set<number>>(new Set());
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);

  // ★ File PDF persist：仅 dstu.setMetadata（见 previewPersistence NOTE(backend)）
  const nodePathRef = useRef(node.path);
  const nodeIdRef = useRef(node.id);
  const nodeMetadataRef = useRef(node.metadata as Record<string, unknown> | undefined);
  useEffect(() => {
    nodePathRef.current = node.path;
    nodeIdRef.current = node.id;
    nodeMetadataRef.current = node.metadata as Record<string, unknown> | undefined;
  }, [node.path, node.id, node.metadata]);

  const persistControllerRef = useRef(
    createPreviewPersistController({
      kind: 'file',
      nodeId: node.id,
      nodePath: node.path,
      getMetadata: () => nodeMetadataRef.current,
    }),
  );

  // ★ R2：切换资源时在 render 阶段同步重置内容状态（组件实例跨节点复用）。
  // 仅靠 effect 重置会让"新节点 + 旧内容"先渲染一帧（如 md 内容被当作新文件名的 csv 解析）；
  // PDF 页面选择同理，避免上一个 PDF 的选择残留到新文件。
  const [prevNodeId, setPrevNodeId] = useState(node.id);
  if (prevNodeId !== node.id) {
    setPrevNodeId(node.id);
    setTextContent(null);
    setBase64Content(null);
    setMediaObjectUrl(null); // 旧 blob URL 由 [mediaObjectUrl] 清理 effect 释放
    setError(null);
    setIsPreviewTooLarge(false);
    setMediaRenderFailed(false);
    setSelectedPages(new Set());
    const nextBookmarks = (node.metadata as Record<string, unknown> | undefined)?.bookmarks as Bookmark[] | undefined;
    setBookmarks(Array.isArray(nextBookmarks) ? nextBookmarks : []);
  }

  const readingProgress = useMemo<ReadingProgress | undefined>(() => {
    const progress = (node.metadata as Record<string, unknown> | undefined)?.readingProgress as
      | { page?: number; lastReadAt?: number }
      | undefined;
    if (progress && typeof progress.page === 'number' && progress.page > 0) {
      return { page: progress.page, lastReadAt: progress.lastReadAt };
    }
    return undefined;
  }, [node.metadata]);

  useEffect(() => {
    const saved = (node.metadata as Record<string, unknown> | undefined)?.bookmarks as Bookmark[] | undefined;
    if (saved && Array.isArray(saved)) {
      setBookmarks(saved);
    } else {
      setBookmarks([]);
    }
  }, [node.metadata]);

  // node 切换时 flush 旧控制器再换新；unmount 时 dispose
  useEffect(() => {
    persistControllerRef.current.dispose();
    persistControllerRef.current = createPreviewPersistController({
      kind: 'file',
      nodeId: nodeIdRef.current,
      nodePath: nodePathRef.current,
      getMetadata: () => nodeMetadataRef.current,
    });
    return () => {
      persistControllerRef.current.dispose();
    };
  }, [node.id]);

  const handleProgressChange = useCallback((progress: ReadingProgress) => {
    persistControllerRef.current.scheduleProgress(progress);
  }, []);

  const handleBookmarksChange = useCallback((newBookmarks: Bookmark[]) => {
    setBookmarks(newBookmarks);
    persistControllerRef.current.scheduleBookmarks(newBookmarks);
  }, []);

  // ★ 使用共享 Hook 监听 PDF 页码跳转事件
  const [focusRequest, handleFocusHandled] = usePdfFocusListener({
    enabled: isPdf,
    nodeId: node.id,
    nodeSourceId: node.sourceId,
    nodePath: node.path,
    nodeName: node.name,
  });

  // 处理页面选择变化 + 广播给 Chat InputBar
  const handlePageSelectionChange = useCallback((pages: Set<number>) => {
    setSelectedPages(pages);
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

  // 稳定的空回调（避免每次渲染创建新函数）
  const noopExportPages = useCallback(() => {}, []);

  // 根据文件类型设置 previewType
  useEffect(() => {
    setPreviewType(toContextPreviewType(previewMode));
  }, [previewMode, setPreviewType]);

  // Blob URL 生命周期：每次 mediaObjectUrl 变化（含卸载）时释放旧 URL
  useEffect(() => {
    return () => {
      if (mediaObjectUrl) {
        URL.revokeObjectURL(mediaObjectUrl);
      }
    };
  }, [mediaObjectUrl]);

  // ★ 用于手动重试的计数器
  const [retryCount, setRetryCount] = useState(0);
  const handleRetry = useCallback(() => setRetryCount((c) => c + 1), []);

  // ★ L-008 修复：文件过大时提供"保存到本地"操作
  const handleSaveFile = useCallback(async () => {
    setIsSaving(true);
    try {
      const ext = node.name.includes('.') ? node.name.split('.').pop() || '' : '';
      const blobPath = await invoke<string | null>('vfs_get_file_blob_path', { id: node.id });
      if (blobPath) {
        const saveResult = await fileManager.saveFromSource({
          sourcePath: blobPath,
          defaultFileName: node.name,
          filters: ext ? [{ name: node.name, extensions: [ext] }] : undefined,
        });
        if (!saveResult.canceled && saveResult.path) {
          showGlobalNotification('success', t('learningHub:file.savedSuccessfully'));
          try {
            const { openPath } = await import('@tauri-apps/plugin-opener');
            await openPath(saveResult.path);
          } catch {
            // The file was saved successfully; opening it is best-effort.
          }
        }
        return;
      }

      // Compatibility path for legacy inline resources without a blob file.
      const result = await invoke<{ content: string | null; found: boolean }>('vfs_get_attachment_content', {
        attachmentId: node.id,
      });

      if (!result?.found || !result?.content) {
        showGlobalNotification('error', t('learningHub:file.loadFailed'));
        return;
      }

      const bytes = base64ToUint8Array(result.content);
      if (!bytes) {
        showGlobalNotification('error', t('learningHub:file.loadFailed'));
        return;
      }

      // 从文件名推断扩展名
      const saveResult = await fileManager.saveBinaryFile({
        data: bytes,
        defaultFileName: node.name,
        filters: ext ? [{ name: node.name, extensions: [ext] }] : undefined,
      });

      if (!saveResult.canceled && saveResult.path) {
        showGlobalNotification('success', t('learningHub:file.savedSuccessfully'));
        // 保存成功后用系统默认应用打开
        try {
          const { openPath } = await import('@tauri-apps/plugin-opener');
          await openPath(saveResult.path);
        } catch {
          // 打开失败不阻塞，文件已保存
        }
      }
    } catch (err: unknown) {
      showGlobalNotification('error', getErrorMessage(err));
    } finally {
      setIsSaving(false);
    }
  }, [node.id, node.name, t]);

  // 加载文件内容
  useEffect(() => {
    let isMounted = true;

    const loadTextContent = async () => {
      try {
        const content = await loadTextPreviewContent({
          nodeId: node.id,
          fileName: node.name,
          contentHash,
        });
        if (!isMounted) return;
        // 空字符串是合法内容（空文件），由 TextFilePreview 渲染空状态
        if (content !== null) {
          setTextContent(content);
        } else {
          setError(t('learningHub:file.contentNotFound', { id: node.id }));
        }
      } catch (textErr: unknown) {
        console.warn('[FileContentView] loadTextContent failed:', textErr);
        if (isMounted) {
          setError(getErrorMessage(textErr));
        }
      }
    };

    const loadBinaryContent = async () => {
      const blobPath = await invoke<string | null>('vfs_get_file_blob_path', { id: node.id });
      if (!isMounted) return;

      if (blobPath) {
        const fileSize = await invoke<number>('get_file_size', { path: blobPath });
        if (!isMounted) return;
        if (fileSize > LARGE_FILE_THRESHOLD) {
          setError(t('learningHub:file.previewTooLarge'));
          setIsPreviewTooLarge(true);
          return;
        }

        const buffer = await invoke<ArrayBuffer>('read_file_bytes', { path: blobPath });
        if (!isMounted) return;
        const content = uint8ArrayToBase64(new Uint8Array(buffer));
        setBase64Content(content);

        if (isAudio || isVideo) {
          const mediaMimeType = isAudio
            ? resolveAudioMimeType(mimeType, node.name)
            : resolveVideoMimeType(mimeType, node.name);
          setMediaObjectUrl(URL.createObjectURL(new Blob([buffer], { type: mediaMimeType })));
        }
        return;
      }

      // Legacy inline resources have no blob path. Keep the compatibility
      // fallback, guarded by the database metadata size check above.
      const result = await invoke<{ content: string | null; found: boolean }>('vfs_get_attachment_content', {
        attachmentId: node.id,
        maxBytes: LARGE_FILE_THRESHOLD,
      });

      if (!isMounted) return;

      if (result?.found && result?.content) {
        const estimatedSize = estimateBase64Size(result.content);
        if (estimatedSize > LARGE_FILE_THRESHOLD) {
          setError(t('learningHub:file.previewTooLarge'));
          setIsPreviewTooLarge(true);
          return;
        }

        setBase64Content(result.content);

        if (isAudio || isVideo) {
          const mediaMimeType = isAudio
            ? resolveAudioMimeType(mimeType, node.name)
            : resolveVideoMimeType(mimeType, node.name);
          const mediaBlob = base64ToBlob(result.content, mediaMimeType);

          if (!mediaBlob) {
            setError(t('learningHub:file.mediaDecodeFailed'));
            return;
          }

          // 旧 URL 由 [mediaObjectUrl] 清理 effect 统一释放
          setMediaObjectUrl(URL.createObjectURL(mediaBlob));
        }

        return;
      }

      setError(t('learningHub:file.contentNotFound', { id: node.id }));
    };

    const loadContent = async () => {
      // 重置状态（切换资源时清除上一个文件的残留；旧 blob URL 由清理 effect 释放）
      setError(null);
      setIsPreviewTooLarge(false);
      setTextContent(null);
      setBase64Content(null);
      setMediaRenderFailed(false);
      setMediaObjectUrl(null);

      // PDF 有独立的加载 Hook；不可预览类型无需加载 → 跳过，避免无意义的 loading 闪烁
      if (!needsBinaryPreview && !canPreviewText) {
        return;
      }

      setIsLoading(true);
      try {
        const knownSize = typeof node.size === 'number' ? node.size : null;
        if (needsBinaryPreview && knownSize && knownSize > LARGE_FILE_THRESHOLD) {
          setError(t('learningHub:file.previewTooLarge'));
          setIsPreviewTooLarge(true);
          return;
        }

        if (needsBinaryPreview) {
          await loadBinaryContent();
        } else {
          await loadTextContent();
        }
      } catch (err: unknown) {
        // 🔒 审计修复: 二进制加载失败时设置错误状态（原代码静默吞掉）
        // （loadTextContent 内部自带 try/catch，此处仅捕获二进制加载异常）
        if (isMounted) {
          setError(getErrorMessage(err));
        }
      } finally {
        if (isMounted) {
          setIsLoading(false);
        }
      }
    };

    void loadContent();

    return () => {
      isMounted = false;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- t 不加入依赖：语言切换不应重新加载文件；retryCount 用于手动重试
  }, [
    canPreviewText,
    contentHash,
    isAudio,
    isVideo,
    mimeType,
    needsBinaryPreview,
    node.id,
    node.name,
    node.size,
    retryCount,
  ]);
  const showToolbar = Boolean(needsRichPreview && base64Content && previewType);

  const renderRichDocumentPreview = (
    kind: 'docx' | 'xlsx' | 'pptx',
    content: string
  ) => (
    <RichDocumentPreview
      kind={kind}
      base64Content={content}
      fileName={node.name}
      showToolbar={showToolbar}
      previewType={toToolbarPreviewType(previewType)}
      zoomScale={zoomScale}
      fontScale={fontScale}
      onZoomChange={setZoomScale}
      onFontChange={setFontScale}
      onZoomReset={resetZoom}
      onFontReset={resetFont}
      fallback={<div className="flex items-center justify-center h-full"><CircleNotch className="h-8 w-8 animate-spin text-primary" /></div>}
    />
  );

  // 渲染内容
  const renderContent = () => {
    if (error) {
      return (
        <PreviewStatus
          tone="error"
          title={error}
          meta={
            isPreviewTooLarge && typeof node.size === 'number' && node.size > 0
              ? `${node.name} · ${formatFileSize(node.size)}`
              : undefined
          }
          actions={[
            ...(isPreviewTooLarge
              ? [{
                  id: 'save',
                  label: t('learningHub:file.saveToDevice'),
                  onClick: () => { void handleSaveFile(); },
                  variant: 'primary' as const,
                  loading: isSaving,
                }]
              : []),
            {
              id: 'retry',
              label: t('common:retry'),
              onClick: handleRetry,
              variant: 'ghost' as const,
            },
          ]}
        />
      );
    }
    if (isLoading) {
      return (
        <PreviewStatus
          tone="loading"
          title={t('learningHub:loading.content')}
        />
      );
    }

    // PDF 预览
    if (isPdf) {
      if (pdfLoading) {
        return (
          <PreviewStatus
            tone="loading"
            title={t('learningHub:loading.content')}
            description={isPdfLargeFile ? t('learningHub:file.loadingLargeFile') : undefined}
          />
        );
      }
      if (pdfError) {
        return (
          <PreviewStatus
            tone="error"
            title={pdfError}
            actions={[
              {
                id: 'retry',
                label: t('common:retry'),
                onClick: retryPdfLoad,
                variant: 'ghost',
              },
            ]}
          />
        );
      }
      if (pdfFile || pdfFilePath) {
        return (
          <TextbookPdfViewer
            file={pdfFile}
            filePath={pdfFilePath || ''}
            fileName={node.name}
            selectedPages={selectedPages}
            onPageSelectionChange={handlePageSelectionChange}
            onExportSelectedPages={noopExportPages}
            enableAutoPrepare={false}
            focusRequest={focusRequest}
            onFocusHandled={handleFocusHandled}
            resourcePath={node.path}
            readingProgress={readingProgress}
            onProgressChange={handleProgressChange}
            bookmarks={bookmarks}
            onBookmarksChange={handleBookmarksChange}
          />
        );
      }
      // 正在等待加载
      return (
        <PreviewStatus
          tone="loading"
          title={t('learningHub:loading.content')}
        />
      );
    }

    // DOCX / Excel / PPTX 富文档预览
    if (isDocx && base64Content) {
      return renderRichDocumentPreview('docx', base64Content);
    }
    if (isExcel && base64Content) {
      return renderRichDocumentPreview('xlsx', base64Content);
    }
    if (isPptx && base64Content) {
      return renderRichDocumentPreview('pptx', base64Content);
    }
    if (isEpub && base64Content) {
      return <EpubPreview base64Content={base64Content} fileName={node.name} resourceId={node.id} />;
    }

    // 音频预览
    if (isAudio && mediaObjectUrl) {
      if (mediaRenderFailed) {
        return (
          <PreviewStatus
            tone="error"
            title={t('learningHub:file.mediaRenderFailed')}
            description={
              isLikelyUnsupportedMedia(node.name, 'audio')
                ? t('learningHub:file.mediaUnsupportedHint')
                : t('learningHub:file.mediaRenderFailedHint')
            }
            actions={[
              { id: 'retry', label: t('common:retry'), onClick: handleRetry, variant: 'ghost' },
              {
                id: 'save',
                label: t('learningHub:file.saveToDevice'),
                onClick: () => { void handleSaveFile(); },
                variant: 'primary',
                loading: isSaving,
              },
            ]}
          />
        );
      }
      return (
        <div className="h-full flex flex-col items-center justify-center p-6 gap-3">
          {isLikelyUnsupportedMedia(node.name, 'audio') && (
            <p className="text-xs text-amber-600 dark:text-amber-400 text-center max-w-md">
              {t('learningHub:file.mediaUnsupportedWarning')}
            </p>
          )}
          <audio
            controls
            src={mediaObjectUrl}
            className="w-full max-w-3xl"
            preload="metadata"
            onError={() => setMediaRenderFailed(true)}
          >
            {t('learningHub:file.noPreview')}
          </audio>
        </div>
      );
    }

    // 视频预览
    if (isVideo && mediaObjectUrl) {
      if (mediaRenderFailed) {
        return (
          <PreviewStatus
            tone="error"
            title={t('learningHub:file.mediaRenderFailed')}
            description={
              isLikelyUnsupportedMedia(node.name, 'video')
                ? t('learningHub:file.mediaUnsupportedHint')
                : t('learningHub:file.mediaRenderFailedHint')
            }
            actions={[
              { id: 'retry', label: t('common:retry'), onClick: handleRetry, variant: 'ghost' },
              {
                id: 'save',
                label: t('learningHub:file.saveToDevice'),
                onClick: () => { void handleSaveFile(); },
                variant: 'primary',
                loading: isSaving,
              },
            ]}
          />
        );
      }
      return (
        <div className="h-full flex flex-col bg-black/90">
          {isLikelyUnsupportedMedia(node.name, 'video') && (
            <p className="text-xs text-amber-400 text-center py-2 px-4">
              {t('learningHub:file.mediaUnsupportedWarning')}
            </p>
          )}
          <div className="flex-1 flex items-center justify-center">
            <video
              controls
              src={mediaObjectUrl}
              className="max-h-full max-w-full"
              preload="metadata"
              onError={() => setMediaRenderFailed(true)}
            >
              {t('learningHub:file.noPreview')}
            </video>
          </div>
        </div>
      );
    }

    // 文本预览（md 富渲染 / csv 表格化 / 纯文本，带滚动容器）
    // ★ 空字符串也进入此分支：TextFilePreview 会渲染"文件内容为空"空状态
    if (textContent !== null) {
      return (
        <div className="h-full overflow-auto">
          <TextFilePreview content={textContent} fileName={node.name} />
        </div>
      );
    }

    // 无法预览 — 显示文件信息以帮助排查
    return (
      <PreviewStatus
        tone="empty"
        icon="file"
        title={t('learningHub:file.noPreview')}
        description={t('learningHub:file.downloadHint')}
        meta={`${node.name} · ${mimeType}${
          typeof node.size === 'number' && node.size > 0 ? ` · ${formatFileSize(node.size)}` : ''
        } · ${node.id}`}
        actions={[
          {
            id: 'save',
            label: t('learningHub:file.saveToDevice'),
            onClick: () => { void handleSaveFile(); },
            variant: 'primary',
            loading: isSaving,
          },
          {
            id: 'retry',
            label: t('common:retry'),
            onClick: handleRetry,
            variant: 'ghost',
          },
        ]}
      />
    );
  };

  return (
    <div className="flex flex-col h-full bg-background overflow-hidden">
      {renderContent()}
    </div>
  );
};

/**
 * 文件内容视图组件
 * 使用 PreviewProvider 包装，提供统一的预览状态管理
 */
const FileContentView: React.FC<ContentViewProps> = (props) => (
  <PreviewProvider>
    <FileContentViewInner {...props} />
  </PreviewProvider>
);

export default FileContentView;
