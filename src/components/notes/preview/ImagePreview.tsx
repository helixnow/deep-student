/**
 * ImagePreview - 图片预览组件
 *
 * 展示图片内容，支持缩放和全屏查看
 */

import React, { useState, useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '../../../lib/utils';
import { Skeleton } from '../../ui/shad/Skeleton';
import { NotionButton } from '../../ui/NotionButton';
import {
  AlertCircle,
  Image as ImageIcon,
  ZoomIn,
  ZoomOut,
  Maximize2,
  X,
} from 'lucide-react';
import type { ImagePreviewProps } from './types';
import { CustomScrollArea } from '@/components/custom-scroll-area';

/**
 * 图片预览骨架屏
 */
const ImageSkeleton: React.FC = () => (
  <div className="flex h-full flex-col items-center justify-center gap-4 p-6">
    <Skeleton className="h-48 w-full max-w-md rounded-lg" />
    <Skeleton className="h-4 w-32" />
  </div>
);

/**
 * 图片预览组件
 */
export const ImagePreview: React.FC<ImagePreviewProps> = ({
  imageUrl,
  title,
  loading = false,
  error = null,
  className,
}) => {
  const { t } = useTranslation(['notes']);
  const [imgError, setImgError] = useState(false);
  const [imgLoading, setImgLoading] = useState(true);
  const [scale, setScale] = useState(1);
  const [isFullscreen, setIsFullscreen] = useState(false);

  // 处理图片加载完成
  const handleImageLoad = useCallback(() => {
    setImgLoading(false);
    setImgError(false);
  }, []);

  // 处理图片加载错误
  const handleImageError = useCallback(() => {
    setImgLoading(false);
    setImgError(true);
  }, []);

  // 放大
  const handleZoomIn = useCallback(() => {
    setScale((prev) => Math.min(prev + 0.25, 3));
  }, []);

  // 缩小
  const handleZoomOut = useCallback(() => {
    setScale((prev) => Math.max(prev - 0.25, 0.5));
  }, []);

  // 重置缩放
  const handleResetZoom = useCallback(() => {
    setScale(1);
  }, []);

  // 切换全屏
  const toggleFullscreen = useCallback(() => {
    setIsFullscreen((prev) => !prev);
    setScale(1);
  }, []);

  // ★ Escape 键关闭全屏
  useEffect(() => {
    if (!isFullscreen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsFullscreen(false);
        setScale(1);
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isFullscreen]);

  // 加载状态
  if (loading) {
    return (
      <div className={cn('h-full', className)}>
        <ImageSkeleton />
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

  // 空 URL
  if (!imageUrl) {
    return (
      <div
        className={cn(
          'flex h-full flex-col items-center justify-center gap-3 p-6 text-center',
          className
        )}
      >
        <ImageIcon className="h-10 w-10 text-muted-foreground/50" />
        <p className="text-sm text-muted-foreground">
          {t('notes:previewPanel.image.noImage')}
        </p>
      </div>
    );
  }

  return (
    <>
      {/* 主预览区域 */}
      <div
        className={cn(
          'relative flex h-full flex-col',
          className
        )}
      >
        {/* 工具栏 */}
        <div className="flex items-center justify-between border-b border-border bg-background/95 px-3 py-2 backdrop-blur supports-[backdrop-filter]:bg-background/60">
          <span className="text-sm text-muted-foreground line-clamp-1">
            {title || t('notes:previewPanel.image.preview')}
          </span>
          <div className="flex items-center gap-1">
            <NotionButton
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0"
              onClick={handleZoomOut}
              disabled={scale <= 0.5}
              title={t('notes:previewPanel.image.zoomOut')}
            >
              <ZoomOut className="h-4 w-4" />
            </NotionButton>
            <span className="min-w-[3rem] text-center text-xs text-muted-foreground">
              {Math.round(scale * 100)}%
            </span>
            <NotionButton
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0"
              onClick={handleZoomIn}
              disabled={scale >= 3}
              title={t('notes:previewPanel.image.zoomIn')}
            >
              <ZoomIn className="h-4 w-4" />
            </NotionButton>
            <NotionButton
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0"
              onClick={toggleFullscreen}
              title={t('notes:previewPanel.image.fullscreen')}
            >
              <Maximize2 className="h-4 w-4" />
            </NotionButton>
          </div>
        </div>

        {/* 图片容器 */}
        <CustomScrollArea className="relative flex-1 bg-muted/20">
          {/* 加载中 */}
          {imgLoading && !imgError && (
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
            </div>
          )}

          {/* 图片加载失败 */}
          {imgError && (
            <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
              <AlertCircle className="h-10 w-10 text-destructive" />
              <p className="text-sm text-muted-foreground">
                {t('notes:previewPanel.image.loadError')}
              </p>
            </div>
          )}

          {/* 图片 */}
          {!imgError && (
            <div
              className="flex min-h-full items-center justify-center p-4"
              onDoubleClick={handleResetZoom}
            >
              <img
                src={imageUrl}
                alt={title || t('notes:previewPanel.image.preview')}
                className="object-contain transition-all duration-200"
                style={{
                  width: scale !== 1 ? `${Math.round(scale * 100)}%` : undefined,
                  maxWidth: scale > 1 ? 'none' : '100%',
                  opacity: imgLoading ? 0 : 1,
                }}
                onLoad={handleImageLoad}
                onError={handleImageError}
                draggable={false}
              />
            </div>
          )}
        </CustomScrollArea>
      </div>

      {/* 全屏遮罩 */}
      {isFullscreen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/90"
          onClick={toggleFullscreen}
        >
          {/* 关闭按钮 */}
          <NotionButton
            variant="ghost"
            size="sm"
            className="absolute right-4 top-4 h-10 w-10 p-0 text-white hover:bg-white/10"
            onClick={toggleFullscreen}
          >
            <X className="h-6 w-6" />
          </NotionButton>

          {/* 缩放控制 */}
          <div className="absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-lg bg-black/50 px-3 py-2">
            <NotionButton
              variant="ghost"
              size="sm"
              className="h-8 w-8 p-0 text-white hover:bg-white/10"
              onClick={(e) => {
                e.stopPropagation();
                handleZoomOut();
              }}
              disabled={scale <= 0.5}
            >
              <ZoomOut className="h-4 w-4" />
            </NotionButton>
            <span className="min-w-[3rem] text-center text-sm text-white">
              {Math.round(scale * 100)}%
            </span>
            <NotionButton
              variant="ghost"
              size="sm"
              className="h-8 w-8 p-0 text-white hover:bg-white/10"
              onClick={(e) => {
                e.stopPropagation();
                handleZoomIn();
              }}
              disabled={scale >= 3}
            >
              <ZoomIn className="h-4 w-4" />
            </NotionButton>
          </div>

          {/* 全屏图片 */}
          <img
            src={imageUrl}
            alt={title || t('notes:previewPanel.image.preview')}
            className="object-contain transition-all duration-200"
            style={{
              maxHeight: '90vh',
              maxWidth: scale <= 1 ? '90vw' : 'none',
              width: scale !== 1 ? `${Math.round(scale * 90)}vw` : undefined,
            }}
            onClick={(e) => e.stopPropagation()}
            draggable={false}
          />
        </div>
      )}
    </>
  );
};

export default ImagePreview;
