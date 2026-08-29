/**
 * PPTX 演示文稿预览组件
 * 使用 pptx-preview 库将 PPTX 文档渲染为 HTML
 *
 * 工具栏已移至 FileContentView 统一管理
 * 幻灯片导航已移至底部 UnifiedPreviewToolbar
 *
 * 布局：左侧内联缩略图导航栏（文档流内收缩主内容区，md 及以上显示）
 * + 主滚动区（幻灯片卡片纵向堆叠）+ 右下角当前页浮标（滚动时淡入淡出）。
 *
 * 样式存活说明：pptx-preview 库的所有幻灯片样式均通过
 * element.style.setProperty 以行内样式写入（不注入 <style> 标签），
 * 而 sanitizeRenderedDom 的 ALLOWED_ATTR 包含 style，因此消毒后视觉不丢失。
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { init as initPptxPreview } from 'pptx-preview';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { Skeleton } from '@/components/ui/shad/Skeleton';
import {
  normalizeBase64,
  decodeBase64ToArrayBuffer,
  waitForNextFrame,
} from './previewUtils';
import { sanitizeRenderedDom } from './sanitizeRenderedDom';
import type { SlideNavInfo } from './UnifiedPreviewToolbar';

// PPTX 幻灯片选择器（pptx-preview 库生成的结构）
const PPTX_SLIDE_SELECTOR = '.pptx-preview-slide-wrapper';

/** 缩略图画布固定宽度（px），克隆节点按此宽度等比缩放 */
const THUMB_WIDTH = 104;

/** 当前页浮标在最后一次滚动/跳转后保持可见的时长（ms） */
const PAGE_BADGE_LINGER_MS = 1400;

/** 程序化平滑滚动的静止判定窗口（ms）：超过该时长无滚动事件即视为到位 */
const PROGRAMMATIC_SCROLL_SETTLE_MS = 160;

/** 用户偏好减少动画时退化为瞬时跳转 */
const prefersReducedMotion = (): boolean =>
  typeof window !== 'undefined' &&
  !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

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

/** 缩略图元数据：原始幻灯片尺寸（未缩放的 CSS 像素）。克隆节点惰性生成 */
interface SlideThumbMeta {
  width: number;
  height: number;
}

/** 缩略图惰性挂载的预取边距：进入该范围才克隆 DOM，离开则卸载回收 */
const THUMB_LAZY_ROOT_MARGIN = '160px 0px';

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
 * 单个幻灯片缩略图按钮
 *
 * 缩略图通过克隆主内容 DOM + CSS transform 缩放实现（成本最低，
 * 无需 canvas 快照）。克隆惰性进行：仅当缩略图滚入预取范围时才
 * 从主渲染区克隆对应幻灯片，滚出后立即卸载回收——大型演示文稿
 * （上百页）的活跃克隆体因此恒定在可视区规模，不随页数线性增长。
 * 克隆节点去除了 pptx-preview-slide-wrapper 类，避免污染选区定位契约
 * （FilePreviewAppWindow.getPreviewSelectionMetadata 依赖该类）。
 */
const SlideThumbnail: React.FC<{
  index: number;
  isActive: boolean;
  meta: SlideThumbMeta | undefined;
  cloneSlide: (index: number) => HTMLElement | null;
  onSelect: (index: number) => void;
  label: string;
}> = ({ index, isActive, meta, cloneSlide, onSelect, label }) => {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const [inView, setInView] = useState(false);

  const thumbWidth = meta?.width || 960;
  const thumbHeight = meta
    ? Math.max(1, Math.round((THUMB_WIDTH / meta.width) * meta.height))
    : Math.round((THUMB_WIDTH * 9) / 16);

  // 惰性挂载哨兵：观察按钮自身是否接近可视区（含祖先滚动容器裁剪）
  useEffect(() => {
    const button = buttonRef.current;
    if (!button) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          setInView(entry.isIntersecting);
        }
      },
      { rootMargin: THUMB_LAZY_ROOT_MARGIN }
    );
    observer.observe(button);
    return () => observer.disconnect();
  }, []);

  // 进入预取范围时克隆并挂载（受控 DOM 注入，源节点已消毒），离开时卸载
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.replaceChildren();
    if (!inView || !meta) return;
    const node = cloneSlide(index);
    if (!node) return;
    const scale = THUMB_WIDTH / thumbWidth;
    node.style.position = 'absolute';
    node.style.top = '0';
    node.style.left = '0';
    node.style.transform = `scale(${scale})`;
    node.style.transformOrigin = 'top left';
    canvas.appendChild(node);
    return () => {
      canvas.replaceChildren();
    };
  }, [inView, meta, index, cloneSlide, thumbWidth]);

  // 当前页变化时让活动缩略图保持在可视范围内
  useEffect(() => {
    if (!isActive) return;
    buttonRef.current?.scrollIntoView({
      block: 'nearest',
      behavior: prefersReducedMotion() ? 'auto' : 'smooth',
    });
  }, [isActive]);

  return (
    <button
      ref={buttonRef}
      type="button"
      onClick={() => onSelect(index)}
      aria-label={label}
      aria-current={isActive ? 'true' : undefined}
      // 触屏：缩略图高度随幻灯片宽高比缩放（THUMB_WIDTH 定宽），超宽幻灯片
      // （>2.36:1）会跌破 44px 触控目标 —— coarse 下 min-h-11 兜底并把画布
      // 垂直居中（信箱式留白）；常规 16:9/4:3 已 ≥44px，视觉零变化
      className={`group relative shrink-0 self-center overflow-hidden rounded-md border transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background [@media(pointer:coarse)]:inline-flex [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:items-center [@media(pointer:coarse)]:justify-center ${
        isActive
          ? 'border-primary shadow-sm ring-1 ring-primary'
          : 'border-border/60 hover:border-border hover:shadow-sm'
      }`}
    >
      <div
        ref={canvasRef}
        aria-hidden
        className="pptx-thumb-canvas relative overflow-hidden bg-white"
        style={{ width: THUMB_WIDTH, height: thumbHeight }}
      />
      <span
        aria-hidden
        className={`absolute left-1 top-1 rounded px-1 text-2xs font-medium leading-4 tabular-nums shadow-sm transition-colors duration-150 ${
          isActive
            ? 'bg-primary text-primary-foreground'
            : 'bg-background/85 text-muted-foreground'
        }`}
      >
        {index + 1}
      </span>
    </button>
  );
};

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
  const previewerRef = useRef<ReturnType<typeof initPptxPreview> | null>(null);
  const thumbMetasRef = useRef<SlideThumbMeta[]>([]);
  const [thumbsVersion, setThumbsVersion] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [currentSlide, setCurrentSlide] = useState(0);
  const [totalSlides, setTotalSlides] = useState(0);
  const [autoScale, setAutoScale] = useState(1);
  const [badgeVisible, setBadgeVisible] = useState(false);
  const badgeTimerRef = useRef<number | null>(null);
  // ★ 程序化跳转期间抑制 IntersectionObserver 回写 currentSlide：
  //   平滑滚动途经的中间幻灯片不应闪烁高亮（缩略图会跟着逐张 scrollIntoView 抖动）
  const programmaticScrollRef = useRef(false);
  const programmaticSettleTimerRef = useRef<number | null>(null);

  const armProgrammaticSettleTimer = useCallback(() => {
    if (programmaticSettleTimerRef.current) {
      window.clearTimeout(programmaticSettleTimerRef.current);
    }
    programmaticSettleTimerRef.current = window.setTimeout(() => {
      programmaticScrollRef.current = false;
      programmaticSettleTimerRef.current = null;
    }, PROGRAMMATIC_SCROLL_SETTLE_MS);
  }, []);

  // 使用外部控制的缩放值（由 FileContentView 统一管理）
  const zoomScale = externalZoomScale ?? 1;

  const effectiveScale = useMemo(
    () => Number((autoScale * zoomScale).toFixed(3)),
    [autoScale, zoomScale]
  );

  // 当前页浮标：滚动/跳转时短暂显示，随后淡出
  const flashBadge = useCallback(() => {
    setBadgeVisible(true);
    if (badgeTimerRef.current) window.clearTimeout(badgeTimerRef.current);
    badgeTimerRef.current = window.setTimeout(
      () => setBadgeVisible(false),
      PAGE_BADGE_LINGER_MS
    );
  }, []);

  useEffect(() => {
    return () => {
      if (badgeTimerRef.current) window.clearTimeout(badgeTimerRef.current);
      if (programmaticSettleTimerRef.current) {
        window.clearTimeout(programmaticSettleTimerRef.current);
      }
    };
  }, []);

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
      thumbMetasRef.current = [];
      setThumbsVersion((v) => v + 1);

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
        // ★ 持有实例引用：cleanup 时必须调用 destroy() 释放库内部
        //   注册的图表（echarts）实例，否则跨挂载周期泄漏
        previewerRef.current = previewer;
        await previewer.preview(arrayBuffer);

        // ★ pptx-preview 用 setTimeout(0) 延迟初始化幻灯片内的图表
        //   （echarts SVG 渲染）。消毒会重写 innerHTML 替换全部节点，
        //   若在图表挂载前执行，图表会渲染进已分离的旧节点而永远不可见。
        //   先等一个宏任务（排在库的图表初始化之后）+ 一帧（zrender 绘制），
        //   让图表 SVG 落入 DOM 后再统一消毒
        await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
        await waitForNextFrame();

        if (isMounted && renderToken === renderTokenRef.current) {
          // ★ 渲染后使用 DOMPurify 进行完整安全消毒（移除危险标签+属性+协议）
          sanitizeRenderedDom(container);
          // 统计幻灯片数量（使用精确选择器）
          const slides = container.querySelectorAll(PPTX_SLIDE_SELECTOR);

          // 记录缩略图元数据（仅尺寸数字，克隆惰性进行——见 SlideThumbnail）。
          // 高度用 rect 宽高比换算，与祖先 zoom 缩放无关（比例不变量）
          const metas: SlideThumbMeta[] = [];
          slides.forEach((slide) => {
            const el = slide as HTMLElement;
            const rect = el.getBoundingClientRect();
            const width = parseFloat(el.style.width) || 960;
            const height =
              parseFloat(el.style.height) ||
              (rect.width > 0 ? (rect.height / rect.width) * width : (width * 9) / 16);
            metas.push({ width, height });
          });
          thumbMetasRef.current = metas;
          setThumbsVersion((v) => v + 1);

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
      // ★ 内存泄漏修复：销毁 previewer 实例（释放库内部注册的
      //   echarts 等图表实例），再清空容器 DOM
      try {
        previewerRef.current?.destroy();
      } catch {
        // destroy 失败不应阻断卸载流程
      }
      previewerRef.current = null;
      thumbMetasRef.current = [];
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
    let debounceTimer = 0;
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

    // ★ 渲染大 PPT 时整树 mutation 非常频繁，防抖收敛为尾沿触发，
    //   避免逐条 mutation 反复 schedule 造成 rAF 抖动
    const debouncedSchedule = () => {
      if (debounceTimer) window.clearTimeout(debounceTimer);
      debounceTimer = window.setTimeout(scheduleUpdate, 120);
    };

    mutationObserver = new MutationObserver(debouncedSchedule);
    mutationObserver.observe(container, { childList: true, subtree: true });

    if (viewportRef.current) {
      // 视口尺寸变化需要即时响应（rAF 已合并同帧多次触发）
      resizeObserver = new ResizeObserver(scheduleUpdate);
      resizeObserver.observe(viewportRef.current);
    }

    scheduleUpdate();

    return () => {
      if (frame) cancelAnimationFrame(frame);
      if (debounceTimer) window.clearTimeout(debounceTimer);
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
        // 程序化跳转途中不回写：目标页已在 navigateToSlide 中同步设置
        if (programmaticScrollRef.current) return;
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

  // 滚动主视口时显示当前页浮标；程序化滚动期间持续顺延静止判定计时
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || totalSlides === 0) return;
    const handleScroll = () => {
      flashBadge();
      if (programmaticScrollRef.current) armProgrammaticSettleTimer();
    };
    viewport.addEventListener('scroll', handleScroll, { passive: true });
    return () => viewport.removeEventListener('scroll', handleScroll);
  }, [totalSlides, flashBadge, armProgrammaticSettleTimer]);

  // 导航到指定幻灯片（平滑滚动，reduced-motion 时退化为瞬时跳转）
  const navigateToSlide = useCallback((index: number) => {
    if (!containerRef.current) return;
    const slides = containerRef.current.querySelectorAll(PPTX_SLIDE_SELECTOR);
    if (slides[index]) {
      programmaticScrollRef.current = true;
      // 目标已在可视位置时不会产生滚动事件，兜底计时器保证标志位释放
      armProgrammaticSettleTimer();
      slides[index].scrollIntoView({
        behavior: prefersReducedMotion() ? 'auto' : 'smooth',
        block: 'start',
      });
      setCurrentSlide(index);
      flashBadge();
    }
  }, [flashBadge, armProgrammaticSettleTimer]);

  // 惰性克隆指定幻灯片：从主渲染区（已消毒）取源节点。
  // 去除幻灯片选择器类：选区定位（getPreviewSelectionMetadata）与
  // IntersectionObserver 都不应命中缩略图克隆体
  const cloneSlide = useCallback((index: number): HTMLElement | null => {
    const container = containerRef.current;
    if (!container) return null;
    const slide = container.querySelectorAll(PPTX_SLIDE_SELECTOR)[index];
    if (!slide) return null;
    const clone = slide.cloneNode(true) as HTMLElement;
    clone.classList.remove('pptx-preview-slide-wrapper');
    clone.classList.add('pptx-thumb-slide');
    return clone;
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
    // 防御：不吞可编辑目标内的按键（方向键/Home/End 在输入框内是光标移动）
    const target = e.target as HTMLElement | null;
    if (
      target &&
      (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
    ) {
      return;
    }
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

  const showThumbRail = !error && totalSlides > 0;

  // 注意：出错时不能整体卸载渲染容器（containerRef 需保持挂载，
  // 否则切换到正常文件后 effect 因拿不到容器而无法恢复渲染）
  return (
    <div
      className={`relative flex h-full min-h-0 flex-col overflow-hidden bg-muted/30 ${className}`}
      aria-busy={isLoading && !error}
      tabIndex={0}
      onKeyDown={handleKeyDown}
    >
      {isLoading && !error && (
        <div
          className="absolute inset-0 z-10 flex flex-col items-center gap-6 overflow-hidden bg-background/90 px-8 py-10"
          role="status"
          aria-label={t('learningHub:docPreview.pptxLoading')}
        >
          {[0, 1, 2].map((i) => (
            <Skeleton
              key={i}
              className="aspect-video w-full max-w-xl shrink-0 rounded-lg"
              style={{ opacity: 1 - i * 0.28 }}
            />
          ))}
        </div>
      )}
      {error && (
        <div className="absolute inset-0 flex items-center justify-center p-8 text-destructive bg-background z-10" role="alert">
          <p>{t('learningHub:docPreview.cannotPreviewSlides')}: {error}</p>
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-row">
        {/* 幻灯片缩略图导航栏：文档流内的内联侧栏（非覆盖式），md 及以上显示 */}
        {showThumbRail && (
          <nav
            className="pptx-thumb-rail ui-rise-in hidden min-h-0 w-[8.5rem] shrink-0 flex-col overflow-hidden border-r border-border/60 bg-muted/20 md:flex"
            aria-label={t('learningHub:docPreview.pptxThumbnails')}
          >
            <CustomScrollArea className="min-h-0 flex-1" orientation="vertical">
              <div className="flex flex-col items-center gap-2.5 px-3 py-3">
                {Array.from({ length: totalSlides }, (_, index) => (
                  <SlideThumbnail
                    key={`${thumbsVersion}-${index}`}
                    index={index}
                    isActive={index === currentSlide}
                    meta={thumbMetasRef.current[index]}
                    cloneSlide={cloneSlide}
                    onSelect={navigateToSlide}
                    label={t('learningHub:docPreview.pptxThumbnailItem', { index: index + 1 })}
                  />
                ))}
              </div>
            </CustomScrollArea>
          </nav>
        )}

        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <CustomScrollArea
            className="pptx-container min-h-0 flex-1"
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

          {/* 当前页浮标：滚动/跳转时淡入，静止后淡出（信息已由底部工具栏承载，浮标仅作视觉辅助） */}
          {showThumbRail && (
            <div
              aria-hidden
              data-wb-blur-surface
              className={`pointer-events-none absolute bottom-3 right-4 z-10 select-none rounded-full border border-border/60 bg-background/90 px-2.5 py-1 text-xs font-medium tabular-nums text-foreground shadow-sm backdrop-blur transition-opacity duration-150 ${
                badgeVisible ? 'opacity-100' : 'opacity-0'
              }`}
            >
              {currentSlide + 1} / {totalSlides}
            </div>
          )}
        </div>
      </div>
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
        
        /* 每个幻灯片容器：白底卡片 + 柔投影 + 圆角，hover 态微妙边框 */
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
          scroll-margin-top: 16px;
          transition: box-shadow 150ms ease;
        }
        .pptx-container .pptx-preview-wrapper > .pptx-preview-slide-wrapper:hover,
        .pptx-container .pptx-preview-wrapper > div[class*="slide"]:hover {
          box-shadow: 
            0 8px 18px -4px hsl(var(--foreground) / 0.12),
            0 2px 4px -2px hsl(var(--foreground) / 0.06),
            0 0 0 1px hsl(var(--ring) / 0.35);
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

        /* 缩略图克隆体：纯展示，不参与交互与选区 */
        .pptx-thumb-canvas .pptx-thumb-slide {
          background: #ffffff !important;
          pointer-events: none;
          user-select: none;
        }
      `}</style>
    </div>
  );
};

export default PptxPreview;
