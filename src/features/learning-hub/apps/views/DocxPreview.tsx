/**
 * DOCX 富文本预览组件
 * 使用 docx-preview 库将 DOCX 文档渲染为 HTML
 * 
 * 工具栏已移至 FileContentView 统一管理
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { renderAsync } from 'docx-preview';
import { CircleNotch } from '@phosphor-icons/react';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import {
  normalizeBase64,
  decodeBase64ToArrayBuffer,
  waitForNextFrame,
} from './previewUtils';
import { sanitizeRenderedDom } from './sanitizeRenderedDom';

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
  const [docxBaseFontSize, setDocxBaseFontSize] = useState<number | null>(null);

  // 使用外部控制值，未提供则使用默认值 1
  const zoomScale = externalZoomScale ?? 1;
  const fontScale = externalFontScale ?? 1;

  const effectiveScale = useMemo(
    () => Number((autoScale * zoomScale).toFixed(3)),
    [autoScale, zoomScale]
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

        // 渲染 DOCX（样式写入独立容器，内容容器随后消毒）
        await renderAsync(arrayBuffer, container, styleContainer ?? container, {
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
          renderComments: false,
          debug: false,
        });

        if (isMounted && renderToken === renderTokenRef.current) {
          // ★ 渲染后使用 DOMPurify 进行完整安全消毒（移除危险标签+属性+协议）
          sanitizeRenderedDom(container);
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
  // eslint-disable-next-line react-hooks/exhaustive-deps -- t 不加入依赖：语言切换不应重新渲染文档
  }, [base64Content]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let frame = 0;
    let resizeObserver: ResizeObserver | null = null;
    let mutationObserver: MutationObserver | null = null;

    const getScaleTarget = () =>
      (container.querySelector('.docx-preview-wrapper') as HTMLElement | null) ??
      (container.querySelector('.docx-wrapper') as HTMLElement | null);

    const updateScale = () => {
      const viewport = viewportRef.current;
      const target = getScaleTarget();
      if (!viewport || !target) return;
      const availableWidth = viewport.clientWidth;
      const contentWidth = target.scrollWidth || target.clientWidth;
      if (!availableWidth || !contentWidth) return;
      const nextAutoScale = Math.min(1, availableWidth / contentWidth);
      setAutoScale((prev) => {
        if (Math.abs(prev - nextAutoScale) < 0.01) return prev;
        return Number(nextAutoScale.toFixed(3));
      });

      const section = (container.querySelector('section.docx-preview') ?? container.querySelector('section.docx')) as HTMLElement | null;
      if (section) {
        const fontSize = Number.parseFloat(getComputedStyle(section).fontSize);
        if (!Number.isNaN(fontSize)) {
          setDocxBaseFontSize((prev) => (prev === fontSize ? prev : fontSize));
        }
      }
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
      className={`relative ${className}`}
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
          <p>{t('learningHub:docPreview.cannotPreviewDoc')}: {error}</p>
        </div>
      )}
      {/* docx-preview 生成的文档样式（<style> 标签），与被消毒的内容容器隔离 */}
      <div ref={styleContainerRef} aria-hidden="true" />
      <CustomScrollArea
        className="docx-container h-full"
        orientation="both"
        viewportRef={viewportRef}
      >
        <div
          ref={containerRef}
          className="docx-content-wrapper"
          aria-label={fileName ? t('learningHub:docPreview.docxPreviewLabel', { name: fileName }) : t('learningHub:docPreview.docxPreviewDefault')}
          style={{
            ['--docx-scale' as string]: effectiveScale.toString(),
            ['--docx-font-scale' as string]: fontScale.toString(),
            ['--docx-base-font-size' as string]: docxBaseFontSize ? `${docxBaseFontSize}px` : undefined,
          } as React.CSSProperties}
        />
      </CustomScrollArea>
      <style>{`
        /* 整体容器 - 适配亮暗主题 */
        .docx-container .docx-content-wrapper {
          min-height: 200px;
          border-radius: 8px;
          overflow: visible;
          width: max-content;
          margin: 0 auto;
        }

        /* docx-preview 外层包装（可能带内联 padding）
           注意：docx-preview 库根据 className 配置生成 .{className}-wrapper，
           当前配置 className='docx-preview' → 生成 .docx-preview-wrapper
           同时兼容默认的 .docx-wrapper 以防配置变化

           缩放使用 zoom 而非 transform:scale——zoom 参与布局，
           垂直/水平滚动范围随缩放同步变化，不会出现
           缩小后残留空白滚动区域、放大后底部内容无法滚动到的问题 */
        .docx-container .docx-preview-wrapper,
        .docx-container .docx-wrapper {
          padding: 0 !important;
          margin: 0;
          background: transparent !important;
          border-radius: 8px;
          box-shadow: none !important;
          width: max-content;
          max-width: none;
          box-sizing: border-box;
          overflow: visible;
          zoom: var(--docx-scale, 1);
        }

        /* 页面分节
           docx-preview 生成 section.{className}，即 section.docx-preview */
        .docx-container .docx-preview-wrapper > section.docx-preview,
        .docx-container .docx-wrapper > section.docx {
          margin-bottom: 24px;
          background: hsl(var(--background)) !important;
          border-radius: 6px;
          border: 1px solid hsl(var(--border));
          box-sizing: border-box;
          font-size: calc(var(--docx-font-scale, 1) * var(--docx-base-font-size, 16px));
        }

        .docx-container .docx-preview-wrapper > section.docx-preview p,
        .docx-container .docx-preview-wrapper > section.docx-preview li,
        .docx-container .docx-preview-wrapper > section.docx-preview td,
        .docx-container .docx-preview-wrapper > section.docx-preview th,
        .docx-container .docx-wrapper > section.docx p,
        .docx-container .docx-wrapper > section.docx li,
        .docx-container .docx-wrapper > section.docx td,
        .docx-container .docx-wrapper > section.docx th {
          font-size: inherit !important;
        }

        /* ★ 文字颜色适配主题 - 通配符覆盖所有子元素 + 内联样式覆盖
           但排除有高亮背景色的元素（如黄色标注），这些元素保持深色文字以确保在彩色背景上可读 */
        .docx-container .docx-preview-wrapper,
        .docx-container .docx-preview-wrapper *:not([style*="background"]),
        .docx-container .docx-wrapper,
        .docx-container .docx-wrapper *:not([style*="background"]) {
          color: hsl(var(--foreground)) !important;
        }
        /* 有高亮背景的元素保持深色文字 */
        .docx-container .docx-preview-wrapper [style*="background"],
        .docx-container .docx-wrapper [style*="background"] {
          color: #000 !important;
        }
        /* 覆盖 docx-preview 库注入的内联 color 样式（如 style="color: #000000"），
           同样排除有高亮背景的元素 */
        .docx-container .docx-preview-wrapper [style*="color"]:not([style*="background"]),
        .docx-container .docx-wrapper [style*="color"]:not([style*="background"]) {
          color: hsl(var(--foreground)) !important;
        }

        /* 标题样式 */
        .docx-container h1, .docx-container h2, .docx-container h3,
        .docx-container h4, .docx-container h5, .docx-container h6 {
          color: hsl(var(--foreground)) !important;
          font-weight: 600;
          margin-bottom: 0.5em;
        }

        /* 段落间距 */
        .docx-container p {
          line-height: 1.7;
          margin-bottom: 0.8em;
          word-break: break-word;
          overflow-wrap: anywhere;
        }

        /* 表格样式 */
        .docx-container table {
          border-collapse: collapse;
          width: 100%;
          margin: 16px 0;
          background: hsl(var(--card));
          border-radius: 6px;
          overflow: hidden;
        }
        .docx-container td, .docx-container th {
          border: 1px solid hsl(var(--border));
          padding: 10px 12px;
          color: hsl(var(--foreground)) !important;
        }
        .docx-container th {
          background: hsl(var(--muted));
          font-weight: 600;
        }
        .docx-container tr:nth-child(even) td {
          background: hsl(var(--muted) / 0.3);
        }

        /* 图片样式 */
        .docx-container img {
          max-width: 100%;
          height: auto;
          border-radius: 4px;
          margin: 8px 0;
        }

        /* 列表样式 */
        .docx-container ul, .docx-container ol {
          padding-left: 24px;
          margin: 12px 0;
        }
        .docx-container li {
          margin-bottom: 6px;
          line-height: 1.6;
        }

        /* 链接样式 */
        .docx-container a {
          color: hsl(var(--primary)) !important;
          text-decoration: underline;
        }

        /* 代码/引用块 */
        .docx-container pre, .docx-container code {
          background: hsl(var(--muted));
          padding: 2px 6px;
          border-radius: 4px;
          font-family: ui-monospace, monospace;
          font-size: 0.9em;
        }
      `}</style>
    </div>
  );
};

export default DocxPreview;
