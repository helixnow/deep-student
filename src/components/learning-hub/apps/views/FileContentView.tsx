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

import React, { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { File as FileIcon, FileText, FileArchive, FileSpreadsheet, Loader2, RefreshCw, Download } from 'lucide-react';
import { NotionButton } from '@/components/ui/NotionButton';
import type { ContentViewProps } from '../UnifiedAppPanel';
import { invoke } from '@tauri-apps/api/core';
import { PreviewProvider, usePreviewContext, type PreviewType } from './PreviewContext';
import type { ToolbarPreviewType } from './UnifiedPreviewToolbar';
import { usePdfLoader } from '@/hooks/usePdfLoader';
import { usePdfFocusListener } from './usePdfFocusListener';
import { base64ToBlob, base64ToUint8Array, estimateBase64Size, LARGE_FILE_THRESHOLD } from '@/utils/base64FileUtils';
import { getErrorMessage } from '@/utils/errorUtils';
import { fileManager } from '@/utils/fileManager';
import { showGlobalNotification } from '@/components/UnifiedNotification';

// PDF 预览组件
import { TextbookPdfViewer } from '@/components/TextbookPdfViewer';
import { resolveFilePreviewMode } from './filePreviewResolver';
import { RichDocumentPreview } from './RichDocumentPreview';

/**
 * 根据 MIME 类型获取对应图标
 */
const getFileIconComponent = (mimeType: string) => {
  if (mimeType.includes('pdf')) return FileText;
  if (mimeType.includes('spreadsheet') || mimeType.includes('excel')) return FileSpreadsheet;
  if (mimeType.includes('zip') || mimeType.includes('archive')) return FileArchive;
  return FileIcon;
};

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
 * 为音视频预览提供安全的 MIME 类型
 */
const getMediaMimeType = (mode: 'audio' | 'video', mimeType: string): string => {
  const normalized = mimeType.toLowerCase();
  if (mode === 'audio') {
    return normalized.startsWith('audio/') ? normalized : 'audio/mpeg';
  }
  return normalized.startsWith('video/') ? normalized : 'video/mp4';
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

  // 从 node 的 metadata 获取文件信息
  const metadata = node.metadata as Record<string, unknown> | undefined;
  const mimeType = (metadata?.mimeType as string) || 'application/octet-stream';
  const contentHash = (metadata?.contentHash as string) || '';

  // 获取图标
  const FileIconComponent = getFileIconComponent(mimeType);

  // 解析文件预览模式
  const previewMode = resolveFilePreviewMode(mimeType, node.name, node.previewType);
  const isDocx = previewMode === 'docx';
  const isExcel = previewMode === 'xlsx';
  const isPptx = previewMode === 'pptx';
  const isPdf = previewMode === 'pdf';
  const isAudio = previewMode === 'audio';
  const isVideo = previewMode === 'video';
  const needsRichPreview = isDocx || isExcel || isPptx;
  const needsBinaryPreview = needsRichPreview || isAudio || isVideo;
  const canPreviewText = previewMode === 'text';

  // 使用统一的 PDF 加载 Hook（支持缓存、去重、大文件检测）
  const {
    file: pdfFile,
    loading: pdfLoading,
    error: pdfError,
    isLargeFile: isPdfLargeFile,
  } = usePdfLoader({
    nodeId: node.id,
    fileName: node.name,
    cacheKey: `${node.id}:${node.updatedAt || ''}`,
    enabled: isPdf,
  });
  
  // PDF 页面选择状态
  const [selectedPages, setSelectedPages] = useState<Set<number>>(new Set());

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
    };
  }, [node.sourceId]);

  // 稳定的空回调（避免每次渲染创建新函数）
  const noopExportPages = useCallback(() => {}, []);

  // 根据文件类型设置 previewType
  useEffect(() => {
    setPreviewType(toContextPreviewType(previewMode));
  }, [previewMode, setPreviewType]);

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
      const result = await invoke<{ content: string | null; found: boolean }>('vfs_get_attachment_content', {
        attachmentId: node.id,
      });

      if (!result?.found || !result?.content) {
        showGlobalNotification('error', t('learningHub:file.loadFailed', '加载文件失败'));
        return;
      }

      const bytes = base64ToUint8Array(result.content);
      if (!bytes) {
        showGlobalNotification('error', t('learningHub:file.loadFailed', '加载文件失败'));
        return;
      }

      // 从文件名推断扩展名
      const ext = node.name.includes('.') ? node.name.split('.').pop() || '' : '';
      const saveResult = await fileManager.saveBinaryFile({
        data: bytes,
        defaultFileName: node.name,
        filters: ext ? [{ name: node.name, extensions: [ext] }] : undefined,
      });

      if (!saveResult.canceled && saveResult.path) {
        showGlobalNotification('success', t('learningHub:file.savedSuccessfully', '文件已保存'));
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
        const result = await invoke<{ content: string | null; found: boolean }>('vfs_resolve_resource_refs', {
          refs: [{
            sourceId: node.id,
            resourceHash: contentHash,
            type: 'file',
            name: node.name,
          }],
        });

        if (!isMounted) return;
        const resolved = Array.isArray(result) ? result[0] : result;
        if (resolved?.found && resolved?.content) {
          setTextContent(resolved.content);
        }
      } catch {
        // 文本解析失败，静默处理
      }
    };

    const loadBinaryContent = async () => {
      const result = await invoke<{ content: string | null; found: boolean }>('vfs_get_attachment_content', {
        attachmentId: node.id,
      });

      if (!isMounted) return;

      if (result?.found && result?.content) {
        const estimatedSize = estimateBase64Size(result.content);
        if (estimatedSize > LARGE_FILE_THRESHOLD) {
          setError(t('learningHub:file.previewTooLarge', '文件过大，无法预览'));
          setIsPreviewTooLarge(true);
          return;
        }

        setBase64Content(result.content);

        if (isAudio || isVideo) {
          const mediaMode = isAudio ? 'audio' : 'video';
          const mediaMimeType = getMediaMimeType(mediaMode, mimeType);
          const mediaBlob = base64ToBlob(result.content, mediaMimeType);

          if (!mediaBlob) {
            setError(t('learningHub:file.mediaDecodeFailed', '媒体文件解码失败'));
            return;
          }

          const objectUrl = URL.createObjectURL(mediaBlob);
          setMediaObjectUrl((prev) => {
            if (prev) {
              URL.revokeObjectURL(prev);
            }
            return objectUrl;
          });
        }

        return;
      }

      if (canPreviewText) {
        await loadTextContent();
      }
    };

    const loadContent = async () => {
      setIsLoading(true);
      setError(null);
      setIsPreviewTooLarge(false);
      setTextContent(null);
      setBase64Content(null);
      setMediaObjectUrl((prev) => {
        if (prev) {
          URL.revokeObjectURL(prev);
        }
        return null;
      });

      try {
        const knownSize = typeof node.size === 'number' ? node.size : null;
        if (needsBinaryPreview && knownSize && knownSize > LARGE_FILE_THRESHOLD) {
          setError(t('learningHub:file.previewTooLarge', '文件过大，无法预览'));
          setIsPreviewTooLarge(true);
          return;
        }

        if (needsBinaryPreview) {
          await loadBinaryContent();
        } else if (canPreviewText) {
          await loadTextContent();
        }
      } catch (err: unknown) {
        if (!isMounted) return;

        if (canPreviewText) {
          // 二进制加载失败时，尝试文本回退
          await loadTextContent();
        } else {
          // 🔒 审计修复: 二进制加载失败时设置错误状态（原代码静默吞掉）
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
      fallback={<div className="flex items-center justify-center h-full"><Loader2 className="h-8 w-8 animate-spin text-primary" /></div>}
    />
  );

  // 渲染内容
  const renderContent = () => {
    if (error) {
      return (
        <div className="flex flex-col items-center justify-center h-full gap-4">
          <FileText className="w-16 h-16 text-destructive opacity-50" />
          <p className="text-center text-destructive">{error}</p>
          <div className="flex items-center gap-2">
            {isPreviewTooLarge && (
              <NotionButton variant="primary" size="sm" onClick={handleSaveFile} disabled={isSaving} className="gap-1.5">
                {isSaving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
                {t('learningHub:file.saveToDevice', '保存到本地打开')}
              </NotionButton>
            )}
            <NotionButton variant="ghost" size="sm" onClick={handleRetry} className="gap-1.5">
              <RefreshCw className="h-3.5 w-3.5" />
              {t('common:retry', '重试')}
            </NotionButton>
          </div>
        </div>
      );
    }
    if (isLoading) {
      return <div className="flex items-center justify-center h-full"><Loader2 className="h-8 w-8 animate-spin text-primary" /></div>;
    }

    // PDF 预览
    if (isPdf) {
      if (pdfLoading) {
        return (
          <div className="flex flex-col items-center justify-center h-full gap-4">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
            {isPdfLargeFile && (
              <p className="text-sm text-muted-foreground">
                {t('learningHub:file.loadingLargeFile', '正在加载大文件，请稍候...')}
              </p>
            )}
          </div>
        );
      }
      if (pdfError) {
        return (
          <div className="flex flex-col items-center justify-center h-full gap-4 text-destructive">
            <FileText className="w-16 h-16 opacity-50" />
            <p className="text-center">{pdfError}</p>
          </div>
        );
      }
      if (pdfFile) {
        return (
          <TextbookPdfViewer
            file={pdfFile}
            filePath=""
            fileName={node.name}
            selectedPages={selectedPages}
            onPageSelectionChange={handlePageSelectionChange}
            onExportSelectedPages={noopExportPages}
            enableAutoPrepare={false}
            focusRequest={focusRequest}
            onFocusHandled={handleFocusHandled}
            resourcePath={node.path}
          />
        );
      }
      // 正在等待加载
      return <div className="flex items-center justify-center h-full"><Loader2 className="h-8 w-8 animate-spin text-primary" /></div>;
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

    // 音频预览
    if (isAudio && mediaObjectUrl) {
      return (
        <div className="h-full flex items-center justify-center p-6">
          <audio
            controls
            src={mediaObjectUrl}
            className="w-full max-w-3xl"
            preload="metadata"
          >
            {t('learningHub:file.noPreview', '此文件类型不支持预览')}
          </audio>
        </div>
      );
    }

    // 视频预览
    if (isVideo && mediaObjectUrl) {
      return (
        <div className="h-full flex items-center justify-center bg-black/90">
          <video
            controls
            src={mediaObjectUrl}
            className="max-h-full max-w-full"
            preload="metadata"
          >
            {t('learningHub:file.noPreview', '此文件类型不支持预览')}
          </video>
        </div>
      );
    }

    // 纯文本预览（带滚动容器）
    if (textContent) {
      return (
        <div className="h-full overflow-auto">
          <pre className="whitespace-pre-wrap text-sm p-4 m-0 min-h-full text-foreground">
            {textContent}
          </pre>
        </div>
      );
    }

    // 无法预览
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4 text-muted-foreground">
        <FileIconComponent className="w-16 h-16 opacity-50" />
        <p className="text-center">
          {t('learningHub:file.noPreview', '此文件类型不支持预览')}
        </p>
        <p className="text-sm text-center">
          {t('learningHub:file.downloadHint', '您可以下载文件后使用其他应用程序打开')}
        </p>
      </div>
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
