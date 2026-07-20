import React, { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react';

import { cn } from '@/lib/utils';

import { UnifiedPreviewToolbar, type ToolbarPreviewType, type SlideNavInfo } from './UnifiedPreviewToolbar';
import { ZOOM_MIN, ZOOM_MAX, stepZoom, clampNumber } from './previewUtils';

const DocxPreview = lazy(() => import('./DocxPreview'));
const XlsxPreview = lazy(() => import('./XlsxPreview'));
const PptxPreview = lazy(() => import('./PptxPreview'));

type RichDocumentKind = 'docx' | 'xlsx' | 'pptx';

interface RichDocumentPreviewProps {
  kind: RichDocumentKind;
  base64Content: string;
  fileName: string;
  showToolbar: boolean;
  previewType: ToolbarPreviewType;
  zoomScale: number;
  fontScale: number;
  onZoomChange: (zoom: number) => void;
  onFontChange: (font: number) => void;
  onZoomReset: () => void;
  onFontReset: () => void;
  fallback?: React.ReactNode;
  rootClassName?: string;
  bodyClassName?: string;
}

type SlideNavState = SlideNavInfo | null;

/** Ctrl+滚轮的缩放灵敏度：deltaY(px) -> 乘法缩放指数 */
const WHEEL_ZOOM_SENSITIVITY = 0.0022;

export const RichDocumentPreview: React.FC<RichDocumentPreviewProps> = ({
  kind,
  base64Content,
  fileName,
  showToolbar,
  previewType,
  zoomScale,
  fontScale,
  onZoomChange,
  onFontChange,
  onZoomReset,
  onFontReset,
  fallback = null,
  rootClassName,
  bodyClassName,
}) => {
  const [slideNav, setSlideNav] = useState<SlideNavState>(null);
  const handleSlideInfoChange = useCallback((info: SlideNavState) => {
    setSlideNav(info);
  }, []);

  // Ctrl+滚轮 / 触控板捏合缩放。
  // React 的 onWheel 是被动监听器，无法 preventDefault 阻止浏览器整页缩放，
  // 因此使用原生非被动监听器；用 ref 保存最新值避免反复解绑/重绑
  const rootRef = useRef<HTMLDivElement>(null);
  const zoomRef = useRef({ zoomScale, onZoomChange, onZoomReset });
  zoomRef.current = { zoomScale, onZoomChange, onZoomReset };

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    // rAF 节流：一帧内累积滚轮增量，按指数曲线一次性应用，
    // 快速滚动时平滑跟手且不会每个 wheel 事件都触发一次 React 更新
    let pendingDelta = 0;
    let rafId: number | null = null;

    const applyPendingZoom = () => {
      rafId = null;
      const delta = pendingDelta;
      pendingDelta = 0;
      if (delta === 0) return;
      const { zoomScale: current, onZoomChange: change } = zoomRef.current;
      // 乘法缩放：低倍区步幅小、高倍区步幅大，视觉速度恒定
      const factor = Math.exp(-delta * WHEEL_ZOOM_SENSITIVITY);
      // 保留 4 位小数：低倍区（如 25%）乘法步幅小于 0.01，取 2 位会卡死不动
      const next = Number(clampNumber(current * factor, ZOOM_MIN, ZOOM_MAX).toFixed(4));
      if (next !== current) {
        change(next);
      }
    };

    const handleWheel = (e: WheelEvent) => {
      // ctrlKey 同时覆盖触控板捏合手势（浏览器映射为 ctrl+wheel）
      if (!e.ctrlKey || e.deltaY === 0) return;
      e.preventDefault();
      pendingDelta += e.deltaY;
      if (rafId === null) {
        rafId = requestAnimationFrame(applyPendingZoom);
      }
    };

    // 触屏双指捏合：ctrl+wheel 在触屏上不存在，捏合是唯一直觉缩放手势
    // （做法对齐 ImageContentView 的原生非 passive touchmove）。
    // 手势期间用本地值累积倍率，避免依赖 React state 回流造成跳变。
    let pinchDist = 0;
    let pinchZoom = 0;
    const getTouchDist = (touches: TouchList) =>
      Math.hypot(
        touches[1].clientX - touches[0].clientX,
        touches[1].clientY - touches[0].clientY,
      );
    const handleTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 2) {
        pinchDist = getTouchDist(e.touches);
        pinchZoom = zoomRef.current.zoomScale;
      } else {
        pinchDist = 0;
      }
    };
    const handleTouchMove = (e: TouchEvent) => {
      if (pinchDist <= 0 || e.touches.length !== 2) return;
      e.preventDefault();
      const dist = getTouchDist(e.touches);
      if (dist <= 0) return;
      const factor = dist / pinchDist;
      pinchDist = dist;
      pinchZoom = clampNumber(pinchZoom * factor, ZOOM_MIN, ZOOM_MAX);
      const { zoomScale: current, onZoomChange: change } = zoomRef.current;
      const next = Number(pinchZoom.toFixed(4));
      if (next !== current) {
        change(next);
      }
    };
    const handleTouchEnd = (e: TouchEvent) => {
      if (e.touches.length < 2) {
        pinchDist = 0;
      }
    };

    root.addEventListener('wheel', handleWheel, { passive: false });
    root.addEventListener('touchstart', handleTouchStart, { passive: true });
    root.addEventListener('touchmove', handleTouchMove, { passive: false });
    root.addEventListener('touchend', handleTouchEnd, { passive: true });
    root.addEventListener('touchcancel', handleTouchEnd, { passive: true });
    return () => {
      root.removeEventListener('wheel', handleWheel);
      root.removeEventListener('touchstart', handleTouchStart);
      root.removeEventListener('touchmove', handleTouchMove);
      root.removeEventListener('touchend', handleTouchEnd);
      root.removeEventListener('touchcancel', handleTouchEnd);
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
      }
    };
  }, []);

  // 键盘快捷键：Ctrl/⌘ + = / − 沿档位缩放，Ctrl/⌘ + 0 重置。
  // 监听 document 而非依赖容器焦点（预览区通常不含可聚焦元素），
  // 仅在指针悬停于本预览或焦点位于其内部时响应，避免多预览实例互相抢键
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // 不排除 shift：US 键盘上 Ctrl + "+" 实际是 Ctrl+Shift+=（key 为 "+"）
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;

      const root = rootRef.current;
      if (!root) return;
      const isHovered = root.matches(':hover');
      const containsFocus = root.contains(document.activeElement);
      if (!isHovered && !containsFocus) return;

      // 不劫持输入框中的快捷键
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
        return;
      }

      const { zoomScale: current, onZoomChange: change, onZoomReset: reset } = zoomRef.current;
      switch (e.key) {
        case '=':
        case '+':
          e.preventDefault();
          change(stepZoom(current, 1));
          break;
        case '-':
        case '_':
          e.preventDefault();
          change(stepZoom(current, -1));
          break;
        case '0':
          e.preventDefault();
          reset();
          break;
        default:
          break;
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, []);

  return (
    <div ref={rootRef} className={cn('flex h-full min-h-0 flex-col overflow-hidden', rootClassName)}>
      <div className={cn('min-h-0 flex-1 overflow-hidden', bodyClassName)}>
        <Suspense fallback={fallback}>
          {kind === 'docx' && (
            <DocxPreview
              base64Content={base64Content}
              fileName={fileName}
              className="h-full"
              zoomScale={zoomScale}
              fontScale={fontScale}
            />
          )}
          {kind === 'xlsx' && (
            <XlsxPreview
              base64Content={base64Content}
              fileName={fileName}
              className="h-full"
              zoomScale={zoomScale}
              fontScale={fontScale}
            />
          )}
          {kind === 'pptx' && (
            <PptxPreview
              base64Content={base64Content}
              fileName={fileName}
              className="h-full"
              zoomScale={zoomScale}
              onSlideInfoChange={handleSlideInfoChange}
            />
          )}
        </Suspense>
      </div>
      {showToolbar && (
        <UnifiedPreviewToolbar
          previewType={previewType}
          zoomScale={zoomScale}
          fontScale={fontScale}
          onZoomChange={onZoomChange}
          onFontChange={onFontChange}
          onZoomReset={onZoomReset}
          onFontReset={onFontReset}
          slideNav={slideNav}
        />
      )}
    </div>
  );
};

export default RichDocumentPreview;
