/**
 * Chat V2 - 内联图片查看器
 *
 * 与全局 ImageViewer 不同，此组件只覆盖聊天主区域而非整个应用
 * 通过查找最近的 .chat-v2 容器并计算其边界来实现
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { cn } from '@/utils/cn';
import { NotionButton } from '@/components/ui/NotionButton';
import { openUrl } from '@/utils/urlOpener';
import {
  X,
  ZoomIn,
  ZoomOut,
  RotateCw,
  Home,
  ChevronLeft,
  ChevronRight,
  Download,
  ExternalLink,
} from 'lucide-react';
import { fileManager } from '@/utils/fileManager';

// ============================================================================
// 类型定义
// ============================================================================

interface InlineImageViewerProps {
  /** 图片 URL 列表 */
  images: string[];
  /** 当前显示的图片索引 */
  currentIndex: number;
  /** 是否打开 */
  isOpen: boolean;
  /** 关闭回调 */
  onClose: () => void;
  /** 下一张回调 */
  onNext?: () => void;
  /** 上一张回调 */
  onPrev?: () => void;
  /** 自定义类名 */
  className?: string;
}

// ============================================================================
// 辅助 Hook：获取 .chat-v2 容器
// ============================================================================

function useChatV2Container() {
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const [bounds, setBounds] = useState<DOMRect | null>(null);

  useEffect(() => {
    // ★ 查找或创建 modal 容器，避免层叠上下文问题
    const findOrCreateContainer = () => {
      // 优先使用已存在的 modal-root
      let modalRoot = document.getElementById('image-viewer-root');
      if (!modalRoot) {
        // 创建一个挂载在 body 下的容器
        modalRoot = document.createElement('div');
        modalRoot.id = 'image-viewer-root';
        modalRoot.style.cssText = 'position: fixed; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none; z-index: 99999;';
        document.body.appendChild(modalRoot);
      }
      setContainer(modalRoot);
      
      // 获取 .chat-v2 的边界用于定位
      const chatContainer = document.querySelector('.chat-v2') as HTMLElement;
      if (chatContainer) {
        setBounds(chatContainer.getBoundingClientRect());
      }
      return true;
    };

    findOrCreateContainer();

    // 监听窗口大小变化更新边界
    const handleResize = () => {
      const chatContainer = document.querySelector('.chat-v2') as HTMLElement;
      if (chatContainer) {
        setBounds(chatContainer.getBoundingClientRect());
      }
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  return { container, bounds };
}

// ============================================================================
// 组件实现
// ============================================================================

export const InlineImageViewer: React.FC<InlineImageViewerProps> = ({
  images,
  currentIndex,
  isOpen,
  onClose,
  onNext,
  onPrev,
  className,
}) => {
  const { t } = useTranslation(['common', 'chatV2']);

  // 获取 modal 容器和 .chat-v2 边界用于定位
  const { container, bounds } = useChatV2Container();

  // 状态
  const [scale, setScale] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);

  // 重置状态当图片改变时
  useEffect(() => {
    setScale(1);
    setRotation(0);
    setPosition({ x: 0, y: 0 });
  }, [currentIndex]);

  // 键盘事件处理
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      switch (e.key) {
        case 'Escape':
          onClose();
          break;
        case 'ArrowLeft':
          onPrev?.();
          break;
        case 'ArrowRight':
          onNext?.();
          break;
        case '+':
        case '=':
          setScale((prev) => Math.min(prev * 1.2, 5));
          break;
        case '-':
          setScale((prev) => Math.max(prev / 1.2, 0.1));
          break;
        case 'r':
        case 'R':
          setRotation((prev) => (prev + 90) % 360);
          break;
        case '0':
          setScale(1);
          setRotation(0);
          setPosition({ x: 0, y: 0 });
          break;
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose, onNext, onPrev]);

  // 鼠标拖拽
  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      setIsDragging(true);

      const startPos = {
        x: e.clientX - position.x,
        y: e.clientY - position.y,
      };

      const handleGlobalMouseMove = (e: MouseEvent) => {
        setPosition({
          x: e.clientX - startPos.x,
          y: e.clientY - startPos.y,
        });
      };

      const handleGlobalMouseUp = () => {
        setIsDragging(false);
        document.removeEventListener('mousemove', handleGlobalMouseMove);
        document.removeEventListener('mouseup', handleGlobalMouseUp);
      };

      document.addEventListener('mousemove', handleGlobalMouseMove);
      document.addEventListener('mouseup', handleGlobalMouseUp);
    },
    [position]
  );

  // 滚轮缩放
  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? 0.9 : 1.1;
    setScale((prev) => Math.max(0.1, Math.min(5, prev * delta)));
  }, []);

  // 下载图片
  const handleDownload = useCallback(async () => {
    const currentImage = images[currentIndex];
    if (!currentImage) return;

    try {
      const response = await fetch(currentImage);
      const blob = await response.blob();
      const arrayBuffer = await blob.arrayBuffer();
      const ext = blob.type.split('/')[1]?.replace('jpeg', 'jpg') || 'png';
      const fileName = `image-${currentIndex + 1}.${ext}`;
      await fileManager.saveBinaryFile({
        title: fileName,
        defaultFileName: fileName,
        data: new Uint8Array(arrayBuffer),
        filters: [{ name: 'Images', extensions: [ext] }],
      });
    } catch (error) {
      console.error('[InlineImageViewer] Download failed:', error);
    }
  }, [images, currentIndex]);

  // 新标签页打开
  const handleOpenInNewTab = useCallback(() => {
    const currentImage = images[currentIndex];
    if (currentImage) {
      openUrl(currentImage);
    }
  }, [images, currentIndex]);

  // 不显示时返回 null
  if (!isOpen || images.length === 0 || !container) {
    return null;
  }

  const currentImage = images[currentIndex] ?? '';

  // 使用 Portal 渲染到独立容器，使用 bounds 精确定位到 .chat-v2 区域
  const overlayStyle: React.CSSProperties = bounds ? {
    position: 'fixed',
    top: bounds.top,
    left: bounds.left,
    width: bounds.width,
    height: bounds.height,
    pointerEvents: 'auto',
  } : {
    position: 'fixed',
    inset: 0,
    pointerEvents: 'auto',
  };

  const overlay = (
    <div
      className={cn(
        'bg-black/40 dark:bg-black/50 backdrop-blur-sm',
        'flex flex-col',
        'shadow-lg ring-1 ring-border/40',
        className
      )}
      style={overlayStyle}
      onClick={(e) => {
        // 点击背景关闭
        if (e.target === e.currentTarget) {
          onClose();
        }
      }}
    >
      {/* 工具栏 */}
      <div className="flex items-center justify-between px-4 py-2.5 bg-black/30 border-b border-white/10 flex-shrink-0">
        {/* 左侧：图片计数 */}
        <div className="flex items-center gap-3">
          <span className="text-white/90 text-sm font-medium">
            {currentIndex + 1} / {images.length}
          </span>
        </div>

        {/* 中间：缩放控制 */}
        <div className="flex items-center gap-1.5">
          <NotionButton variant="ghost" size="icon" iconOnly onClick={() => setScale((prev) => Math.max(prev / 1.2, 0.1))} className="bg-white/10 hover:bg-white/20 text-white/80 hover:text-white" aria-label={t('common:imageViewer.zoomOut')} title={t('common:imageViewer.zoomOut')}>
            <ZoomOut className="w-4 h-4" />
          </NotionButton>
          <span className="px-2 py-1 rounded-md text-xs font-medium min-w-[45px] text-center bg-white/10 text-white/80">
            {Math.round(scale * 100)}%
          </span>
          <NotionButton variant="ghost" size="icon" iconOnly onClick={() => setScale((prev) => Math.min(prev * 1.2, 5))} className="bg-white/10 hover:bg-white/20 text-white/80 hover:text-white" aria-label={t('common:imageViewer.zoomIn')} title={t('common:imageViewer.zoomIn')}>
            <ZoomIn className="w-4 h-4" />
          </NotionButton>
          <div className="w-px h-4 bg-white/20 mx-1" />
          <NotionButton variant="ghost" size="icon" iconOnly onClick={() => setRotation((prev) => (prev + 90) % 360)} className="bg-white/10 hover:bg-white/20 text-white/80 hover:text-white" aria-label={t('common:imageViewer.rotate')} title={t('common:imageViewer.rotate')}>
            <RotateCw className="w-4 h-4" />
          </NotionButton>
          <NotionButton variant="ghost" size="icon" iconOnly onClick={() => { setScale(1); setRotation(0); setPosition({ x: 0, y: 0 }); }} className="bg-white/10 hover:bg-white/20 text-white/80 hover:text-white" aria-label={t('common:imageViewer.reset')} title={t('common:imageViewer.reset')}>
            <Home className="w-4 h-4" />
          </NotionButton>
        </div>

        {/* 右侧：操作按钮 */}
        <div className="flex items-center gap-1.5">
          <NotionButton variant="ghost" size="icon" iconOnly onClick={handleDownload} className="bg-white/10 hover:bg-white/20 text-white/80 hover:text-white" aria-label={t('chatV2:blocks.imageGen.download')} title={t('chatV2:blocks.imageGen.download')}>
            <Download className="w-4 h-4" />
          </NotionButton>
          <NotionButton variant="ghost" size="icon" iconOnly onClick={handleOpenInNewTab} className="bg-white/10 hover:bg-white/20 text-white/80 hover:text-white" aria-label={t('chatV2:blocks.imageGen.openInNewTab')} title={t('chatV2:blocks.imageGen.openInNewTab')}>
            <ExternalLink className="w-4 h-4" />
          </NotionButton>
          <div className="w-px h-4 bg-white/20 mx-1" />
          <NotionButton variant="ghost" size="icon" iconOnly onClick={onClose} className="hover:bg-red-500/20 text-white/80 hover:text-red-400" aria-label={t('chatV2:blocks.imageGen.close')} title={t('chatV2:blocks.imageGen.close')}>
            <X className="w-4 h-4" />
          </NotionButton>
        </div>
      </div>

      {/* 图片容器 */}
      <div
        className="flex-1 flex items-center justify-center overflow-hidden relative"
        onMouseDown={handleMouseDown}
        onWheel={handleWheel}
      >
        <img
          src={currentImage}
          alt={t('chatV2:imageViewer.imageAlt', { index: currentIndex + 1 })}
          className="max-w-[90%] max-h-[90%] object-contain select-none"
          style={{
            transform: `translate(${position.x}px, ${position.y}px) scale(${scale}) rotate(${rotation}deg)`,
            cursor: isDragging ? 'grabbing' : 'grab',
          }}
          draggable={false}
        />

        {/* 导航按钮 */}
        {images.length > 1 && (
          <>
            <NotionButton variant="ghost" size="icon" iconOnly onClick={(e) => { e.stopPropagation(); onPrev?.(); }} disabled={currentIndex === 0} className={cn('absolute left-4 top-1/2 -translate-y-1/2 !rounded-full bg-black/40 hover:bg-black/60 border border-white/10 shadow-lg backdrop-blur-sm text-white/80 hover:text-white', currentIndex === 0 && 'opacity-40')} aria-label={t('common:imageViewer.prev')} title={t('common:imageViewer.prev')}>
              <ChevronLeft className="w-6 h-6" />
            </NotionButton>
            <NotionButton variant="ghost" size="icon" iconOnly onClick={(e) => { e.stopPropagation(); onNext?.(); }} disabled={currentIndex === images.length - 1} className={cn('absolute right-4 top-1/2 -translate-y-1/2 !rounded-full bg-black/40 hover:bg-black/60 border border-white/10 shadow-lg backdrop-blur-sm text-white/80 hover:text-white', currentIndex === images.length - 1 && 'opacity-40')} aria-label={t('common:imageViewer.next')} title={t('common:imageViewer.next')}>
              <ChevronRight className="w-6 h-6" />
            </NotionButton>
          </>
        )}
      </div>

      {/* 缩略图栏（多图时显示） */}
      {images.length > 1 && (
        <div className="flex items-center justify-center gap-2 p-2.5 bg-black/30 border-t border-white/10 flex-shrink-0 overflow-x-auto">
          {images.map((image, index) => (
            <div
              key={index}
              onClick={() => {
                const delta = index - currentIndex;
                if (delta > 0 && onNext) {
                  for (let i = 0; i < delta; i++) onNext();
                } else if (delta < 0 && onPrev) {
                  for (let i = 0; i < Math.abs(delta); i++) onPrev();
                }
              }}
              className={cn(
                'w-11 h-11 rounded-md overflow-hidden cursor-pointer transition-all flex-shrink-0',
                'border-2',
                index === currentIndex
                  ? 'border-white ring-2 ring-white/30 opacity-100 scale-105'
                  : 'border-white/30 opacity-60 hover:opacity-90 hover:border-white/50'
              )}
            >
              <img
                src={image}
                alt={t('chatV2:imageViewer.thumbnailAlt', { index: index + 1 })}
                className="w-full h-full object-cover"
              />
            </div>
          ))}
        </div>
      )}

      {/* 快捷键提示 */}
      <div className="absolute bottom-14 right-4 rounded-lg p-2 bg-black/50 border border-white/10 text-white/60 text-xs space-y-0.5 shadow-md backdrop-blur-sm">
        <div>ESC: {t('chatV2:blocks.imageGen.close')}</div>
        <div>←→: {t('common:imageViewer.switch')}</div>
        <div>+/-: {t('common:imageViewer.zoomInOut')}</div>
        <div>R: {t('common:imageViewer.rotate')}</div>
      </div>
    </div>
  );

  // 使用 Portal 渲染到 .chat-v2 容器，只覆盖主聊天区域
  return createPortal(overlay, container);
};

export default InlineImageViewer;
