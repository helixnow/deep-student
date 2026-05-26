/**
 * Chat V2 - 内联图片查看器
 *
 * 作为聊天域的轻量图片查看器，但预览层本身应占满整个视口，
 * 避免被聊天分栏限制在局部区域内。
 */

import React, { useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { cn } from '@/utils/cn';
import { NotionButton } from '@/components/ui/NotionButton';
import { openUrl } from '@/utils/urlOpener';
import {
  X,
  MagnifyingGlassPlus,
  MagnifyingGlassMinus,
  ArrowClockwise,
  House,
  CaretLeft,
  CaretRight,
  Download,
  ArrowSquareOut,
} from '@phosphor-icons/react';
import { fileManager } from '@/utils/fileManager';
import { useViewStore } from '@/stores/viewStore';
import { isAndroid } from '@/utils/platform';
import { getCurrentWindow } from '@tauri-apps/api/window';

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
// 辅助 Hook：获取全屏 portal 容器
// ============================================================================

function useImageViewerPortal() {
  const [container, setContainer] = useState<HTMLElement | null>(null);

  useEffect(() => {
    let modalRoot = document.getElementById('image-viewer-root');
    if (!modalRoot) {
      modalRoot = document.createElement('div');
      modalRoot.id = 'image-viewer-root';
      modalRoot.style.cssText = 'position: fixed; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none; z-index: 99999;';
      document.body.appendChild(modalRoot);
    }
    setContainer(modalRoot);
  }, []);

  return { container };
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
  const currentView = useViewStore((s) => s.currentView);

  // 获取全屏 portal 容器
  const { container } = useImageViewerPortal();

  // 状态
  const [scale, setScale] = useState(1);
  const [rotation, setRotation] = useState(0);
  const canNavigatePrev = images.length > 1 && currentIndex > 0 && typeof onPrev === 'function';
  const canNavigateNext = images.length > 1 && currentIndex < images.length - 1 && typeof onNext === 'function';

  const handleResetView = useCallback(() => {
    setScale(1);
    setRotation(0);
  }, []);

  const stopSurfaceGesture = useCallback((e: React.PointerEvent<HTMLElement>) => {
    e.stopPropagation();
  }, []);

  const handleTopDragMouseDown = useCallback((e: React.MouseEvent<HTMLElement>) => {
    if (isAndroid()) {
      return;
    }

    const target = (e.target as HTMLElement).closest('[data-no-drag]');
    if (target) {
      return;
    }

    e.preventDefault();
    try {
      void getCurrentWindow().startDragging();
    } catch (error) {
      console.warn('[InlineImageViewer] Failed to start window dragging:', error);
    }
  }, []);

  // 重置状态当图片改变时
  useEffect(() => {
    handleResetView();
  }, [currentIndex, handleResetView]);

  // 键盘事件处理
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      switch (e.key) {
        case 'Escape':
          onClose();
          break;
        case 'ArrowLeft':
          if (canNavigatePrev) {
            onPrev?.();
          }
          break;
        case 'ArrowRight':
          if (canNavigateNext) {
            onNext?.();
          }
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
          handleResetView();
          break;
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose, onNext, onPrev, canNavigateNext, canNavigatePrev, handleResetView]);

  // 全局视图切换离开 chat-v2 时，强制关闭预览
  useEffect(() => {
    if (isOpen && currentView !== 'chat-v2') {
      onClose();
    }
  }, [isOpen, currentView, onClose]);

  // 打开时锁定页面滚动，避免背景跟随滚动
  useEffect(() => {
    if (!isOpen) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prevOverflow;
    };
  }, [isOpen]);

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
  const topHotzoneHeightClassName = 'h-[96px] sm:h-[112px]';
  const stageTopPaddingClassName = 'pt-[96px] sm:pt-[112px]';

  const overlay = (
    <div
      className={cn(
        'bg-black/40 dark:bg-black/50 backdrop-blur-sm',
        'relative flex flex-col',
        'shadow-lg ring-1 ring-border/40',
        className
      )}
      style={{
        position: 'fixed',
        inset: 0,
        pointerEvents: 'auto',
      }}
      onClick={(e) => {
        // 点击背景关闭
        if (e.target === e.currentTarget) {
          onClose();
        }
      }}
    >
      {/* 顶部热区：保留更宽松的点击/触摸安全区，仅放关闭按钮 */}
      <div
        {...(!isAndroid() ? { 'data-tauri-drag-region': true } : {})}
        className="pointer-events-none absolute inset-x-0 top-0 z-20 bg-gradient-to-b from-black/55 via-black/20 to-transparent"
        style={{ paddingTop: 'max(env(safe-area-inset-top, 0px), var(--safe-area-inset-top-fallback, 0px))' }}
        onMouseDown={handleTopDragMouseDown}
      >
        <div
          className={cn(topHotzoneHeightClassName, 'flex items-start justify-end px-3 py-3 sm:px-4 sm:py-4')}
        >
          <NotionButton variant="ghost" size="icon" iconOnly data-no-drag onPointerDown={stopSurfaceGesture} onClick={onClose} className="pointer-events-auto h-11 w-11 !rounded-full border border-[color:var(--shell-workspace-border)] bg-[color:var(--shell-toolbar-floating-surface)] text-[color:var(--text-secondary)] shadow-[var(--shadow-shell-soft)] hover:bg-[color:var(--button-plain-hover-bg)] hover:text-[color:var(--text-primary)] sm:h-12 sm:w-12" aria-label={t('chatV2:blocks.imageGen.close')} title={t('chatV2:blocks.imageGen.close')}>
            <X size={18} />
          </NotionButton>
        </div>
      </div>

      {/* 图片容器 */}
      <div
        className={cn(
          'relative flex flex-1 items-center justify-center overflow-hidden px-4 sm:px-8',
          stageTopPaddingClassName,
          'pb-24 sm:pb-28'
        )}
        onClick={(e) => {
          if (e.target === e.currentTarget) {
            onClose();
          }
        }}
        onWheel={(e) => {
          e.preventDefault();
        }}
      >
        <img
          src={currentImage}
          alt={t('chatV2:imageViewer.imageAlt', { index: currentIndex + 1 })}
          className="max-h-full max-w-full object-contain select-none"
          style={{
            transform: `scale(${scale}) rotate(${rotation}deg)`,
          }}
          draggable={false}
        />

      </div>

      {/* 独立侧边导航轨道：避免把切页按钮挂在拖拽舞台内导致 hover / 合成层抖动 */}
      <div className="pointer-events-none absolute inset-y-0 left-0 right-0 z-20">
        <div className="pointer-events-none flex h-full items-center justify-between px-3 sm:px-5">
          <div className="pointer-events-none flex h-full w-16 items-center justify-start sm:w-20">
            {canNavigatePrev && (
              <NotionButton variant="ghost" size="icon" iconOnly onPointerDown={stopSurfaceGesture} onClick={(e) => { e.stopPropagation(); onPrev?.(); }} className="pointer-events-auto h-12 w-12 !rounded-full border border-[color:var(--shell-workspace-border)] bg-[color:var(--shell-toolbar-floating-surface)] text-[color:var(--text-secondary)] shadow-[var(--shadow-shell-soft)] hover:bg-[color:var(--button-plain-hover-bg)] hover:text-[color:var(--text-primary)] sm:h-14 sm:w-14" aria-label={t('common:imageViewer.prev')} title={t('common:imageViewer.prev')}>
                <CaretLeft size={24} weight="bold" />
              </NotionButton>
            )}
          </div>
          <div className="pointer-events-none flex h-full w-16 items-center justify-end sm:w-20">
            {canNavigateNext && (
              <NotionButton variant="ghost" size="icon" iconOnly onPointerDown={stopSurfaceGesture} onClick={(e) => { e.stopPropagation(); onNext?.(); }} className="pointer-events-auto h-12 w-12 !rounded-full border border-[color:var(--shell-workspace-border)] bg-[color:var(--shell-toolbar-floating-surface)] text-[color:var(--text-secondary)] shadow-[var(--shadow-shell-soft)] hover:bg-[color:var(--button-plain-hover-bg)] hover:text-[color:var(--text-primary)] sm:h-14 sm:w-14" aria-label={t('common:imageViewer.next')} title={t('common:imageViewer.next')}>
                <CaretRight size={24} weight="bold" />
              </NotionButton>
            )}
          </div>
        </div>
      </div>

      {/* 底部操作托盘：保持尽量简洁 */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 bg-gradient-to-t from-black/42 via-black/14 to-transparent">
        <div
          className="pointer-events-none flex items-center justify-center px-3 pb-3 pt-10 sm:px-4 sm:pb-4 sm:pt-12"
          style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom, 0px))' }}
        >
          <div className="pointer-events-none flex w-full justify-center overflow-x-auto">
            <div
              className="pointer-events-auto inline-flex min-w-max items-center gap-1 rounded-full border px-2 py-2 shadow-[var(--shadow-shell-soft)]"
              style={{
                background: 'color-mix(in hsl, var(--surface-panel-strong) 72%, transparent)',
                borderColor: 'var(--shell-workspace-border)',
                color: 'var(--text-secondary)',
              }}
            >
              <NotionButton variant="ghost" size="icon" iconOnly onPointerDown={stopSurfaceGesture} onClick={() => setScale((prev) => Math.max(prev / 1.2, 0.1))} className="h-9 w-9 !rounded-full border border-transparent bg-transparent text-[color:var(--text-secondary)] hover:bg-[color:var(--button-plain-hover-bg)] hover:text-[color:var(--text-primary)]" aria-label={t('common:imageViewer.zoomOut')} title={t('common:imageViewer.zoomOut')}>
                <MagnifyingGlassMinus size={16} />
              </NotionButton>
              <span className="min-w-[44px] px-2 py-1 text-center text-[11px] font-medium tracking-[0.02em] text-[color:var(--text-secondary)]">
                {Math.round(scale * 100)}%
              </span>
              <NotionButton variant="ghost" size="icon" iconOnly onPointerDown={stopSurfaceGesture} onClick={() => setScale((prev) => Math.min(prev * 1.2, 5))} className="h-9 w-9 !rounded-full border border-transparent bg-transparent text-[color:var(--text-secondary)] hover:bg-[color:var(--button-plain-hover-bg)] hover:text-[color:var(--text-primary)]" aria-label={t('common:imageViewer.zoomIn')} title={t('common:imageViewer.zoomIn')}>
                <MagnifyingGlassPlus size={16} />
              </NotionButton>
              <div className="mx-1 h-4 w-px bg-[color:var(--shell-workspace-border)]" />
              <NotionButton variant="ghost" size="icon" iconOnly onPointerDown={stopSurfaceGesture} onClick={() => setRotation((prev) => (prev + 90) % 360)} className="h-9 w-9 !rounded-full border border-transparent bg-transparent text-[color:var(--text-secondary)] hover:bg-[color:var(--button-plain-hover-bg)] hover:text-[color:var(--text-primary)]" aria-label={t('common:imageViewer.rotate')} title={t('common:imageViewer.rotate')}>
                <ArrowClockwise size={16} />
              </NotionButton>
              <NotionButton variant="ghost" size="icon" iconOnly onPointerDown={stopSurfaceGesture} onClick={handleResetView} className="h-9 w-9 !rounded-full border border-transparent bg-transparent text-[color:var(--text-secondary)] hover:bg-[color:var(--button-plain-hover-bg)] hover:text-[color:var(--text-primary)]" aria-label={t('common:imageViewer.reset')} title={t('common:imageViewer.reset')}>
                <House size={16} />
              </NotionButton>
              <div className="mx-1 h-4 w-px bg-[color:var(--shell-workspace-border)]" />
              <NotionButton variant="ghost" size="icon" iconOnly onPointerDown={stopSurfaceGesture} onClick={handleDownload} className="h-9 w-9 !rounded-full border border-transparent bg-transparent text-[color:var(--text-secondary)] hover:bg-[color:var(--button-plain-hover-bg)] hover:text-[color:var(--text-primary)]" aria-label={t('chatV2:blocks.imageGen.download')} title={t('chatV2:blocks.imageGen.download')}>
                <Download size={16} />
              </NotionButton>
              <NotionButton variant="ghost" size="icon" iconOnly onPointerDown={stopSurfaceGesture} onClick={handleOpenInNewTab} className="h-9 w-9 !rounded-full border border-transparent bg-transparent text-[color:var(--text-secondary)] hover:bg-[color:var(--button-plain-hover-bg)] hover:text-[color:var(--text-primary)]" aria-label={t('chatV2:blocks.imageGen.openInNewTab')} title={t('chatV2:blocks.imageGen.openInNewTab')}>
                <ArrowSquareOut size={16} />
              </NotionButton>
            </div>
          </div>
        </div>
      </div>
    </div>
  );

  // 使用 Portal 渲染到全屏容器
  return createPortal(overlay, container);
};

export default InlineImageViewer;
