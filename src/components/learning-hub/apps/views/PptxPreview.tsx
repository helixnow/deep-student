/**
 * PPTX 演示文稿预览组件
 * 使用 pptx-preview 库将 PPTX 文档渲染为 HTML
 * 
 * 工具栏已移至 FileContentView 统一管理
 * 本组件保留底部幻灯片导航栏
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { init as initPptxPreview } from 'pptx-preview';
import { Loader2, ChevronLeft, ChevronRight } from 'lucide-react';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { NotionButton } from '@/components/ui/NotionButton';
import {
  normalizeBase64,
  decodeBase64ToArrayBuffer,
} from './previewUtils';
import { sanitizeRenderedDom } from './sanitizeRenderedDom';

// PPTX 幻灯片选择器（pptx-preview 库生成的结构）
const PPTX_SLIDE_SELECTOR = '.pptx-preview-slide-wrapper';

interface PptxPreviewProps {
  /** Base64 编码的 PPTX 文件内容 */
  base64Content: string;
  /** 文件名 */
  fileName: string;
  /** 自定义类名 */
  className?: string;
  /** 外部控制：缩放比例（由 FileContentView 管理） */
  zoomScale?: number;
}

/**
 * PPTX 演示文稿预览组件
 * 将 PPTX 文件渲染为可视化的幻灯片内容
 */
export const PptxPreview: React.FC<PptxPreviewProps> = ({
  base64Content,
  fileName,
  className = '',
  zoomScale: externalZoomScale,
}) => {
  const { t } = useTranslation(['learningHub']);
  const containerRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const renderTokenRef = useRef(0);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [currentSlide, setCurrentSlide] = useState(0);
  const [totalSlides, setTotalSlides] = useState(0);
  const [autoScale, setAutoScale] = useState(1);
  const [contentWidth, setContentWidth] = useState<number | null>(null);

  // 使用外部控制的缩放值（由 FileContentView 统一管理）
  const zoomScale = externalZoomScale ?? 1;

  const effectiveScale = useMemo(
    () => Number((autoScale * zoomScale).toFixed(3)),
    [autoScale, zoomScale]
  );
  const scaledWidth = useMemo(
    () => (contentWidth ? Math.max(1, contentWidth * effectiveScale) : null),
    [contentWidth, effectiveScale]
  );

  useEffect(() => {
    if (!containerRef.current) return;

    let isMounted = true;
    const renderToken = ++renderTokenRef.current;
    const container = containerRef.current;

    const renderPptx = async () => {
      setIsLoading(true);
      setError(null);
      setAutoScale(1);
      setContentWidth(null);

      try {
        const normalizedBase64 = normalizeBase64(base64Content);
        if (!normalizedBase64) {
          if (isMounted && renderToken === renderTokenRef.current) {
            setError(t('learningHub:docPreview.emptyContent'));
            setIsLoading(false);
          }
          return;
        }

        // 解码 Base64 为 ArrayBuffer
        const arrayBuffer = decodeBase64ToArrayBuffer(normalizedBase64);

        if (!isMounted || renderToken !== renderTokenRef.current) return;

        // 清空容器
        if (container) {
          container.innerHTML = '';
        }

        // 渲染 PPTX - 使用较大宽度保证质量，后续通过 CSS 缩放适配
        const previewer = initPptxPreview(container, {
          width: 960,
        });
        await previewer.preview(arrayBuffer);

        if (isMounted && renderToken === renderTokenRef.current) {
          // ★ 渲染后使用 DOMPurify 进行完整安全消毒（移除危险标签+属性+协议）
          sanitizeRenderedDom(container);
          // 统计幻灯片数量（使用精确选择器）
          const slides = container.querySelectorAll(PPTX_SLIDE_SELECTOR);
          setTotalSlides(slides?.length || 0);
          setCurrentSlide(0);
          setIsLoading(false);
        }
      } catch (err: unknown) {
        console.error('Failed to render PPTX:', err);
        if (isMounted && renderToken === renderTokenRef.current) {
          setError(err instanceof Error ? err.message : t('learningHub:docPreview.renderPptxFailed'));
          setIsLoading(false);
        }
      }
    };

    void renderPptx();

    return () => {
      isMounted = false;
      renderTokenRef.current += 1;
      // 清空容器内容
      if (containerRef.current) {
        containerRef.current.innerHTML = '';
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- t 不加入依赖：语言切换不应重新渲染文档
  }, [base64Content]);

  // 自适应宽度计算
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let frame = 0;
    let resizeObserver: ResizeObserver | null = null;
    let mutationObserver: MutationObserver | null = null;

    const getScaleTarget = () =>
      (container.querySelector('.pptx-preview-wrapper') as HTMLElement | null);

    const updateScale = () => {
      const viewport = viewportRef.current;
      const target = getScaleTarget();
      if (!viewport || !target) return;
      const availableWidth = viewport.clientWidth;
      const targetWidth = target.scrollWidth || target.clientWidth;
      if (!availableWidth || !targetWidth) return;
      const nextAutoScale = Math.min(1, availableWidth / targetWidth);
      setAutoScale((prev) => {
        if (Math.abs(prev - nextAutoScale) < 0.01) return prev;
        return Number(nextAutoScale.toFixed(3));
      });
      setContentWidth((prev) => (prev === targetWidth ? prev : targetWidth));
    };

    const scheduleUpdate = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(updateScale);
    };

    mutationObserver = new MutationObserver(scheduleUpdate);
    mutationObserver.observe(container, { childList: true, subtree: true });

    if (viewportRef.current) {
      resizeObserver = new ResizeObserver(scheduleUpdate);
      resizeObserver.observe(viewportRef.current);
    }

    scheduleUpdate();

    return () => {
      if (frame) cancelAnimationFrame(frame);
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
    };
  }, [base64Content]);

  // ★ IntersectionObserver 同步滚动位置与当前幻灯片指示
  useEffect(() => {
    const container = containerRef.current;
    const viewport = viewportRef.current;
    if (!container || !viewport || totalSlides === 0) return;

    const slides = container.querySelectorAll(PPTX_SLIDE_SELECTOR);
    if (!slides.length) return;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            const index = Array.from(slides).indexOf(entry.target as Element);
            if (index >= 0) {
              setCurrentSlide(index);
            }
          }
        }
      },
      { root: viewport, threshold: 0.5 }
    );

    slides.forEach((slide) => observer.observe(slide));
    return () => observer.disconnect();
  }, [totalSlides]);

  // 导航到指定幻灯片
  const navigateToSlide = (index: number) => {
    if (!containerRef.current) return;
    const slides = containerRef.current.querySelectorAll(PPTX_SLIDE_SELECTOR);
    if (slides[index]) {
      slides[index].scrollIntoView({ behavior: 'smooth', block: 'start' });
      setCurrentSlide(index);
    }
  };

  if (error) {
    return (
      <div className={`flex items-center justify-center p-8 text-destructive ${className}`}>
        <p>{t('learningHub:docPreview.cannotPreviewSlides')}: {error}</p>
      </div>
    );
  }

  return (
    <div className={`relative flex flex-col h-full bg-muted/30 ${className}`} aria-busy={isLoading}>
      {isLoading && (
        <div className="absolute inset-0 flex items-center justify-center bg-background/80 z-10">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
        </div>
      )}

      {/* 底部幻灯片导航栏 */}
      {totalSlides > 0 && (
        <div className="flex items-center justify-center gap-2 py-2 px-3 border-b bg-card shadow-sm flex-shrink-0">
          <NotionButton
            variant="ghost"
            size="sm"
            onClick={() => navigateToSlide(Math.max(0, currentSlide - 1))}
            disabled={currentSlide === 0}
            className="h-7 w-7 p-0"
          >
            <ChevronLeft className="h-4 w-4" />
          </NotionButton>
          <span className="text-xs font-medium text-foreground whitespace-nowrap">
            {t('learningHub:docPreview.slideNav', { current: currentSlide + 1, total: totalSlides })}
          </span>
          <NotionButton
            variant="ghost"
            size="sm"
            onClick={() => navigateToSlide(Math.min(totalSlides - 1, currentSlide + 1))}
            disabled={currentSlide === totalSlides - 1}
            className="h-7 w-7 p-0"
          >
            <ChevronRight className="h-4 w-4" />
          </NotionButton>
        </div>
      )}
      
      <CustomScrollArea
        className="pptx-container flex-1"
        viewportRef={viewportRef}
        orientation="both"
      >
        <div
          ref={containerRef}
          className="pptx-content-wrapper"
          style={{
            ['--pptx-scale' as string]: effectiveScale,
            ['--pptx-content-width' as string]: contentWidth ? `${contentWidth}px` : undefined,
            ['--pptx-scaled-width' as string]: scaledWidth ? `${scaledWidth}px` : undefined,
          }}
          aria-label={fileName ? t('learningHub:docPreview.pptxPreviewLabel', { name: fileName }) : t('learningHub:docPreview.pptxPreviewDefault')}
        />
      </CustomScrollArea>
      <style>{`
        /* 整体容器 */
        .pptx-container .pptx-content-wrapper {
          min-height: 200px;
          overflow: visible;
          width: var(--pptx-scaled-width, auto);
          margin: 0 auto;
        }
        
        /* pptx-preview 库生成的主包装器 - 覆盖其内联样式 */
        .pptx-container .pptx-preview-wrapper {
          background: transparent !important;
          height: auto !important;
          overflow: visible !important;
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 32px;
          padding: 16px 0 32px 0;
          transform: scale(var(--pptx-scale, 1));
          transform-origin: top left;
          width: var(--pptx-content-width, max-content);
        }
        
        /* 每个幻灯片容器 */
        .pptx-container .pptx-preview-wrapper > .pptx-preview-slide-wrapper,
        .pptx-container .pptx-preview-wrapper > div[class*="slide"] {
          background: #ffffff !important;
          border-radius: 8px;
          box-shadow: 
            0 4px 6px -1px hsl(var(--foreground) / 0.08),
            0 2px 4px -2px hsl(var(--foreground) / 0.06),
            0 0 0 1px hsl(var(--border) / 0.5);
          overflow: hidden;
          flex-shrink: 0;
        }
        
        /* 幻灯片内容区域白色背景 */
        .pptx-container .slide-wrapper,
        .pptx-container [class*="slide-wrapper"] {
          background: #ffffff !important;
        }
        
        /* 隐藏 pptx-preview 内置的翻页按钮和分页 */
        .pptx-container .pptx-preview-wrapper-next,
        .pptx-container .pptx-preview-wrapper-pagination {
          display: none !important;
        }
        
        /* 图片样式 */
        .pptx-container img {
          max-width: 100%;
          height: auto;
        }
        
        /* 表格样式 */
        .pptx-container table {
          border-collapse: collapse;
          margin: 8px 0;
        }
        .pptx-container td, .pptx-container th {
          border: 1px solid hsl(var(--border));
          padding: 8px;
        }
      `}</style>
    </div>
  );
};

export default PptxPreview;
