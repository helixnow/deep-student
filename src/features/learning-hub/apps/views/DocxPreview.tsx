/**
 * DOCX 富文本预览组件
 * 使用 docx-preview 库将 DOCX 文档渲染为 HTML
 *
 * 观感参考常见办公文档网页预览 / macOS Quick Look：
 * - 灰色台面 + 白纸页面 + 柔和投影（暗色模式保持浅色纸面，文档原色不做重写，
 *   与 Word/快速查看的行为一致，彩色文字、品牌色完整保真）
 * - 字号缩放通过 calc(原字号 × --docx-font-scale) 实现，不破坏文档内部字号层级
 * - 所有组件样式以实例唯一的 data-docx-instance 属性作用域隔离，多实例互不影响
 *
 * 工具栏已移至 FileContentView 统一管理
 */

import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { renderAsync } from 'docx-preview';
import { FileX } from '@phosphor-icons/react';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { Skeleton } from '@/components/ui/shad/Skeleton';
import { useIsMobile } from '@/hooks/useBreakpoint';
import {
  normalizeBase64,
  decodeBase64ToArrayBuffer,
  waitForNextFrame,
} from './previewUtils';
import { sanitizeRenderedDom } from './sanitizeRenderedDom';
import { sanitizeDocxGeneratedStyles } from './sanitizeGeneratedStyles';

/**
 * 检查解码后的二进制是否为合法的 OOXML（ZIP）容器。
 * OLE 复合文档头（D0 CF 11 E0）意味着文件被密码保护（加密 OOXML 的外层包装）
 * 或是旧版二进制格式（.doc），两者都无法用当前渲染器预览。
 */
function detectContainerIssue(buffer: ArrayBuffer): 'encrypted-or-legacy' | 'invalid' | null {
  const bytes = new Uint8Array(buffer);
  if (bytes.length >= 2 && bytes[0] === 0x50 && bytes[1] === 0x4b) return null;
  if (bytes.length >= 4 && bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0) {
    return 'encrypted-or-legacy';
  }
  return 'invalid';
}

/** 字号缩放变量名：生成样式与内联样式统一改写为 calc(原值 × var(FONT_SCALE_VAR)) */
const FONT_SCALE_VAR = '--docx-font-scale';

/** 台面四周留白（px）；autoScale 计算时需从可用宽度中扣除水平部分 */
const DESK_PADDING_X = 32;
const DESK_PADDING_Y = 28;
/** 📱 移动端（<768px）收窄台面留白：375px 视口下 64px 水平留白会把
 *  A4 页的 autoScale 压到 ~0.39，正文字号过小；收窄后可读宽度 +8% */
const DESK_PADDING_X_MOBILE = 12;
const DESK_PADDING_Y_MOBILE = 16;

/**
 * 将 docx-preview 写在元素内联样式里的 font-size 改写为
 * calc(原值 × var(--docx-font-scale))，与生成样式的改写策略保持一致，
 * 这样字号缩放对"直接格式化"的文本段同样生效且不抹平层级。
 */
function applyInlineFontScale(root: HTMLElement): void {
  for (const el of Array.from(root.querySelectorAll<HTMLElement>('[style*="font-size"]'))) {
    const value = el.style.fontSize;
    if (!value || value.includes(FONT_SCALE_VAR)) continue;
    el.style.fontSize = `calc(${value} * var(${FONT_SCALE_VAR}, 1))`;
  }
}

/** 加载骨架屏的"纸面文本行"宽度序列（模拟标题 + 段落节奏） */
const SKELETON_LINES = [
  'w-3/5', 'w-full', 'w-full', 'w-11/12', 'w-full', 'w-4/5',
  'w-full', 'w-2/3', 'w-full', 'w-full', 'w-5/6', 'w-1/2',
] as const;

interface DocxPreviewProps {
  /** Base64 编码的 DOCX 文件内容 */
  base64Content: string;
  /** 文件名 */
  fileName: string;
  /** 自定义类名 */
  className?: string;
  /** 外部控制：缩放比例（由 FileContentView 管理） */
  zoomScale?: number;
  /** 外部控制：字号比例（由 FileContentView 管理） */
  fontScale?: number;
}

/**
 * DOCX 富文本预览组件
 * 将 DOCX 文件渲染为可视化的 HTML 内容
 */
export const DocxPreview: React.FC<DocxPreviewProps> = ({
  base64Content,
  fileName,
  className = '',
  zoomScale: externalZoomScale,
  fontScale: externalFontScale,
}) => {
  const { t } = useTranslation(['learningHub']);
  const isMobile = useIsMobile();
  const deskPaddingX = isMobile ? DESK_PADDING_X_MOBILE : DESK_PADDING_X;
  const deskPaddingY = isMobile ? DESK_PADDING_Y_MOBILE : DESK_PADDING_Y;
  // autoScale 计算在 effect 中读取（避免因断点切换整体重建 observers 之外的逻辑）
  const deskPaddingXRef = useRef(deskPaddingX);
  deskPaddingXRef.current = deskPaddingX;
  const containerRef = useRef<HTMLDivElement>(null);
  // ★ 独立的样式容器：docx-preview 生成的 <style> 不能进入 sanitizeRenderedDom
  //   （其 ALLOWED_TAGS 不含 style，混在内容容器里会被整体剥离，导致文档失去
  //   段落/表格/字体等样式）。样式为库生成的 CSS，与文档原始 HTML 隔离，安全。
  const styleContainerRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const renderTokenRef = useRef(0);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [autoScale, setAutoScale] = useState(1);
  const [pageInfo, setPageInfo] = useState<{ current: number; total: number }>({ current: 1, total: 0 });
  const [indicatorVisible, setIndicatorVisible] = useState(false);
  const indicatorTimerRef = useRef<number | undefined>(undefined);

  // 实例级作用域标识：组件样式与文档生成样式都以此属性隔离，
  // 多个 DocxPreview 并存（分屏、多窗口）时互不污染
  const reactId = useId();
  const instanceId = useMemo(() => `docx-${reactId.replace(/[^a-zA-Z0-9_-]/g, '')}`, [reactId]);
  const scopeSelector = `[data-docx-instance="${instanceId}"]`;

  // 使用外部控制值，未提供则使用默认值 1
  const zoomScale = externalZoomScale ?? 1;
  const fontScale = externalFontScale ?? 1;

  const effectiveScale = useMemo(
    () => Number((autoScale * zoomScale).toFixed(3)),
    [autoScale, zoomScale]
  );

  // 📱 移动端字号适读补偿：autoScale 把整页压到 <0.7（375px 下 A4 约 0.44）
  // 时正文视觉字号跌破可读下限。按 √ 曲线给字号变量乘补偿（0.7 处连续、
  // 上限 1.6），页面布局宽度不变，文本页内重排为更多行换取可读字号；
  // 用户手动调节的 fontScale 在补偿基础上继续生效。
  const mobileFontCompensation = useMemo(() => {
    if (!isMobile || autoScale >= 0.7) return 1;
    return Math.min(1.6, Number(Math.sqrt(0.7 / autoScale).toFixed(3)));
  }, [isMobile, autoScale]);
  const effectiveFontScale = useMemo(
    () => Number((fontScale * mobileFontCompensation).toFixed(3)),
    [fontScale, mobileFontCompensation]
  );

  useEffect(() => {
    if (!containerRef.current) return;

    let isMounted = true;
    const renderToken = ++renderTokenRef.current;
    const container = containerRef.current;
    const styleContainer = styleContainerRef.current;

    const renderDocx = async () => {
      setIsLoading(true);
      setError(null);
      setPageInfo({ current: 1, total: 0 });

      try {
        setAutoScale(1);
        const normalizedBase64 = normalizeBase64(base64Content);
        if (!normalizedBase64) {
          if (isMounted && renderToken === renderTokenRef.current) {
            setError(t('learningHub:docPreview.emptyContent'));
            setIsLoading(false);
          }
          return;
        }

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
        container.innerHTML = '';
        if (styleContainer) styleContainer.innerHTML = '';

        // ★ 内容与样式都渲染进离屏容器（experimental=false 时 renderAsync
        //   不做布局测量，离屏渲染安全）。这样进行中的旧 renderAsync 永远
        //   触碰不到真实 DOM：切换文件时若旧文档解析得慢、在新渲染开始后才
        //   完成，其"未经消毒"的输出只会写进已被丢弃的离屏节点，而不会
        //   晚到覆盖页面（消毒步骤因 token 过期被跳过的竞态由此根除）
        const detachedContent = document.createElement('div');
        const detachedStyleContainer = document.createElement('div');
        await renderAsync(arrayBuffer, detachedContent, detachedStyleContainer, {
          className: 'docx-preview',
          inWrapper: true,
          ignoreWidth: false,
          ignoreHeight: true, // 忽略高度，让内容自适应
          ignoreFonts: false,
          breakPages: true,
          ignoreLastRenderedPageBreak: true,
          experimental: false,
          trimXmlDeclaration: true,
          useBase64URL: true, // 使用 base64 URL 处理图片
          renderHeaders: true,
          renderFooters: true,
          renderFootnotes: true,
          renderEndnotes: true,
          renderComments: true,
          debug: false,
        });

        if (isMounted && renderToken === renderTokenRef.current) {
          // ★ 渲染后使用 DOMPurify 进行完整安全消毒（移除危险标签+属性+协议）
          sanitizeRenderedDom(detachedContent);
          // 字号缩放：内联 font-size 改写为 calc(原值 × 缩放变量)，保留文档层级
          applyInlineFontScale(detachedContent);
          // 消毒完成后才一次性提交进真实 DOM
          container.replaceChildren(...Array.from(detachedContent.childNodes));
          if (styleContainer) {
            styleContainer.replaceChildren(...sanitizeDocxGeneratedStyles(detachedStyleContainer, {
              scope: scopeSelector,
              fontScaleVar: FONT_SCALE_VAR,
            }));
          }
          setIsLoading(false);
        }
      } catch (err: unknown) {
        console.error('Failed to render DOCX:', err);
        if (isMounted && renderToken === renderTokenRef.current) {
          // 清除可能残留的部分渲染内容
          container.innerHTML = '';
          const message = err instanceof Error ? err.message : t('learningHub:docPreview.renderDocxFailed');
          setError(message);
          setIsLoading(false);
        }
      }
    };

    void renderDocx();

    return () => {
      isMounted = false;
      renderTokenRef.current += 1;
      // 清空容器内容（使用 effect 内捕获的引用，避免 cleanup 时 ref 已变化）
      container.innerHTML = '';
      if (styleContainer) styleContainer.innerHTML = '';
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- t/scopeSelector 不加入依赖：语言切换不应重新渲染文档，实例作用域在组件生命周期内恒定
  }, [base64Content]);

  // 自适应宽度：ResizeObserver 监听视口与内容尺寸变化；
  // MutationObserver 仅在结构变化时兜底，且做 150ms 防抖收敛
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let frame = 0;
    let debounceTimer = 0;
    let observedTarget: HTMLElement | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let mutationObserver: MutationObserver | null = null;

    const getScaleTarget = () =>
      (container.querySelector('.docx-preview-wrapper') as HTMLElement | null) ??
      (container.querySelector('.docx-wrapper') as HTMLElement | null);

    const updateScale = () => {
      const viewport = viewportRef.current;
      const target = getScaleTarget();
      if (!viewport || !target) return;
      // 内容尺寸变化（如图片异步加载）直接由 ResizeObserver 捕获，
      // 无需依赖 DOM 变更事件
      if (resizeObserver && target !== observedTarget) {
        if (observedTarget) resizeObserver.unobserve(observedTarget);
        resizeObserver.observe(target);
        observedTarget = target;
      }
      const availableWidth = viewport.clientWidth - deskPaddingXRef.current * 2;
      const contentWidth = target.scrollWidth || target.clientWidth;
      if (availableWidth <= 0 || !contentWidth) return;
      const nextAutoScale = Math.min(1, availableWidth / contentWidth);
      setAutoScale((prev) => {
        if (Math.abs(prev - nextAutoScale) < 0.01) return prev;
        return Number(nextAutoScale.toFixed(3));
      });
    };

    const scheduleUpdate = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(updateScale);
    };

    // 结构性变更（renderAsync 批量插入节点、sanitize 重写等）会触发
    // 大量 mutation 记录，这里做时间防抖，收敛为一次测量
    const debouncedSchedule = () => {
      window.clearTimeout(debounceTimer);
      debounceTimer = window.setTimeout(scheduleUpdate, 150);
    };

    mutationObserver = new MutationObserver(debouncedSchedule);
    mutationObserver.observe(container, { childList: true, subtree: true });

    resizeObserver = new ResizeObserver(scheduleUpdate);
    if (viewportRef.current) {
      resizeObserver.observe(viewportRef.current);
    }

    scheduleUpdate();

    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.clearTimeout(debounceTimer);
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
    };
  // deskPaddingX：断点切换改变可用宽度，需重算 autoScale（observers 重建成本可忽略）
  }, [base64Content, deskPaddingX]);

  // 页码跟踪：IntersectionObserver 用视口中线判定当前页
  useEffect(() => {
    if (isLoading || error) return;
    const container = containerRef.current;
    const viewport = viewportRef.current;
    if (!container || !viewport) return;

    const sections = Array.from(
      container.querySelectorAll<HTMLElement>('section.docx-preview, section.docx')
    );
    setPageInfo({ current: 1, total: sections.length });
    if (sections.length < 2) return;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const index = sections.indexOf(entry.target as HTMLElement);
          if (index < 0) continue;
          setPageInfo((prev) =>
            prev.current === index + 1 ? prev : { ...prev, current: index + 1 }
          );
        }
      },
      // 收窄根边界为视口中部的窄带，与其相交的 section 即"当前页"
      { root: viewport, rootMargin: '-45% 0px -45% 0px', threshold: 0 }
    );
    sections.forEach((section) => observer.observe(section));

    return () => observer.disconnect();
  }, [isLoading, error, base64Content]);

  // 页码浮标：翻页时短暂浮现，随后淡出（不打断阅读）
  useEffect(() => {
    if (isLoading || error || pageInfo.total <= 1) return;
    setIndicatorVisible(true);
    window.clearTimeout(indicatorTimerRef.current);
    indicatorTimerRef.current = window.setTimeout(() => setIndicatorVisible(false), 1600);
    return () => window.clearTimeout(indicatorTimerRef.current);
  }, [pageInfo, isLoading, error]);

  // 键盘滚动支持：OverlayScrollbars 的视口不在焦点链上，浏览器不会自动
  // 将按键滚动路由过去，这里手动映射 PageUp/PageDown/Home/End
  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const viewport = viewportRef.current;
    if (!viewport || e.ctrlKey || e.metaKey || e.altKey) return;
    const pageHeight = viewport.clientHeight * 0.9;
    switch (e.key) {
      case 'PageDown':
        viewport.scrollBy({ top: pageHeight, behavior: 'smooth' });
        break;
      case 'PageUp':
        viewport.scrollBy({ top: -pageHeight, behavior: 'smooth' });
        break;
      case 'Home':
        viewport.scrollTo({ top: 0, behavior: 'smooth' });
        break;
      case 'End':
        viewport.scrollTo({ top: viewport.scrollHeight, behavior: 'smooth' });
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
      className={`relative min-h-0 overflow-hidden ${className}`}
      data-docx-instance={instanceId}
      aria-busy={isLoading && !error}
      tabIndex={0}
      onKeyDown={handleKeyDown}
    >
      {isLoading && !error && (
        <div
          className="absolute inset-0 z-10 flex justify-center overflow-hidden"
          style={{
            background: 'var(--docx-desk)',
            padding: `${deskPaddingY}px ${deskPaddingX}px 0`,
          }}
          role="status"
          aria-label={t('learningHub:docPreview.loadingDocument')}
        >
          {/* 纸张形状的骨架屏：与真实页面同款台面留白/纸面/投影，
              宽度对齐 A4 默认页宽（794px@96dpi），加载完成后无缝过渡 */}
          <div
            className="flex aspect-[210/297] w-full max-w-[794px] flex-col gap-3 rounded-[2px] px-10 py-12"
            style={{ background: 'var(--docx-paper)', boxShadow: 'var(--docx-page-shadow)' }}
            aria-hidden="true"
          >
            {SKELETON_LINES.map((width, index) => (
              <Skeleton
                key={index}
                className={`${index === 0 ? 'mb-3 h-5' : 'h-3'} ${width}`}
              />
            ))}
          </div>
        </div>
      )}
      {error && (
        <div
          className="absolute inset-0 z-10 flex items-center justify-center p-8"
          style={{ background: 'var(--docx-desk)' }}
          role="alert"
        >
          <div className="flex max-w-sm flex-col items-center gap-2 text-center">
            <FileX size={40} weight="thin" className="mb-1 text-muted-foreground" aria-hidden="true" />
            <p className="text-sm font-medium text-foreground">
              {t('learningHub:docPreview.cannotPreviewDoc')}
            </p>
            <p className="text-xs text-muted-foreground">{error}</p>
          </div>
        </div>
      )}
      {/* docx-preview 生成的文档样式（<style> 标签），与被消毒的内容容器隔离 */}
      <div ref={styleContainerRef} aria-hidden="true" />
      <CustomScrollArea
        className="docx-container h-full min-h-0"
        orientation="both"
        viewportRef={viewportRef}
      >
        <div
          ref={containerRef}
          className={`docx-content-wrapper${!isLoading && !error ? ' ui-rise-in' : ''}`}
          aria-label={fileName ? t('learningHub:docPreview.docxPreviewLabel', { name: fileName }) : t('learningHub:docPreview.docxPreviewDefault')}
          style={{
            ['--docx-scale' as string]: effectiveScale.toString(),
            [FONT_SCALE_VAR as string]: effectiveFontScale.toString(),
          } as React.CSSProperties}
        />
      </CustomScrollArea>
      {/* 页码浮标：内联小浮标（非模态），翻页时浮现后自动淡出 */}
      {!isLoading && !error && pageInfo.total > 1 && (
        <div
          data-wb-blur-surface
          className={`pointer-events-none absolute bottom-4 left-1/2 z-10 -translate-x-1/2 rounded-full border border-border bg-background/90 px-3 py-1 text-xs tabular-nums text-muted-foreground shadow-sm backdrop-blur-sm transition-opacity duration-150 ${indicatorVisible ? 'opacity-100' : 'opacity-0'}`}
          aria-hidden={!indicatorVisible}
        >
          {t('learningHub:docPreview.pageIndicator', { current: pageInfo.current, total: pageInfo.total })}
        </div>
      )}
      <style>{`
        /* ============ 台面 / 纸面 / 墨色（语义变量组合，无硬编码色值） ============
           暗色模式沿用 Word 网页版与 macOS Quick Look 的策略：纸面保持浅色，
           文档原有的彩色文字、品牌色、高亮不做任何重写，保真且天然可读 */
        ${scopeSelector} {
          --docx-desk: hsl(var(--muted));
          --docx-paper: hsl(var(--background));
          --docx-ink: hsl(var(--foreground));
          --docx-page-shadow:
            0 1px 2px hsl(var(--foreground) / 0.08),
            0 8px 24px hsl(var(--foreground) / 0.08);
          background: var(--docx-desk);
        }
        :root.dark ${scopeSelector} {
          --docx-desk: hsl(var(--card));
          --docx-paper: hsl(var(--foreground));
          --docx-ink: hsl(var(--background));
          --docx-page-shadow:
            0 1px 3px hsl(var(--background) / 0.7),
            0 10px 28px hsl(var(--background) / 0.55);
        }

        /* 内容容器：台面留白 + 水平居中 */
        ${scopeSelector} .docx-content-wrapper {
          min-height: 200px;
          overflow: visible;
          width: max-content;
          margin: 0 auto;
          padding: ${deskPaddingY}px ${deskPaddingX}px;
        }

        /* docx-preview 外层包装（可能带内联 padding）
           注意：docx-preview 库根据 className 配置生成 .{className}-wrapper，
           当前配置 className='docx-preview' → 生成 .docx-preview-wrapper
           同时兼容默认的 .docx-wrapper 以防配置变化

           缩放使用 zoom 而非 transform:scale——zoom 参与布局，
           垂直/水平滚动范围随缩放同步变化，不会出现
           缩小后残留空白滚动区域、放大后底部内容无法滚动到的问题 */
        ${scopeSelector} .docx-preview-wrapper,
        ${scopeSelector} .docx-wrapper {
          padding: 0 !important;
          margin: 0;
          background: transparent !important;
          box-shadow: none !important;
          width: max-content;
          max-width: none;
          box-sizing: border-box;
          overflow: visible;
          zoom: var(--docx-scale, 1);
        }

        /* 页面分节 = 一张白纸：柔和投影 + 页间距 + 渐进渲染
           （content-visibility 让离屏页面跳过排版渲染，大文档滚动丝滑；
           选择器特异度需压过库注入的默认 section 样式，保证暗色纸面生效） */
        ${scopeSelector} .docx-preview-wrapper > section.docx-preview,
        ${scopeSelector} .docx-wrapper > section.docx {
          background: var(--docx-paper);
          box-shadow: var(--docx-page-shadow);
          border: none;
          border-radius: 2px;
          margin-bottom: 28px;
          box-sizing: border-box;
          overflow-wrap: break-word;
          content-visibility: auto;
          contain-intrinsic-size: auto 794px auto 1123px;
        }

        /* 默认墨色与基准字号：:where() 保持零特异度，
           任何文档自带的颜色/字号规则（生成样式、内联样式）都优先生效——
           这是"亮色保留原色、字号不抹平层级"的关键 */
        ${scopeSelector} :where(section.docx-preview, section.docx) {
          color: var(--docx-ink);
          font-size: calc(12pt * var(${FONT_SCALE_VAR}, 1));
        }

        /* 图片安全约束：不超出纸面（文档内显式尺寸仍然生效） */
        ${scopeSelector} :where(section.docx-preview, section.docx) img {
          max-width: 100%;
          height: auto;
        }

        /* 被安全策略拦截的链接：明确的禁用观感 */
        ${scopeSelector} a[data-blocked] {
          text-decoration: line-through;
        }
      `}</style>
    </div>
  );
};

export default DocxPreview;
