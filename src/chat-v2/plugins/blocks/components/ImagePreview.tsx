/**
 * Chat V2 - 图片预览组件
 *
 * 用于展示生成的图片，支持全屏预览
 */

import React, { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/utils/cn';
import { NotionButton } from '@/components/ui/NotionButton';
import { openUrl } from '@/utils/urlOpener';
import { fileManager } from '@/utils/fileManager';
import {
  Loader2,
  Maximize2,
  X,
  Download,
  ExternalLink,
  AlertCircle,
} from 'lucide-react';

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
  /** 点击事件（如打开全屏） */
  onClick?: () => void;
  /** 自定义类名 */
  className?: string;
  /** 是否显示操作按钮 */
  showActions?: boolean;
}

// ============================================================================
// 全屏预览模态框
// ============================================================================

interface FullscreenModalProps {
  src: string;
  alt?: string;
  onClose: () => void;
}

const FullscreenModal: React.FC<FullscreenModalProps> = ({
  src,
  alt,
  onClose,
}) => {
  const { t } = useTranslation('chatV2');

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

  // 点击背景关闭
  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) {
        onClose();
      }
    },
    [onClose]
  );

  // ESC 键关闭
  React.useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  return (
    <div
      className={cn(
        'fixed inset-0 z-50',
        'bg-black/80 backdrop-blur-sm',
        'flex items-center justify-center',
        'p-4'
      )}
      onClick={handleBackdropClick}
    >
      {/* 操作按钮 */}
      <div className="absolute top-4 right-4 flex gap-2">
        <NotionButton variant="ghost" size="icon" iconOnly onClick={handleDownload} className="!rounded-full bg-white/10 hover:bg-white/20 text-white" aria-label={t('blocks.imageGen.download')} title={t('blocks.imageGen.download')}>
          <Download className="w-5 h-5" />
        </NotionButton>
        <NotionButton variant="ghost" size="icon" iconOnly onClick={handleOpenInNewTab} className="!rounded-full bg-white/10 hover:bg-white/20 text-white" aria-label={t('blocks.imageGen.openInNewTab')} title={t('blocks.imageGen.openInNewTab')}>
          <ExternalLink className="w-5 h-5" />
        </NotionButton>
        <NotionButton variant="ghost" size="icon" iconOnly onClick={onClose} className="!rounded-full bg-white/10 hover:bg-white/20 text-white" aria-label={t('blocks.imageGen.close')} title={t('blocks.imageGen.close')}>
          <X className="w-5 h-5" />
        </NotionButton>
      </div>

      {/* 图片 */}
      <img
        src={src}
        alt={alt || 'Fullscreen preview'}
        className="max-w-full max-h-full object-contain rounded-lg shadow-lg ring-1 ring-border/40"
      />
    </div>
  );
};

// ============================================================================
// 主组件
// ============================================================================

/**
 * ImagePreview - 图片预览组件
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
  const [isFullscreen, setIsFullscreen] = useState(false);

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
      setIsFullscreen(true);
    }
  }, [onClick]);

  const handleCloseFullscreen = useCallback(() => {
    setIsFullscreen(false);
  }, []);

  // 计算容器样式
  const containerStyle = React.useMemo(() => {
    const style: React.CSSProperties = {};
    if (width && height) {
      const aspectRatio = width / height;
      style.aspectRatio = `${aspectRatio}`;
    }
    return style;
  }, [width, height]);

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
        <AlertCircle className="w-8 h-8" />
        <span className="text-xs">{t('blocks.imageGen.loadError')}</span>
      </div>
    );
  }

  return (
    <>
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
            <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
          </div>
        )}

        {/* 图片 */}
        <img
          src={src}
          alt={alt || 'Generated image'}
          className={cn(
            'w-full h-auto rounded-lg object-contain',
            'cursor-pointer transition-transform hover:scale-[1.02]',
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
              <NotionButton variant="ghost" size="icon" iconOnly onClick={handleClick} className="!rounded-full bg-white/20 hover:bg-white/30 text-white" aria-label={t('blocks.imageGen.fullscreen')} title={t('blocks.imageGen.fullscreen')}>
                <Maximize2 className="w-5 h-5" />
              </NotionButton>
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
              'opacity-0 group-hover:opacity-100 transition-opacity'
            )}
          >
            {width} × {height}
          </div>
        )}
      </div>

      {/* 全屏模态框 */}
      {isFullscreen && (
        <FullscreenModal src={src} alt={alt} onClose={handleCloseFullscreen} />
      )}
    </>
  );
};

export default ImagePreview;
