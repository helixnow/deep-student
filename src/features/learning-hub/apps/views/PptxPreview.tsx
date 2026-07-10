/**
 * PPTX 演示文稿预览组件
 * 使用 pptx-preview 库将 PPTX 文档渲染为 HTML
 * 
 * 工具栏已移至 FileContentView 统一管理
 * 幻灯片导航已移至底部 UnifiedPreviewToolbar
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { init as initPptxPreview } from 'pptx-preview';
import { CircleNotch } from '@phosphor-icons/react';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import {
  normalizeBase64,
  decodeBase64ToArrayBuffer,
  waitForNextFrame,
} from './previewUtils';
import { sanitizeRenderedDom } from './sanitizeRenderedDom';
import type { SlideNavInfo } from './UnifiedPreviewToolbar';

// PPTX 幻灯片选择器（pptx-preview 库生成的结构）
const PPTX_SLIDE_SELECTOR = '.pptx-preview-slide-wrapper';

/**
 * 检查解码后的二进制是否为合法的 OOXML（ZIP）容器。
 * OLE 复合文档头（D0 CF 11 E0）意味着文件被密码保护（加密 OOXML 的外层包装）
 * 或是旧版二进制格式（.ppt），两者都无法用当前渲染器预览。
 */
function detectContainerIssue(buffer: ArrayBuffer): 'encrypted-or-legacy' | 'invalid' | null {
  const bytes = new Uint8Array(buffer);
  if (bytes.length >= 2 && bytes[0] === 0x50 && bytes[1] === 0x4b) return null;
  if (bytes.length >= 4 && bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0) {
    return 'encrypted-or-legacy';
  }
  return 'invalid';
}

interface PptxPreviewProps {
  /** Base64 编码的 PPTX 文件内容 */
  base64Content: string;
  /** 文件名 */
  fileName: string;
  /** 自定义类名 */
  className?: string;
  /** 外部控制：缩放比例（由 FileContentView 管理） */
  zoomScale?: number;
  /** 幻灯片导航信息变更回调（用于底部工具栏显示页码控制） */
  onSlideInfoChange?: (info: SlideNavInfo | null) => void;
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
  onSlideInfoChange,
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

  // 使用外部控制的缩放值（由 FileContentView 统一管理）
  const zoomScale = externalZoomScale ?? 1;

  const effectiveScale = useMemo(
    () => Number((autoScale * zoomScale).toFixed(3)),
    [autoScale, zoomScale]
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
      // 切换文件时立即清除旧的幻灯片导航信息，避免工具栏显示过期页码
      setTotalSlides(0);
      setCurrentSlide(0);

      try {
        const normalizedBase64 = normalizeBase64(base64Content);
        if (!normalizedBase64) {
          if (isMounted && renderToken === renderTokenRef.current) {
            setError(t('learningHub:docPreview.emptyContent'));
            setIsLoading(false);
          }
          return;
        }

        // 先让加载指示器完成绘制，再进行重解码/渲染
        await waitForNextFrame();
        if (!isMounted || renderToken !== renderTokenRef.current) return;

        // 解码 Base64 为 ArrayBuffer
        const arrayBuffer = decodeBase64ToArrayBuffer(normalizedBase64);

        // 提前识别加密/旧版二进制/非 Office 文件，给出可操作的提示
        const containerIssue = detectContainerIssue(arrayBuffer);
        if (containerIssue) {
          if (isMounted && renderToken === renderTokenRef.current) {
            setError(t(
              containerIssue === 'encrypted-or-legacy'
                ? 'learningHub:officePreview.encryptedOrLegacy'
                : 'learningHub:officePreview.invalidFormat'
            ));
            setIsLoading(false);
          }
          return;
        }

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
          // 清除可能残留的部分渲染内容
          container.innerHTML = '';
          setError(err instanceof Error ? err.message : t('learningHub:docPreview.renderPptxFailed'));
          setIsLoading(false);
        }
      }
    };

    void renderPptx();

    return () => {
      isMounted = false;
      renderTokenRef.current += 1;
      // 清空容器内容（使用 effect 内捕获的引用，避免 cleanup 时 ref 已变化）
      container.innerHTML = '';
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

  // ★ IntersectionObserver 同步滚动位置与当前幻灯片指示。
  //   按各幻灯片的可见比例取最大者，而不是"可见即命中"——
  //   放大后单张幻灯片可能永远达不到固定阈值（如 50%），固定阈值会导致指示失灵
  useEffect(() => {
    const container = containerRef.current;
    const viewport = viewportRef.current;
    if (!container || !viewport || totalSlides === 0) return;

    const slides = Array.from(container.querySelectorAll(PPTX_SLIDE_SELECTOR));
    if (!slides.length) return;

    const ratios = new Map<Element, number>();

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          ratios.set(entry.target, entry.isIntersecting ? entry.intersectionRatio : 0);
        }
        let bestIndex = -1;
        let bestRatio = 0;
        slides.forEach((slide, index) => {
          const ratio = ratios.get(slide) ?? 0;
          if (ratio > bestRatio) {
            bestRatio = ratio;
            bestIndex = index;
          }
        });
        if (bestIndex >= 0) {
          setCurrentSlide(bestIndex);
        }
      },
      { root: viewport, threshold: [0, 0.25, 0.5, 0.75, 1] }
    );

    slides.forEach((slide) => observer.observe(slide));
    return () => observer.disconnect();
  }, [totalSlides]);

  // 导航到指定幻灯片
  const navigateToSlide = useCallback((index: number) => {
    if (!containerRef.current) return;
    const slides = containerRef.current.querySelectorAll(PPTX_SLIDE_SELECTOR);
    if (slides[index]) {
      slides[index].scrollIntoView({ behavior: 'smooth', block: 'start' });
      setCurrentSlide(index);
    }
  }, []);

  // 向父组件报告幻灯片导航信息（用于底部工具栏页码控制）
  const onSlideInfoChangeRef = useRef(onSlideInfoChange);
  onSlideInfoChangeRef.current = onSlideInfoChange;

  useEffect(() => {
    if (!onSlideInfoChange) return;
    if (totalSlides > 0) {
      onSlideInfoChange({ current: currentSlide, total: totalSlides, navigateTo: navigateToSlide });
    } else {
      onSlideInfoChange(null);
    }
  }, [currentSlide, totalSlides, navigateToSlide, onSlideInfoChange]);

  // 卸载时清除导航信息，避免父组件残留过期的页码状态
  useEffect(() => {
    return () => {
      onSlideInfoChangeRef.current?.(null);
    };
  }, []);

  // 键盘导航：PageUp/PageDown/方向左右 = 上/下一张；Home/End = 首/末张
  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (totalSlides === 0 || e.ctrlKey || e.metaKey || e.altKey) return;
    switch (e.key) {
      case 'PageDown':
      case 'ArrowRight':
        navigateToSlide(Math.min(totalSlides - 1, currentSlide + 1));
        break;
      case 'PageUp':
      case 'ArrowLeft':
        navigateToSlide(Math.max(0, currentSlide - 1));
        break;
      case 'Home':
        navigateToSlide(0);
        break;
      case 'End':
        navigateToSlide(totalSlides - 1);
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  // 注意：出错时不能整体卸载渲染容器（containerRef 需保持挂载，
  // 否则切换到正常文件后 effect 因拿不到容器而无法恢复渲染）
  return (
    <div
      className={`relative flex flex-col h-full bg-muted/30 ${className}`}
      aria-busy={isLoading && !error}
      tabIndex={0}
      onKeyDown={handleKeyDown}
    >
      {isLoading && !error && (
        <div className="absolute inset-0 flex items-center justify-center bg-background/80 z-10">
          <CircleNotch size={32} className="animate-spin text-primary" />
        </div>
      )}
      {error && (
        <div className="absolute inset-0 flex items-center justify-center p-8 text-destructive bg-background z-10" role="alert">
          <p>{t('learningHub:docPreview.cannotPreviewSlides')}: {error}</p>
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
          }}
          aria-label={fileName ? t('learningHub:docPreview.pptxPreviewLabel', { name: fileName }) : t('learningHub:docPreview.pptxPreviewDefault')}
        />
      </CustomScrollArea>
      <style>{`
        /* 整体容器 */
        .pptx-container .pptx-content-wrapper {
          min-height: 200px;
          overflow: visible;
          width: max-content;
          margin: 0 auto;
        }
        
        /* pptx-preview 库生成的主包装器 - 覆盖其内联样式。
           缩放使用 zoom 而非 transform:scale——zoom 参与布局，
           滚动范围随缩放同步变化，且等比缩放保持幻灯片纵横比 */
        .pptx-container .pptx-preview-wrapper {
          background: transparent !important;
          height: auto !important;
          overflow: visible !important;
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 32px;
          padding: 16px 0 32px 0;
          zoom: var(--pptx-scale, 1);
          width: max-content;
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
