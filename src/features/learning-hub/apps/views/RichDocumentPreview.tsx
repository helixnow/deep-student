import React, { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react';

import { cn } from '@/lib/utils';

import { UnifiedPreviewToolbar, type ToolbarPreviewType, type SlideNavInfo } from './UnifiedPreviewToolbar';
import { ZOOM_MIN, ZOOM_MAX, ZOOM_STEP, clampNumber } from './previewUtils';

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
  const zoomRef = useRef({ zoomScale, onZoomChange });
  zoomRef.current = { zoomScale, onZoomChange };

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const handleWheel = (e: WheelEvent) => {
      if (!e.ctrlKey || e.deltaY === 0) return;
      e.preventDefault();
      const { zoomScale: current, onZoomChange: change } = zoomRef.current;
      const step = e.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP;
      const next = Number(clampNumber(current + step, ZOOM_MIN, ZOOM_MAX).toFixed(2));
      if (next !== current) {
        change(next);
      }
    };

    root.addEventListener('wheel', handleWheel, { passive: false });
    return () => {
      root.removeEventListener('wheel', handleWheel);
    };
  }, []);

  return (
    <div ref={rootRef} className={cn('flex flex-col h-full overflow-hidden', rootClassName)}>
      <div className={cn('flex-1 overflow-hidden', bodyClassName)}>
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
