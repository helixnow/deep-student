/**
 * 图片内容视图
 * 
 * 用于在 Learning Hub 中预览图片附件。
 * 支持缩放、全屏查看等功能。
 * 
 * ★ 2026-02 优化：渐进式加载支持
 * - 小文件（< 10MB）：直接加载 base64
 * - 大文件（>= 10MB）：显示警告，用户确认后加载
 * - 添加加载进度指示
 */

import React, { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { ZoomIn, ZoomOut, RotateCw, Maximize2, AlertTriangle } from 'lucide-react';
import { NotionButton } from '@/components/ui/NotionButton';
import { getErrorMessage } from '@/utils/errorUtils';
import type { ContentViewProps } from '../UnifiedAppPanel';
import { invoke } from '@tauri-apps/api/core';
import { CustomScrollArea } from '@/components/custom-scroll-area';

import { LARGE_FILE_THRESHOLD } from '@/utils/base64FileUtils';
import { formatFileSize } from './previewUtils';

/** 附件元数据类型 */
interface VfsAttachment {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  contentHash?: string;
}

/** 加载阶段 */
type LoadingStage = 'idle' | 'checking' | 'loading' | 'done' | 'large_file_warning';

/**
 * 图片内容视图组件
 */
const ImageContentView: React.FC<ContentViewProps> = ({
  node,
  onClose,
}) => {
  const { t } = useTranslation(['learningHub', 'common']);
  
  // 状态
  const [zoom, setZoom] = useState(100);
  const [rotation, setRotation] = useState(0);
  const [imageData, setImageData] = useState<string | null>(null);
  const [loadingStage, setLoadingStage] = useState<LoadingStage>('idle');
  const [error, setError] = useState<string | null>(null);
  const [fileSize, setFileSize] = useState<number>(0);
  const [loadStartTime, setLoadStartTime] = useState<number>(0);
  
  // 用于清理 ObjectURL
  const objectUrlRef = useRef<string | null>(null);
  
  // ★ 驱动加载耗时实时更新
  const [, setTick] = useState(0);
  useEffect(() => {
    if (loadingStage !== 'loading') return;
    const id = setInterval(() => setTick((prev) => prev + 1), 1000);
    return () => clearInterval(id);
  }, [loadingStage]);

  // 从 node 的 metadata 获取图片信息
  const metadata = node.metadata as Record<string, unknown> | undefined;
  const mimeType = (metadata?.mimeType as string) || 'image/png';

  // 清理 ObjectURL
  useEffect(() => {
    return () => {
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = null;
      }
    };
  }, []);

  // 加载图片内容的核心函数
  const loadImageContent = useCallback(async () => {
    setLoadingStage('loading');
    setLoadStartTime(Date.now());
    setError(null);
    
    try {
      // 调用后端获取附件内容
      const result = await invoke<{ content: string | null; found: boolean }>('vfs_get_attachment_content', {
        attachmentId: node.id,
      });
      
      if (result.found && result.content) {
        setImageData(result.content);
        setLoadingStage('done');
      } else {
        setError(t('learningHub:error.imageNotFound', '图片未找到'));
        setLoadingStage('idle');
      }
    } catch (err: unknown) {
      setError(getErrorMessage(err));
      setLoadingStage('idle');
    }
  }, [node.id, t]);

  // 初始化：先检查文件大小
  useEffect(() => {
    const checkAndLoad = async () => {
      setLoadingStage('checking');
      setError(null);
      
      try {
        // 先获取附件元数据
        const attachment = await invoke<VfsAttachment | null>('vfs_get_attachment', {
          attachmentId: node.id,
        });
        
        if (!attachment) {
          setError(t('learningHub:error.imageNotFound', '图片未找到'));
          setLoadingStage('idle');
          return;
        }
        
        setFileSize(attachment.size);
        
        // 检查文件大小
        if (attachment.size >= LARGE_FILE_THRESHOLD) {
          // 大文件：显示警告，让用户决定是否加载
          setLoadingStage('large_file_warning');
        } else {
          // 小文件：直接加载
          await loadImageContent();
        }
      } catch (err: unknown) {
        setError(getErrorMessage(err));
        setLoadingStage('idle');
      }
    };

    void checkAndLoad();
  }, [node.id, t, loadImageContent]);

  // 缩放控制
  const handleZoomIn = useCallback(() => {
    setZoom((prev) => Math.min(prev + 25, 400));
  }, []);

  const handleZoomOut = useCallback(() => {
    setZoom((prev) => Math.max(prev - 25, 25));
  }, []);

  const handleRotate = useCallback(() => {
    setRotation((prev) => (prev + 90) % 360);
  }, []);

  const handleReset = useCallback(() => {
    setZoom(100);
    setRotation(0);
  }, []);

  // ★ 鼠标滚轮缩放（Ctrl/Cmd + 滚轮）
  const handleWheel = useCallback((e: React.WheelEvent) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    const delta = e.deltaY > 0 ? -25 : 25;
    setZoom((prev) => Math.max(25, Math.min(400, prev + delta)));
  }, []);

  // 图片 URL
  const imageUrl = useMemo(() => {
    if (!imageData) return null;
    // 确保有正确的 data URL 前缀
    if (imageData.startsWith('data:')) {
      return imageData;
    }
    return `data:${mimeType};base64,${imageData}`;
  }, [imageData, mimeType]);

  // 检查文件大小中
  if (loadingStage === 'checking') {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
        <p className="text-sm text-muted-foreground">
          {t('learningHub:image.checkingSize', '检查文件大小...')}
        </p>
      </div>
    );
  }

  // 大文件警告
  if (loadingStage === 'large_file_warning') {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4 p-6">
        <div className="flex items-center gap-2 text-amber-500">
          <AlertTriangle className="h-8 w-8" />
        </div>
        <div className="text-center space-y-2">
          <h3 className="text-lg font-medium">
            {t('learningHub:image.largeFileWarning', '大文件警告')}
          </h3>
          <p className="text-sm text-muted-foreground max-w-md">
            {t(
              'learningHub:image.largeFileDescription',
              '此图片较大 ({{size}})，加载可能需要较长时间并占用较多内存。是否继续加载？',
              { size: formatFileSize(fileSize) }
            )}
          </p>
        </div>
        <div className="flex gap-3 mt-2">
          <NotionButton
            variant="default"
            onClick={() => {
              onClose?.();
            }}
          >
            {t('common:cancel', '取消')}
          </NotionButton>
          <NotionButton
            variant="primary"
            onClick={() => {
              void loadImageContent();
            }}
          >
            {t('learningHub:image.loadAnyway', '继续加载')}
          </NotionButton>
        </div>
      </div>
    );
  }

  // 加载中
  if (loadingStage === 'loading') {
    const elapsed = loadStartTime > 0 ? Math.floor((Date.now() - loadStartTime) / 1000) : 0;
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
        <div className="text-center">
          <p className="text-sm text-muted-foreground">
            {t('learningHub:image.loading', '加载图片中...')}
          </p>
          {fileSize > 0 && (
            <p className="text-xs text-muted-foreground mt-1">
              {formatFileSize(fileSize)}
              {elapsed > 2 && ` · ${elapsed}s`}
            </p>
          )}
        </div>
      </div>
    );
  }

  // 错误
  if (error || !imageUrl) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4 text-muted-foreground">
        <p>{error || t('learningHub:error.imageNotFound', '图片未找到')}</p>
        <NotionButton
          variant="default"
          size="sm"
          onClick={() => {
            void loadImageContent();
          }}
        >
          {t('common:retry', '重试')}
        </NotionButton>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-background">
      {/* 工具栏 */}
      <div className="flex items-center justify-between px-4 py-2 border-b bg-muted/30">
        <div className="flex items-center gap-1">
          <NotionButton
            variant="ghost"
            size="sm"
            onClick={handleZoomOut}
            disabled={zoom <= 25}
            title={t('learningHub:image.zoomOut', '缩小')}
          >
            <ZoomOut className="h-4 w-4" />
          </NotionButton>
          <span className="text-sm text-muted-foreground min-w-[4rem] text-center">
            {zoom}%
          </span>
          <NotionButton
            variant="ghost"
            size="sm"
            onClick={handleZoomIn}
            disabled={zoom >= 400}
            title={t('learningHub:image.zoomIn', '放大')}
          >
            <ZoomIn className="h-4 w-4" />
          </NotionButton>
          <NotionButton
            variant="ghost"
            size="sm"
            onClick={handleRotate}
            title={t('learningHub:image.rotate', '旋转')}
          >
            <RotateCw className="h-4 w-4" />
          </NotionButton>
          <NotionButton
            variant="ghost"
            size="sm"
            onClick={handleReset}
            title={t('learningHub:image.reset', '重置')}
          >
            <Maximize2 className="h-4 w-4" />
          </NotionButton>
        </div>
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <span className="truncate max-w-[200px]">{node.name}</span>
          {fileSize > 0 && (
            <span className="text-xs opacity-70">({formatFileSize(fileSize)})</span>
          )}
        </div>
      </div>

      {/* 图片区域（支持 Ctrl+滚轮缩放） */}
      <CustomScrollArea className="flex-1" viewportClassName="flex items-center justify-center p-4 bg-muted/10" onWheel={handleWheel}>
        <img
          src={imageUrl}
          alt={node.name}
          className="object-contain transition-all duration-200"
          style={{
            width: zoom !== 100 ? `${zoom}%` : undefined,
            maxWidth: zoom > 100 ? 'none' : '100%',
            transform: rotation ? `rotate(${rotation}deg)` : undefined,
          }}
          draggable={false}
        />
      </CustomScrollArea>
    </div>
  );
};

export default ImageContentView;
