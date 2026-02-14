/**
 * PDFPreview - PDF 文档预览组件
 *
 * 对于学习资源管理器中的教材引用，提供简洁的 PDF 预览或打开提示
 */

import React, { useCallback, useMemo, useState } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { useTranslation } from 'react-i18next';
import { cn } from '../../../lib/utils';
import { Skeleton } from '../../ui/shad/Skeleton';
import { NotionButton } from '../../ui/NotionButton';
import { AlertCircle, BookOpen, ExternalLink, FileText } from 'lucide-react';
import { getErrorMessage } from '../../../utils/errorUtils';
import type { PDFPreviewProps } from './types';
import { EnhancedPdfViewer } from '../../pdf/EnhancedPdfViewer';
import { cleanBase64String, estimateBase64Size, LARGE_FILE_THRESHOLD } from '@/utils/base64FileUtils';
import { openUrl } from '@/utils/urlOpener';

/**
 * PDF 预览骨架屏
 */
const PDFSkeleton: React.FC = () => (
  <div className="flex h-full flex-col items-center justify-center gap-4 p-6">
    <Skeleton className="h-24 w-24 rounded-lg" />
    <Skeleton className="h-5 w-48" />
    <Skeleton className="h-4 w-32" />
  </div>
);

/**
 * PDF 预览组件
 *
 * 由于在预览面板中直接嵌入 PDF 阅读器会占用较多资源，
 * 这里采用"点击打开"的方式，显示 PDF 基本信息和打开按钮
 */
export const PDFPreview: React.FC<PDFPreviewProps> = ({
  filePath,
  fileName,
  base64Content,
  fileSize,
  loading = false,
  error = null,
  className,
}) => {
  const { t } = useTranslation(['notes', 'common']);
  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
  const [inlineOpen, setInlineOpen] = useState(false);

  // 从路径提取文件名
  const displayName = fileName || filePath.split(/[/\\]/).pop() || t('notes:previewPanel.pdf.unknownFile');

  const normalizedFilePath = useMemo(() => {
    if (!filePath) return '';
    return filePath.startsWith('file://') ? filePath.replace(/^file:\/\//, '') : filePath;
  }, [filePath]);

  const isRemoteUrl =
    normalizedFilePath.startsWith('http') ||
    normalizedFilePath.startsWith('asset://') ||
    normalizedFilePath.startsWith('data:');

  const pdfUrl = useMemo(() => {
    if (!normalizedFilePath) return '';
    if (isRemoteUrl) return normalizedFilePath;
    // 使用 Tauri 官方 API 构建跨平台协议 URL
    // Windows WebView2: http://pdfstream.localhost/<encoded_path>
    // macOS/Linux:      pdfstream://localhost/<encoded_path>
    return convertFileSrc(normalizedFilePath, 'pdfstream');
  }, [normalizedFilePath, isRemoteUrl]);

  const dataUrlBase64 = useMemo(() => {
    if (!pdfUrl.startsWith('data:')) return '';
    const commaIndex = pdfUrl.indexOf(',');
    return commaIndex >= 0 ? pdfUrl.slice(commaIndex + 1) : '';
  }, [pdfUrl]);

  const cleanedBase64 = useMemo(() => (base64Content ? cleanBase64String(base64Content) : ''), [base64Content]);
  const base64TooLarge = useMemo(() => {
    if (!cleanedBase64) return false;
    return estimateBase64Size(cleanedBase64) > LARGE_FILE_THRESHOLD;
  }, [cleanedBase64]);
  const dataUrlTooLarge = useMemo(() => {
    if (!dataUrlBase64) return false;
    return estimateBase64Size(dataUrlBase64) > LARGE_FILE_THRESHOLD;
  }, [dataUrlBase64]);
  const fileTooLarge = typeof fileSize === 'number' && fileSize > LARGE_FILE_THRESHOLD;

  const pdfBytes = useMemo(() => {
    if (!inlineOpen || !cleanedBase64 || pdfUrl || base64TooLarge) return null;
    try {
      const binary = atob(cleanedBase64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      return bytes;
    } catch (err: unknown) {
      console.error('[PDFPreview] Failed to decode base64 PDF:', err);
      return null;
    }
  }, [inlineOpen, cleanedBase64, pdfUrl, base64TooLarge]);

  /**
   * 打开 PDF 文件（使用系统默认应用或跳转到教材页面）
   */
  const handleOpenPdf = useCallback(async () => {
    if (!normalizedFilePath && !filePath) return;

    setOpening(true);
    setOpenError(null);

    try {
      const targetPath = normalizedFilePath || filePath;
      if (targetPath.startsWith('http') || targetPath.startsWith('asset://') || targetPath.startsWith('data:')) {
        openUrl(targetPath);
      } else {
        // 使用 Tauri opener 插件打开文件（系统默认应用）
        const { openPath } = await import('@tauri-apps/plugin-opener');
        await openPath(targetPath);
      }
    } catch (err: unknown) {
      console.error('[PDFPreview] Failed to open PDF:', err);
      setOpenError(getErrorMessage(err));
    } finally {
      setOpening(false);
    }
  }, [filePath, normalizedFilePath]);

  const canInlinePreview = pdfUrl
    ? !dataUrlTooLarge
    : !!cleanedBase64 && !base64TooLarge;
  const canOpenSystem = Boolean(normalizedFilePath || filePath);
  const showActionButtons = canInlinePreview || canOpenSystem;

  // 加载状态
  if (loading) {
    return (
      <div className={cn('h-full', className)}>
        <PDFSkeleton />
      </div>
    );
  }

  // 错误状态
  if (error) {
    return (
      <div
        className={cn(
          'flex h-full flex-col items-center justify-center gap-3 p-6 text-center',
          className
        )}
      >
        <AlertCircle className="h-10 w-10 text-destructive" />
        <p className="text-sm text-muted-foreground">{error}</p>
      </div>
    );
  }

  if (inlineOpen) {
    const hasViewerData = Boolean((pdfUrl && !dataUrlTooLarge) || pdfBytes);
    return (
      <div className={cn('flex h-full flex-col', className)}>
        <div className="flex items-center justify-between border-b border-border bg-background/95 px-3 py-2 backdrop-blur supports-[backdrop-filter]:bg-background/60">
          <span className="text-sm font-medium text-foreground truncate">{displayName}</span>
          <div className="flex items-center gap-2">
            {canOpenSystem && (
              <NotionButton
                variant="ghost"
                size="sm"
                onClick={handleOpenPdf}
                disabled={opening}
                className="gap-1"
              >
                <ExternalLink className="h-4 w-4" />
                {t('notes:previewPanel.pdf.openSystem')}
              </NotionButton>
            )}
            <NotionButton
              variant="ghost"
              size="sm"
              onClick={() => setInlineOpen(false)}
              className="gap-1"
            >
              {t('common:back')}
            </NotionButton>
          </div>
        </div>
        <div className="flex-1 min-h-0">
          {hasViewerData ? (
            <EnhancedPdfViewer
              url={pdfBytes ? undefined : pdfUrl || undefined}
              data={pdfBytes ?? undefined}
              fileName={displayName}
              className="h-full"
            />
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              {base64TooLarge || dataUrlTooLarge
                ? t('notes:previewPanel.pdf.tooLarge')
                : t('notes:previewPanel.pdf.noFile')}
            </div>
          )}
        </div>
      </div>
    );
  }

  // 空路径
  if (!filePath && !base64Content) {
    return (
      <div
        className={cn(
          'flex h-full flex-col items-center justify-center gap-3 p-6 text-center',
          className
        )}
      >
        <FileText className="h-10 w-10 text-muted-foreground/50" />
        <p className="text-sm text-muted-foreground">
          {fileTooLarge
            ? t('notes:previewPanel.pdf.tooLarge')
            : t('notes:previewPanel.pdf.noFile')}
        </p>
      </div>
    );
  }

  return (
    <div
      className={cn(
        'flex h-full flex-col items-center justify-center gap-6 p-6',
        className
      )}
    >
      {/* PDF 图标 */}
      <div className="flex h-24 w-24 items-center justify-center rounded-xl bg-muted">
        <BookOpen className="h-12 w-12 text-muted-foreground" />
      </div>

      {/* 文件名 */}
      <div className="text-center">
        <h3 className="mb-1 text-base font-medium text-foreground line-clamp-2">
          {displayName}
        </h3>
        <p className="text-xs text-muted-foreground">
          {t('notes:previewPanel.pdf.type')}
        </p>
      </div>

      {/* 打开按钮 */}
      {showActionButtons && (
        <div className="flex flex-col items-center gap-3">
          {canInlinePreview && (
            <NotionButton
              variant="default"
              size="md"
              onClick={() => setInlineOpen(true)}
              className="gap-2"
            >
              <BookOpen className="h-4 w-4" />
              {t('notes:previewPanel.pdf.openInline')}
            </NotionButton>
          )}
          {canOpenSystem && (
            <NotionButton
              variant="ghost"
              size="md"
              onClick={handleOpenPdf}
              disabled={opening}
              className="gap-2"
            >
              {opening ? (
                <>
                  <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
                  {t('notes:previewPanel.pdf.opening')}
                </>
              ) : (
                <>
                  <ExternalLink className="h-4 w-4" />
                  {t('notes:previewPanel.pdf.openSystem')}
                </>
              )}
            </NotionButton>
          )}
        </div>
      )}

      {/* 打开错误提示 */}
      {openError && (
        <p className="text-xs text-destructive">{openError}</p>
      )}

      {/* 提示文字 */}
      <p className="max-w-xs text-center text-xs text-muted-foreground">
        {!showActionButtons && (base64TooLarge || dataUrlTooLarge || fileTooLarge)
          ? t('notes:previewPanel.pdf.tooLarge')
          : canInlinePreview
            ? t('notes:previewPanel.pdf.inlineHint')
            : t('notes:previewPanel.pdf.hint')}
      </p>
    </div>
  );
};

export default PDFPreview;
