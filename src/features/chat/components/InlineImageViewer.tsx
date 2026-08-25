/**
 * Chat V2 - 内联图片查看器
 *
 * 作为聊天域的轻量图片查看器，但预览层本身应占满整个视口，
 * 避免被聊天分栏限制在局部区域内。
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { cn } from '@/utils/cn';
import { DsButton } from '@/components/ui/DsButton';
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
import { registerBackHandler, BACK_PRIORITY } from '@/app/navigation/androidBackCoordinator';

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
// 缩放/手势常量（IMG-1）
// ============================================================================

const MIN_SCALE = 0.5;
const MAX_SCALE = 6;
/** 双击/双触缩放的目标倍率 */
const DOUBLE_TAP_SCALE = 2.5;
/** 判定为"点击"而非拖拽的最大位移（px） */
const TAP_MOVE_TOLERANCE = 12;
/** 双触间隔上限（ms）与两次落点距离上限（px） */
const DOUBLE_TAP_INTERVAL_MS = 300;
const DOUBLE_TAP_DISTANCE = 32;

const clampScale = (value: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, value));

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

  // 视图状态：缩放 + 平移（IMG-1：offset 供捏合/拖拽平移使用）
  const [view, setView] = useState({ scale: 1, offsetX: 0, offsetY: 0 });
  const viewRef = useRef(view);
  viewRef.current = view;
  const [rotation, setRotation] = useState(0);
  const [imageError, setImageError] = useState(false);
  const scale = view.scale;
  const canNavigatePrev = images.length > 1 && currentIndex > 0 && typeof onPrev === 'function';
  const canNavigateNext = images.length > 1 && currentIndex < images.length - 1 && typeof onNext === 'function';
  const currentImage = images[currentIndex] ?? '';

  const imageRef = useRef<HTMLImageElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);

  const handleResetView = useCallback(() => {
    setView({ scale: 1, offsetX: 0, offsetY: 0 });
    setRotation(0);
  }, []);

  /**
   * 以视口某点为锚缩放：保持锚点下的图像内容不动（transform 为 translate→scale）。
   * 参考原点取视口中心——浮层为 inset:0 全屏、舞台上下留白对称，
   * 未缩放时图像中心即视口中心，无需测量任何容器尺寸。
   */
  const zoomAt = useCallback((clientX: number, clientY: number, nextScaleRaw: number) => {
    const nextScale = clampScale(nextScaleRaw);
    setView((prev) => {
      const cx = window.innerWidth / 2;
      const cy = window.innerHeight / 2;
      const k = nextScale / prev.scale;
      if (nextScale <= 1) {
        // 回到 1x 及以下时复位平移，避免图像"丢在"视口外
        return { scale: nextScale, offsetX: 0, offsetY: 0 };
      }
      return {
        scale: nextScale,
        offsetX: (clientX - cx) - k * ((clientX - cx) - prev.offsetX),
        offsetY: (clientY - cy) - k * ((clientY - cy) - prev.offsetY),
      };
    });
  }, []);

  /** 以视口中心为锚按倍率缩放（底部托盘按钮 / 键盘 +- 使用） */
  const zoomBy = useCallback((factor: number) => {
    zoomAt(window.innerWidth / 2, window.innerHeight / 2, viewRef.current.scale * factor);
  }, [zoomAt]);

  // ── 指针手势（捏合缩放 / 平移 / 双触缩放 / 背景轻点关闭）──
  const pointersRef = useRef(new Map<number, { x: number; y: number }>());
  const gestureRef = useRef({
    moved: false,
    targetIsImage: false,
    pointerType: 'touch' as string,
    // 单指平移
    panStartX: 0,
    panStartY: 0,
    panStartOffsetX: 0,
    panStartOffsetY: 0,
    // 双指捏合
    pinchStartDist: 0,
    pinchStartScale: 1,
    pinchStartMidX: 0,
    pinchStartMidY: 0,
    pinchStartOffsetX: 0,
    pinchStartOffsetY: 0,
    // 双触检测
    lastTapTime: 0,
    lastTapX: 0,
    lastTapY: 0,
  });
  const beginPan = useCallback((x: number, y: number) => {
    const g = gestureRef.current;
    g.panStartX = x;
    g.panStartY = y;
    g.panStartOffsetX = viewRef.current.offsetX;
    g.panStartOffsetY = viewRef.current.offsetY;
  }, []);

  const handleStagePointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const g = gestureRef.current;
    e.currentTarget.setPointerCapture(e.pointerId);
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    g.pointerType = e.pointerType;

    if (pointersRef.current.size === 1) {
      g.moved = false;
      g.targetIsImage = !!(imageRef.current && e.target instanceof Node && imageRef.current.contains(e.target));
      beginPan(e.clientX, e.clientY);
    } else if (pointersRef.current.size === 2) {
      const [p1, p2] = Array.from(pointersRef.current.values());
      g.pinchStartDist = Math.hypot(p2.x - p1.x, p2.y - p1.y) || 1;
      g.pinchStartScale = viewRef.current.scale;
      g.pinchStartMidX = (p1.x + p2.x) / 2;
      g.pinchStartMidY = (p1.y + p2.y) / 2;
      g.pinchStartOffsetX = viewRef.current.offsetX;
      g.pinchStartOffsetY = viewRef.current.offsetY;
      g.moved = true;
    }
  }, [beginPan]);

  const handleStagePointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const g = gestureRef.current;
    const tracked = pointersRef.current.get(e.pointerId);
    if (!tracked) return;
    tracked.x = e.clientX;
    tracked.y = e.clientY;

    if (pointersRef.current.size >= 2) {
      // 捏合：缩放锚定捏合起始中点，并叠加中点位移实现同步平移
      const [p1, p2] = Array.from(pointersRef.current.values());
      const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y) || 1;
      const midX = (p1.x + p2.x) / 2;
      const midY = (p1.y + p2.y) / 2;
      const cx = window.innerWidth / 2;
      const cy = window.innerHeight / 2;
      const nextScale = clampScale(g.pinchStartScale * (dist / g.pinchStartDist));
      const k = nextScale / g.pinchStartScale;
      const anchoredX = (g.pinchStartMidX - cx) - k * ((g.pinchStartMidX - cx) - g.pinchStartOffsetX);
      const anchoredY = (g.pinchStartMidY - cy) - k * ((g.pinchStartMidY - cy) - g.pinchStartOffsetY);
      setView({
        scale: nextScale,
        offsetX: anchoredX + (midX - g.pinchStartMidX),
        offsetY: anchoredY + (midY - g.pinchStartMidY),
      });
      return;
    }

    // 单指：放大状态下平移图像
    const dx = e.clientX - g.panStartX;
    const dy = e.clientY - g.panStartY;
    if (!g.moved && Math.hypot(dx, dy) > TAP_MOVE_TOLERANCE) {
      g.moved = true;
    }
    if (viewRef.current.scale > 1 && g.moved) {
      setView((prev) => ({
        ...prev,
        offsetX: g.panStartOffsetX + dx,
        offsetY: g.panStartOffsetY + dy,
      }));
    }
  }, []);

  const handleStagePointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const g = gestureRef.current;
    if (!pointersRef.current.delete(e.pointerId)) return;

    if (pointersRef.current.size === 1) {
      // 捏合 → 单指：重锚剩余手指，避免平移跳变
      const [rest] = Array.from(pointersRef.current.values());
      beginPan(rest.x, rest.y);
      return;
    }
    if (pointersRef.current.size > 0) return;

    // 手势完全结束（背景轻点关闭交由 click 事件处理，此处只管缩放/双触）
    if (viewRef.current.scale < 1) {
      setView({ scale: 1, offsetX: 0, offsetY: 0 });
    }
    if (e.type === 'pointercancel' || g.moved) return;

    // 触屏双触缩放（鼠标走原生 dblclick，避免两条路径重复触发相互抵消）
    if (!g.targetIsImage || g.pointerType === 'mouse') return;
    const now = Date.now();
    const isDoubleTap =
      now - g.lastTapTime < DOUBLE_TAP_INTERVAL_MS
      && Math.hypot(e.clientX - g.lastTapX, e.clientY - g.lastTapY) < DOUBLE_TAP_DISTANCE;
    if (isDoubleTap) {
      g.lastTapTime = 0;
      if (viewRef.current.scale > 1.01) {
        setView({ scale: 1, offsetX: 0, offsetY: 0 });
      } else {
        zoomAt(e.clientX, e.clientY, DOUBLE_TAP_SCALE);
      }
    } else {
      g.lastTapTime = now;
      g.lastTapX = e.clientX;
      g.lastTapY = e.clientY;
    }
  }, [beginPan, zoomAt]);

  const handleStageClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    // 拖拽/捏合结束后浏览器仍会派发 click，靠 moved 标记区分真实轻点
    if (e.target === e.currentTarget && !gestureRef.current.moved) {
      onClose();
    }
  }, [onClose]);

  const handleImageDoubleClick = useCallback((e: React.MouseEvent<HTMLImageElement>) => {
    // 触屏双触已由 pointerup 检测处理；此处只响应鼠标双击
    if (gestureRef.current.pointerType !== 'mouse') return;
    if (viewRef.current.scale > 1.01) {
      setView({ scale: 1, offsetX: 0, offsetY: 0 });
    } else {
      zoomAt(e.clientX, e.clientY, DOUBLE_TAP_SCALE);
    }
  }, [zoomAt]);

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
    setImageError(false);
  }, [currentImage, currentIndex, handleResetView]);

  // 键盘事件处理
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      // 焦点未被浮层捕获（无焦点陷阱）：用户可能仍在背后的输入框打字，
      // 此时只响应 Escape，避免输入 r/+/- 等字符误触发旋转/缩放
      const target = e.target as HTMLElement | null;
      const isEditableTarget = !!target && (
        target.tagName === 'INPUT'
        || target.tagName === 'TEXTAREA'
        || target.isContentEditable
      );
      if (isEditableTarget && e.key !== 'Escape') {
        return;
      }
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
          zoomBy(1.2);
          break;
        case '-':
          zoomBy(1 / 1.2);
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
  }, [isOpen, onClose, onNext, onPrev, canNavigateNext, canNavigatePrev, handleResetView, zoomBy]);

  // 全局视图切换离开 chat-v2 时，强制关闭预览
  useEffect(() => {
    if (isOpen && currentView !== 'chat-v2') {
      onClose();
    }
  }, [isOpen, currentView, onClose]);

  // Android 系统返回键 = 关闭查看器（全屏浮层是非 Radix 自绘，协调器兜底覆盖不到）
  const onCloseRef = React.useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    if (!isOpen) return;
    return registerBackHandler(() => {
      onCloseRef.current();
      return true;
    }, BACK_PRIORITY.overlay);
  }, [isOpen]);

  // 打开时锁定页面滚动，避免背景跟随滚动
  useEffect(() => {
    if (!isOpen) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prevOverflow;
    };
  }, [isOpen]);

  // 滚轮缩放：React 在根节点上以 passive 方式注册 wheel，onWheel 里的
  // preventDefault 不生效（ctrl+wheel 会连带缩放整个页面），
  // 因此改用原生非 passive 监听
  useEffect(() => {
    if (!isOpen) return;
    const stage = stageRef.current;
    if (!stage) return;
    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      // 触控板捏合在桌面表现为 ctrl+wheel（标准检测方式），据此缩放；
      // 普通滚轮保持不缩放（见 fullscreen 契约测试）
      if (e.ctrlKey || e.metaKey) {
        zoomAt(e.clientX, e.clientY, viewRef.current.scale * (e.deltaY < 0 ? 1.15 : 1 / 1.15));
      }
    };
    stage.addEventListener('wheel', handleWheel, { passive: false });
    return () => stage.removeEventListener('wheel', handleWheel);
  }, [isOpen, container, zoomAt]);

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

  const topHotzoneHeightClassName = 'h-[96px] sm:h-[112px]';
  const stageTopPaddingClassName = 'pt-[96px] sm:pt-[112px]';

  const overlay = (
    <div
      data-wb-blur-surface
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
          <DsButton variant="ghost" size="icon" iconOnly data-no-drag onPointerDown={stopSurfaceGesture} onClick={onClose} className="pointer-events-auto h-11 w-11 !rounded-full border border-[color:var(--shell-workspace-border)] bg-[color:var(--shell-toolbar-floating-surface)] text-[color:var(--text-secondary)] shadow-[var(--shadow-shell-soft)] hover:bg-[color:var(--button-plain-hover-bg)] hover:text-[color:var(--text-primary)] sm:h-12 sm:w-12" aria-label={t('chatV2:blocks.imageGen.close')} title={t('chatV2:blocks.imageGen.close')}>
            <X size={18} />
          </DsButton>
        </div>
      </div>

      {/* 图片容器（IMG-1：捏合缩放 / 放大后单指平移 / 双击与双触缩放 / 滚轮缩放） */}
      <div
        ref={stageRef}
        className={cn(
          'relative flex flex-1 items-center justify-center overflow-hidden px-4 sm:px-8',
          stageTopPaddingClassName,
          'pb-24 sm:pb-28'
        )}
        style={{ touchAction: 'none', cursor: scale > 1 ? 'grab' : undefined }}
        onClick={handleStageClick}
        onPointerDown={handleStagePointerDown}
        onPointerMove={handleStagePointerMove}
        onPointerUp={handleStagePointerUp}
        onPointerCancel={handleStagePointerUp}
      >
        {imageError ? (
          <div className="flex flex-col items-center gap-2 text-sm text-white/80 select-none">
            <span>{t('chatV2:blocks.imageGen.loadError')}</span>
          </div>
        ) : (
          <img
            ref={imageRef}
            src={currentImage}
            alt={t('chatV2:imageViewer.imageAlt', { index: currentIndex + 1 })}
            className="max-h-full max-w-full object-contain select-none"
            style={{
              transform: `translate(${view.offsetX}px, ${view.offsetY}px) scale(${scale}) rotate(${rotation}deg)`,
            }}
            onDoubleClick={handleImageDoubleClick}
            onError={() => setImageError(true)}
            draggable={false}
          />
        )}

      </div>

      {/* 独立侧边导航轨道：避免把切页按钮挂在拖拽舞台内导致 hover / 合成层抖动 */}
      <div className="pointer-events-none absolute inset-y-0 left-0 right-0 z-20">
        <div className="pointer-events-none flex h-full items-center justify-between px-3 sm:px-5">
          <div className="pointer-events-none flex h-full w-16 items-center justify-start sm:w-20">
            {canNavigatePrev && (
              <DsButton variant="ghost" size="icon" iconOnly onPointerDown={stopSurfaceGesture} onClick={(e) => { e.stopPropagation(); onPrev?.(); }} className="pointer-events-auto h-12 w-12 !rounded-full border border-[color:var(--shell-workspace-border)] bg-[color:var(--shell-toolbar-floating-surface)] text-[color:var(--text-secondary)] shadow-[var(--shadow-shell-soft)] hover:bg-[color:var(--button-plain-hover-bg)] hover:text-[color:var(--text-primary)] sm:h-14 sm:w-14" aria-label={t('common:imageViewer.prev')} title={t('common:imageViewer.prev')}>
                <CaretLeft size={24} weight="bold" />
              </DsButton>
            )}
          </div>
          <div className="pointer-events-none flex h-full w-16 items-center justify-end sm:w-20">
            {canNavigateNext && (
              <DsButton variant="ghost" size="icon" iconOnly onPointerDown={stopSurfaceGesture} onClick={(e) => { e.stopPropagation(); onNext?.(); }} className="pointer-events-auto h-12 w-12 !rounded-full border border-[color:var(--shell-workspace-border)] bg-[color:var(--shell-toolbar-floating-surface)] text-[color:var(--text-secondary)] shadow-[var(--shadow-shell-soft)] hover:bg-[color:var(--button-plain-hover-bg)] hover:text-[color:var(--text-primary)] sm:h-14 sm:w-14" aria-label={t('common:imageViewer.next')} title={t('common:imageViewer.next')}>
                <CaretRight size={24} weight="bold" />
              </DsButton>
            )}
          </div>
        </div>
      </div>

      {/* 底部操作托盘：保持尽量简洁 */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 bg-gradient-to-t from-black/42 via-black/14 to-transparent">
        <div
          className="pointer-events-none flex items-center justify-center px-3 pb-3 pt-10 sm:px-4 sm:pb-4 sm:pt-12"
          style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom, 0px), var(--safe-area-inset-bottom-fallback, 0px))' }}
        >
          <div className="pointer-events-none flex w-full justify-center overflow-x-auto scrollbar-none">
            <div
              className="pointer-events-auto inline-flex min-w-max items-center gap-1 rounded-full border px-2 py-2 shadow-[var(--shadow-shell-soft)]"
              style={{
                background: 'color-mix(in hsl, var(--surface-panel-strong) 72%, transparent)',
                borderColor: 'var(--shell-workspace-border)',
                color: 'var(--text-secondary)',
              }}
            >
              <DsButton variant="ghost" size="icon" iconOnly onPointerDown={stopSurfaceGesture} onClick={() => zoomBy(1 / 1.2)} className="h-9 w-9 [@media(pointer:coarse)]:!h-11 [@media(pointer:coarse)]:!w-11 !rounded-full border border-transparent bg-transparent text-[color:var(--text-secondary)] hover:bg-[color:var(--button-plain-hover-bg)] hover:text-[color:var(--text-primary)]" aria-label={t('common:imageViewer.zoomOut')} title={t('common:imageViewer.zoomOut')}>
                <MagnifyingGlassMinus size={16} />
              </DsButton>
              <span className="min-w-[44px] px-2 py-1 text-center text-[11px] font-medium tracking-[0.02em] text-[color:var(--text-secondary)]">
                {Math.round(scale * 100)}%
              </span>
              <DsButton variant="ghost" size="icon" iconOnly onPointerDown={stopSurfaceGesture} onClick={() => zoomBy(1.2)} className="h-9 w-9 [@media(pointer:coarse)]:!h-11 [@media(pointer:coarse)]:!w-11 !rounded-full border border-transparent bg-transparent text-[color:var(--text-secondary)] hover:bg-[color:var(--button-plain-hover-bg)] hover:text-[color:var(--text-primary)]" aria-label={t('common:imageViewer.zoomIn')} title={t('common:imageViewer.zoomIn')}>
                <MagnifyingGlassPlus size={16} />
              </DsButton>
              <div className="mx-1 h-4 w-px bg-[color:var(--shell-workspace-border)]" />
              <DsButton variant="ghost" size="icon" iconOnly onPointerDown={stopSurfaceGesture} onClick={() => setRotation((prev) => (prev + 90) % 360)} className="h-9 w-9 [@media(pointer:coarse)]:!h-11 [@media(pointer:coarse)]:!w-11 !rounded-full border border-transparent bg-transparent text-[color:var(--text-secondary)] hover:bg-[color:var(--button-plain-hover-bg)] hover:text-[color:var(--text-primary)]" aria-label={t('common:imageViewer.rotate')} title={t('common:imageViewer.rotate')}>
                <ArrowClockwise size={16} />
              </DsButton>
              <DsButton variant="ghost" size="icon" iconOnly onPointerDown={stopSurfaceGesture} onClick={handleResetView} className="h-9 w-9 [@media(pointer:coarse)]:!h-11 [@media(pointer:coarse)]:!w-11 !rounded-full border border-transparent bg-transparent text-[color:var(--text-secondary)] hover:bg-[color:var(--button-plain-hover-bg)] hover:text-[color:var(--text-primary)]" aria-label={t('common:imageViewer.reset')} title={t('common:imageViewer.reset')}>
                <House size={16} />
              </DsButton>
              <div className="mx-1 h-4 w-px bg-[color:var(--shell-workspace-border)]" />
              <DsButton variant="ghost" size="icon" iconOnly onPointerDown={stopSurfaceGesture} onClick={handleDownload} className="h-9 w-9 [@media(pointer:coarse)]:!h-11 [@media(pointer:coarse)]:!w-11 !rounded-full border border-transparent bg-transparent text-[color:var(--text-secondary)] hover:bg-[color:var(--button-plain-hover-bg)] hover:text-[color:var(--text-primary)]" aria-label={t('chatV2:blocks.imageGen.download')} title={t('chatV2:blocks.imageGen.download')}>
                <Download size={16} />
              </DsButton>
              <DsButton variant="ghost" size="icon" iconOnly onPointerDown={stopSurfaceGesture} onClick={handleOpenInNewTab} className="h-9 w-9 [@media(pointer:coarse)]:!h-11 [@media(pointer:coarse)]:!w-11 !rounded-full border border-transparent bg-transparent text-[color:var(--text-secondary)] hover:bg-[color:var(--button-plain-hover-bg)] hover:text-[color:var(--text-primary)]" aria-label={t('chatV2:blocks.imageGen.openInNewTab')} title={t('chatV2:blocks.imageGen.openInNewTab')}>
                <ArrowSquareOut size={16} />
              </DsButton>
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
