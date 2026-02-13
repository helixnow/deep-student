/**
 * 通用文件查看器包装组件
 *
 * 用于显示不支持预览的文件类型的基本信息。
 *
 * @see 21-VFS虚拟文件系统架构设计.md 第四章 4.8
 */

import React, { useEffect, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, AlertCircle, File, Download, Info, RefreshCw } from 'lucide-react';
import type { EditorProps, CreateEditorProps } from '../editorTypes';
import { pathUtils } from '../utils/pathUtils';
import { dstu } from '../api';
import { cn } from '@/lib/utils';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { fileManager } from '@/utils/fileManager';

interface FileInfo {
  name: string;
  size: number;
  type: string;
  createdAt: number;
  updatedAt: number;
  /** 源文件路径（用于下载） */
  sourcePath?: string;
}

/**
 * 格式化文件大小
 */
function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}

/**
 * 格式化日期
 */
function formatDate(timestamp: number): string {
  return new Date(timestamp).toLocaleString();
}

/**
 * 通用文件查看器包装组件
 */
export const FileViewerWrapper: React.FC<EditorProps | CreateEditorProps> = (props) => {
  const { t } = useTranslation(['dstu', 'common']);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [fileInfo, setFileInfo] = useState<FileInfo | null>(null);
  const [isDownloading, setIsDownloading] = useState(false);

  // 判断是否为创建模式（通用文件不支持创建模式）
  const isCreateMode = 'mode' in props && props.mode === 'create';

  // 解析路径获取信息
  const pathInfo = !isCreateMode && 'path' in props ? pathUtils.parse(props.path) : null;

  // 解析路径用于加载
  const path = !isCreateMode && 'path' in props ? props.path : null;

  // 加载文件信息
  const loadFileInfo = useCallback(async () => {
    if (isCreateMode) {
      setError(t('dstu:errors.internal'));
      setIsLoading(false);
      return;
    }

    if (!path) return;

    setIsLoading(true);
    setError(null);

    const result = await dstu.get(path);
    setIsLoading(false);

    if (result.ok) {
      const node = result.value;
      setFileInfo({
        name: node?.name || pathInfo?.id || 'unknown',
        size: (node?.size as number) || 0,
        type: (node?.metadata?.mimeType as string) || 'application/octet-stream',
        createdAt: node?.createdAt || Date.now(),
        updatedAt: node?.updatedAt || Date.now(),
        sourcePath: (node?.metadata?.filePath as string) || undefined,
      });
    } else {
      const errMsg = result.error.toUserMessage();
      setError(errMsg);
      showGlobalNotification('error', errMsg);
    }
  }, [isCreateMode, path, pathInfo?.id, t]);

  useEffect(() => {
    void loadFileInfo();
  }, [loadFileInfo]);

  // 下载处理
  const handleDownload = useCallback(async () => {
    if (!fileInfo?.sourcePath) {
      showGlobalNotification('error', t('dstu:preview.downloadUnavailable'));
      return;
    }

    setIsDownloading(true);
    try {
      // 获取文件扩展名
      const ext = fileInfo.name.split('.').pop() || '';
      const filters = ext
        ? [{ name: ext.toUpperCase(), extensions: [ext] }]
        : undefined;

      const result = await fileManager.saveFromSource({
        sourcePath: fileInfo.sourcePath,
        title: t('common:saveAs'),
        defaultFileName: fileInfo.name,
        filters,
      });

      if (!result.canceled && result.path) {
        showGlobalNotification('success', t('common:downloadSuccess'));
      }
    } catch (err: unknown) {
      console.error('[FileViewerWrapper] Download failed:', err);
      showGlobalNotification('error', t('common:downloadFailed'));
    } finally {
      setIsDownloading(false);
    }
  }, [fileInfo, t]);

  // 加载状态
  if (isLoading) {
    return (
      <div className={cn('flex items-center justify-center h-full py-8', props.className)}>
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
        <span className="ml-2 text-muted-foreground">{t('dstu:preview.loading')}</span>
      </div>
    );
  }

  // 错误状态
  if (error) {
    const onClose = 'onClose' in props ? props.onClose : undefined;
    return (
      <div className={cn('flex flex-col items-center justify-center h-full py-8 gap-4', props.className)}>
        <AlertCircle className="w-8 h-8 text-destructive" />
        <span className="text-destructive text-center max-w-md">{error}</span>
        <div className="flex gap-2">
          <button
            className="inline-flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-md hover:bg-primary/90"
            onClick={() => void loadFileInfo()}
          >
            <RefreshCw className="w-4 h-4" />
            {t('common:actions.retry')}
          </button>
          {onClose && (
            <button
              className="px-4 py-2 border rounded-md hover:bg-muted"
              onClick={onClose}
            >
              {t('common:actions.close')}
            </button>
          )}
        </div>
      </div>
    );
  }

  // 文件查看器 UI
  return (
    <div className={cn('flex flex-col h-full', props.className)}>
      {/* 工具栏 */}
      <div className="flex-shrink-0 flex items-center justify-between px-4 py-2 bg-muted/50 border-b">
        <div className="flex items-center gap-2">
          <File className="w-5 h-5 text-muted-foreground" />
          <span className="text-sm font-medium">{fileInfo?.name}</span>
        </div>
        {'onClose' in props && props.onClose && (
          <button
            className="px-3 py-1 text-sm border rounded-md hover:bg-muted"
            onClick={props.onClose}
          >
            {t('common:actions.close')}
          </button>
        )}
      </div>

      {/* 文件信息 */}
      <div className="flex-1 flex items-center justify-center bg-muted/20 p-4">
        <div className="text-center max-w-md">
          <File className="w-20 h-20 mx-auto mb-4 text-muted-foreground/50" />
          <h3 className="text-lg font-medium mb-2">{fileInfo?.name}</h3>
          <p className="text-muted-foreground mb-4">
            {t('dstu:preview.noPreview')}
          </p>

          {/* 文件详情 */}
          <div className="text-left bg-background border rounded-lg p-4 space-y-2">
            <div className="flex items-center gap-2 text-sm">
              <Info className="w-4 h-4 text-muted-foreground" />
              <span className="text-muted-foreground">{t('common:type')}:</span>
              <span>{fileInfo?.type}</span>
            </div>
            <div className="flex items-center gap-2 text-sm">
              <Info className="w-4 h-4 text-muted-foreground" />
              <span className="text-muted-foreground">{t('common:size')}:</span>
              <span>{fileInfo ? formatFileSize(fileInfo.size) : '-'}</span>
            </div>
            <div className="flex items-center gap-2 text-sm">
              <Info className="w-4 h-4 text-muted-foreground" />
              <span className="text-muted-foreground">{t('dstu:sort.createdAt')}:</span>
              <span>{fileInfo ? formatDate(fileInfo.createdAt) : '-'}</span>
            </div>
            <div className="flex items-center gap-2 text-sm">
              <Info className="w-4 h-4 text-muted-foreground" />
              <span className="text-muted-foreground">{t('dstu:sort.updatedAt')}:</span>
              <span>{fileInfo ? formatDate(fileInfo.updatedAt) : '-'}</span>
            </div>
          </div>

          {/* 下载按钮 */}
          <button
            className="mt-4 inline-flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-md hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
            onClick={handleDownload}
            disabled={isDownloading || !fileInfo?.sourcePath}
          >
            {isDownloading ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Download className="w-4 h-4" />
            )}
            {isDownloading ? t('common:downloading') : t('common:actions.download')}
          </button>
          {!fileInfo?.sourcePath && (
            <p className="mt-2 text-xs text-muted-foreground">
              {t('dstu:preview.downloadUnavailable')}
            </p>
          )}
        </div>
      </div>
    </div>
  );
};

export default FileViewerWrapper;
