/**
 * Chat V2 - 图片预览组件
 *
 * 用于展示生成的图片。
 * 2026-07 改造：移除全屏 Modal，放大改为消息流内联展开
 * （原图尺寸 + 可滚动查看 + 下载/外部打开操作，禁模态框）。
 */

import React, { useState, useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/utils/cn';
import './image-preview.css';
import { DsButton } from '@/components/ui/DsButton';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { openUrl } from '@/utils/urlOpener';
import { fileManager } from '@/utils/fileManager';
import {
  CircleNotch,
  ArrowsOut,
  ArrowsIn,
  Download,
  ArrowSquareOut,
  WarningCircle,
} from '@phosphor-icons/react';

// ============================================================================
// 类型定义
// ============================================================================

export interface ImagePreviewProps {
  /** 图片 URL */
  src: string;
  /** 图片描述 */
  alt?: string;
  /** 图片宽度 */
  width?: number;
  /** 图片高度 */
  height?: number;
  /** 点击事件（覆盖默认的内联展开行为） */
  onClick?: () => void;
  /** 自定义类名 */
  className?: string;
  /** 是否显示操作按钮 */
  showActions?: boolean;
}

// ============================================================================
// 主组件
// ============================================================================

/**
 * ImagePreview - 图片预览组件
 *
 * 默认显示适配容器宽度的预览；点击后在消息流内联展开为
 * 原始尺寸（可滚动）视图，并提供下载/外部打开/收起操作。
 */
export const ImagePreview: React.FC<ImagePreviewProps> = ({
  src,
  alt,
  width,
  height,
  onClick,
  className,
  showActions = true,
}) => {
  const { t } = useTranslation('chatV2');
  const [isLoading, setIsLoading] = useState(true);
  const [hasError, setHasError] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);

  const handleLoad = useCallback(() => {
    setIsLoading(false);
    setHasError(false);
  }, []);

  const handleError = useCallback(() => {
    setIsLoading(false);
    setHasError(true);
  }, []);

  const handleClick = useCallback(() => {
    if (onClick) {
      onClick();
    } else {
      setIsExpanded(true);
    }
  }, [onClick]);

  const handleCollapse = useCallback(() => {
    setIsExpanded(false);
  }, []);

  // 展开态支持 Escape 收起（无焦点陷阱的内联展开，仅监听 Escape）
  useEffect(() => {
    if (!isExpanded) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsExpanded(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isExpanded]);

  const handleDownload = useCallback(async () => {
    try {
      const response = await fetch(src);
      const blob = await response.blob();
      const arrayBuffer = await blob.arrayBuffer();
      const ext = blob.type.split('/')[1]?.replace('jpeg', 'jpg') || 'png';
      const fileName = `${alt || 'image'}.${ext}`;
      await fileManager.saveBinaryFile({
        title: fileName,
        defaultFileName: fileName,
        data: new Uint8Array(arrayBuffer),
        filters: [{ name: 'Images', extensions: [ext] }],
      });
    } catch (error) {
      console.error('[ImagePreview] Download failed:', error);
    }
  }, [src, alt]);

  const handleOpenInNewTab = useCallback(() => {
    openUrl(src);
  }, [src]);

  // 计算容器样式
  const containerStyle = React.useMemo(() => {
    const style: React.CSSProperties = {};
    if (width && height && !isExpanded) {
      const aspectRatio = width / height;
      style.aspectRatio = `${aspectRatio}`;
    }
    return style;
  }, [width, height, isExpanded]);

  if (hasError) {
    return (
      <div
        className={cn(
          'flex flex-col items-center justify-center gap-2 p-4',
          'bg-muted/30 dark:bg-muted/20 rounded-lg',
          'border border-border/30',
          'text-muted-foreground',
          className
        )}
      >
        <WarningCircle size={32} />
        <span className="text-xs">{t('blocks.imageGen.loadError')}</span>
      </div>
    );
  }

  // ========== 内联展开视图：原始尺寸 + 滚动查看 ==========
  if (isExpanded) {
    return (
      <div className={cn('rounded-lg border border-border/50 overflow-hidden bg-muted/20', className)}>
        {/* 操作栏 */}
        <div className="flex items-center justify-between gap-2 px-2 py-1.5 border-b border-border/30 bg-muted/30">
          <span className="text-xs text-muted-foreground truncate" title={alt}>
            {width && height ? `${width} × ${height}` : alt || ''}
          </span>
          <div className="flex items-center gap-1">
            <DsButton
              variant="ghost"
              size="icon"
              iconOnly
              onClick={handleDownload}
              aria-label={t('blocks.imageGen.download')}
              title={t('blocks.imageGen.download')}
            >
              <Download size={16} />
            </DsButton>
            <DsButton
              variant="ghost"
              size="icon"
              iconOnly
              onClick={handleOpenInNewTab}
              aria-label={t('blocks.imageGen.openInNewTab')}
              title={t('blocks.imageGen.openInNewTab')}
            >
              <ArrowSquareOut size={16} />
            </DsButton>
            <DsButton
              variant="ghost"
              size="icon"
              iconOnly
              onClick={handleCollapse}
              aria-label={t('blocks.imageGen.collapse')}
              title={t('blocks.imageGen.collapse')}
            >
              <ArrowsIn size={16} />
            </DsButton>
          </div>
        </div>

        {/* 原始尺寸滚动区（内联展开，非模态） */}
        <CustomScrollArea
          orientation="both"
          fullHeight={false}
          className="max-h-[70vh]"
          viewportClassName="max-h-[70vh]"
        >
          <img
            src={src}
            alt={alt || 'Generated image'}
            className="max-w-none cursor-zoom-out"
            onClick={handleCollapse}
            draggable={false}
          />
        </CustomScrollArea>
      </div>
    );
  }

  // ========== 默认视图：适配宽度预览 ==========
  return (
    <div
      className={cn('image-preview relative group', className)}
      style={containerStyle}
    >
      {/* 加载状态 */}
      {isLoading && (
        <div
          className={cn(
            'absolute inset-0 flex items-center justify-center',
            'bg-muted/30 dark:bg-muted/20 rounded-lg'
          )}
        >
          <CircleNotch size={24} className="animate-spin text-muted-foreground" />
        </div>
      )}

      {/* 图片 */}
      <img
        src={src}
        alt={alt || 'Generated image'}
        className={cn(
          'w-full h-auto rounded-lg object-contain',
          'cursor-zoom-in transition-transform hover:scale-[1.02]',
          isLoading && 'opacity-0'
        )}
        onLoad={handleLoad}
        onError={handleError}
        onClick={handleClick}
        loading="lazy"
      />

      {/* 操作按钮覆盖层 */}
      {showActions && !isLoading && (
        <div
          className={cn(
            'absolute inset-0 flex items-center justify-center',
            'bg-black/40 opacity-0 group-hover:opacity-100',
            'transition-opacity rounded-lg',
            'pointer-events-none'
          )}
        >
          <div className="flex items-center gap-2 text-white pointer-events-auto">
            <DsButton variant="ghost" size="icon" iconOnly onClick={handleClick} className="!rounded-full bg-white/20 hover:bg-[var(--overlay-control-hover)] text-white" aria-label={t('blocks.imageGen.expandInline')} title={t('blocks.imageGen.expandInline')}>
              <ArrowsOut size={20} />
            </DsButton>
          </div>
        </div>
      )}

      {/* 尺寸信息 */}
      {width && height && !isLoading && (
        <div
          className={cn(
            'absolute bottom-2 right-2',
            'px-1.5 py-0.5 rounded',
            'bg-black/50 text-white text-xs',
            // 触屏无 hover：尺寸信息常显（纯信息展示，不遮挡关键内容）
            'opacity-0 group-hover:opacity-100 transition-opacity [@media(pointer:coarse)]:opacity-100'
          )}
        >
          {width} × {height}
        </div>
      )}
    </div>
  );
};

export default ImagePreview;
