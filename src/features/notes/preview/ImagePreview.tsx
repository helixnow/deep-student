/**
 * ImagePreview - 图片预览组件
 *
 * 面板内内联缩放查看器（无全屏遮罩）：
 * - 滚轮以光标为中心缩放，工具栏 ± 按钮步进缩放
 * - 放大后按住拖拽平移，双击复位
 * - 工具栏常驻缩放百分比指示 + 一键复位
 */

import React, { useState, useCallback, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '../../../lib/utils';
import { Skeleton } from '@/components/ui/shad/Skeleton';
import { NotionButton } from '@/components/ui/NotionButton';
import { CommonTooltip } from '@/components/shared/CommonTooltip';
import {
  WarningCircle,
  Image as ImageIcon,
  MagnifyingGlassPlus,
  MagnifyingGlassMinus,
  ArrowCounterClockwise,
} from '@phosphor-icons/react';
import type { ImagePreviewProps } from './types';

const MIN_SCALE = 0.25;
const MAX_SCALE = 8;
const BUTTON_ZOOM_FACTOR = 1.25;
/** 滚轮 deltaY → 缩放指数系数（触控板/滚轮均平滑） */
const WHEEL_ZOOM_INTENSITY = 0.0015;

interface ViewTransform {
  scale: number;
  tx: number;
  ty: number;
}

const IDENTITY: ViewTransform = { scale: 1, tx: 0, ty: 0 };

function clampScale(scale: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

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
  const [view, setView] = useState<ViewTransform>(IDENTITY);
  const [isPanning, setIsPanning] = useState(false);

  const viewportRef = useRef<HTMLDivElement | null>(null);
  const panSession = useRef<{ pointerId: number; startX: number; startY: number; originTx: number; originTy: number } | null>(null);

  // URL 变化时复位视图与加载状态
  useEffect(() => {
    setImgError(false);
    setImgLoading(true);
    setView(IDENTITY);
  }, [imageUrl]);

  const handleImageLoad = useCallback(() => {
    setImgLoading(false);
    setImgError(false);
  }, []);

  const handleImageError = useCallback(() => {
    setImgLoading(false);
    setImgError(true);
  }, []);

  /** 以视口中心为锚点的缩放（工具栏按钮 / 快捷键用） */
  const zoomBy = useCallback((factor: number) => {
    setView((prev) => {
      const scale = clampScale(prev.scale * factor);
      if (scale === prev.scale) return prev;
      const ratio = scale / prev.scale;
      return { scale, tx: prev.tx * ratio, ty: prev.ty * ratio };
    });
  }, []);

  const resetView = useCallback(() => {
    setView(IDENTITY);
  }, []);

  // 滚轮缩放：以光标为中心；必须 passive:false 才能 preventDefault 阻止页面滚动
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = viewport.getBoundingClientRect();
      const px = event.clientX - rect.left - rect.width / 2;
      const py = event.clientY - rect.top - rect.height / 2;
      const factor = Math.exp(-event.deltaY * WHEEL_ZOOM_INTENSITY);
      setView((prev) => {
        const scale = clampScale(prev.scale * factor);
        if (scale === prev.scale) return prev;
        const ratio = scale / prev.scale;
        // 光标下的内容点在缩放前后保持不动
        return {
          scale,
          tx: px - (px - prev.tx) * ratio,
          ty: py - (py - prev.ty) * ratio,
        };
      });
    };

    viewport.addEventListener('wheel', onWheel, { passive: false });
    return () => viewport.removeEventListener('wheel', onWheel);
  }, []);

  const handlePointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    panSession.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originTx: view.tx,
      originTy: view.ty,
    };
    setIsPanning(true);
  }, [view.tx, view.ty]);

  const handlePointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const session = panSession.current;
    if (!session || session.pointerId !== event.pointerId) return;
    setView((prev) => ({
      ...prev,
      tx: session.originTx + (event.clientX - session.startX),
      ty: session.originTy + (event.clientY - session.startY),
    }));
  }, []);

  const endPan = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const session = panSession.current;
    if (!session || session.pointerId !== event.pointerId) return;
    panSession.current = null;
    setIsPanning(false);
  }, []);

  const handleKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === '+' || event.key === '=') {
      event.preventDefault();
      zoomBy(BUTTON_ZOOM_FACTOR);
    } else if (event.key === '-') {
      event.preventDefault();
      zoomBy(1 / BUTTON_ZOOM_FACTOR);
    } else if (event.key === '0') {
      event.preventDefault();
      resetView();
    }
  }, [zoomBy, resetView]);

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
        <WarningCircle className="h-10 w-10 text-destructive" />
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

  const isDefaultView = view.scale === 1 && view.tx === 0 && view.ty === 0;

  return (
    <div className={cn('relative flex h-full flex-col', className)}>
      {/* 工具栏 */}
      <div data-wb-blur-surface className="flex items-center justify-between border-b border-border bg-background/95 px-3 py-2 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <span className="text-sm text-muted-foreground line-clamp-1">
          {title || t('notes:previewPanel.image.preview')}
        </span>
        <div className="flex items-center gap-1">
          <CommonTooltip content={<p className="text-xs">{t('notes:previewPanel.image.zoomOut')}</p>} position="bottom">
            <NotionButton
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0"
              onClick={() => zoomBy(1 / BUTTON_ZOOM_FACTOR)}
              disabled={view.scale <= MIN_SCALE}
              aria-label={t('notes:previewPanel.image.zoomOut')}
            >
              <MagnifyingGlassMinus size={16} />
            </NotionButton>
          </CommonTooltip>
          <span
            className="min-w-[3rem] select-none text-center text-xs tabular-nums text-muted-foreground"
            aria-live="polite"
          >
            {Math.round(view.scale * 100)}%
          </span>
          <CommonTooltip content={<p className="text-xs">{t('notes:previewPanel.image.zoomIn')}</p>} position="bottom">
            <NotionButton
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0"
              onClick={() => zoomBy(BUTTON_ZOOM_FACTOR)}
              disabled={view.scale >= MAX_SCALE}
              aria-label={t('notes:previewPanel.image.zoomIn')}
            >
              <MagnifyingGlassPlus size={16} />
            </NotionButton>
          </CommonTooltip>
          <CommonTooltip content={<p className="text-xs">{t('notes:wikilinkV2.imageResetZoom')}</p>} position="bottom">
            <NotionButton
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0"
              onClick={resetView}
              disabled={isDefaultView}
              aria-label={t('notes:wikilinkV2.imageResetZoom')}
            >
              <ArrowCounterClockwise size={16} />
            </NotionButton>
          </CommonTooltip>
        </div>
      </div>

      {/* 内联缩放视口（overflow-hidden + transform，替代原全屏灯箱） */}
      <div
        ref={viewportRef}
        role="img"
        aria-label={title || t('notes:previewPanel.image.preview')}
        tabIndex={0}
        className={cn(
          'relative flex-1 touch-none select-none overflow-hidden bg-muted/20 outline-none',
          'focus-visible:ring-1 focus-visible:ring-ring',
          imgError ? 'cursor-default' : isPanning ? 'cursor-grabbing' : 'cursor-grab'
        )}
        onPointerDown={imgError ? undefined : handlePointerDown}
        onPointerMove={imgError ? undefined : handlePointerMove}
        onPointerUp={endPan}
        onPointerCancel={endPan}
        onDoubleClick={imgError ? undefined : resetView}
        onKeyDown={imgError ? undefined : handleKeyDown}
        title={imgError ? undefined : t('notes:wikilinkV2.imageViewerHint')}
      >
        {/* 加载中 */}
        {imgLoading && !imgError && (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          </div>
        )}

        {/* 图片加载失败 */}
        {imgError && (
          <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
            <WarningCircle className="h-10 w-10 text-destructive" />
            <p className="text-sm text-muted-foreground">
              {t('notes:previewPanel.image.loadError')}
            </p>
          </div>
        )}

        {/* 图片 */}
        {!imgError && (
          <div className="pointer-events-none flex h-full w-full items-center justify-center p-4">
            <img
              src={imageUrl}
              alt={title || t('notes:previewPanel.image.preview')}
              className={cn(
                'max-h-full max-w-full object-contain',
                // 拖拽/滚轮跟手，不加过渡；复位与按钮缩放有轻微缓动
                !isPanning && 'transition-transform duration-150 ease-out motion-reduce:transition-none'
              )}
              style={{
                transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.scale})`,
                opacity: imgLoading ? 0 : 1,
              }}
              onLoad={handleImageLoad}
              onError={handleImageError}
              draggable={false}
            />
          </div>
        )}
      </div>
    </div>
  );
};

export default ImagePreview;
