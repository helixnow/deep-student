/**
 * InlineLatex - 内联 LaTeX 渲染组件
 * 自动检测文本中的 $...$ / $$...$$ 并渲染为数学公式，
 * 无 LaTeX 时回退为纯文本显示。
 *
 * 性能契约：
 * - 模块级有界 LRU 缓存已净化 HTML（text → sanitizedHtml | null），
 *   画布平移/缩放虚拟化重挂与大纲滚动均 O(1) 命中，避免重复同步执行 KaTeX + DOMPurify；
 * - `.katex-error` 视觉样式由静态 CSS 承载，仅在 HTML 实际含语法错误时才补挂 title 提示。
 */
import React, { useEffect, useMemo, useRef } from 'react';
import i18next from 'i18next';
import DOMPurify from 'dompurify';
import { ensureKatexStyles } from '@/utils/lazyStyles';
import { renderLatexToHtml } from '../../utils/renderLatex';

const MAX_SANITIZED_LATEX_CACHE = 1000;
const sanitizedLatexCache = new Map<string, string | null>();
let katexStylesRequested = false;

const DOMPURIFY_KATEX_CONFIG = {
  ADD_TAGS: ['annotation', 'semantics', 'mrow', 'mi', 'mo', 'mn', 'msup', 'msub', 'mfrac', 'mover', 'munder', 'munderover', 'msqrt', 'mroot', 'mtable', 'mtr', 'mtd', 'mtext', 'mspace', 'math', 'mpadded', 'menclose', 'mglyph', 'mphantom', 'mstyle'],
  ADD_ATTR: ['xmlns', 'mathvariant', 'encoding', 'stretchy', 'fence', 'separator', 'accent', 'accentunder', 'columnalign', 'rowalign', 'columnspacing', 'rowspacing', 'displaystyle', 'scriptlevel', 'lspace', 'rspace', 'movablelimits', 'largeop', 'symmetric', 'maxsize', 'minsize', 'linethickness', 'depth', 'height', 'voffset', 'notation'],
  FORBID_TAGS: ['script', 'iframe', 'object', 'embed'],
};

function getSanitizedLatexHtml(text: string): string | null {
  if (!text || !text.includes('$')) return null;
  if (sanitizedLatexCache.has(text)) {
    const cached = sanitizedLatexCache.get(text)!;
    sanitizedLatexCache.delete(text);
    sanitizedLatexCache.set(text, cached);
    return cached;
  }
  const raw = renderLatexToHtml(text);
  const sanitized = raw ? DOMPurify.sanitize(raw, DOMPURIFY_KATEX_CONFIG) : null;
  if (sanitizedLatexCache.size >= MAX_SANITIZED_LATEX_CACHE) {
    const oldestKey = sanitizedLatexCache.keys().next().value;
    if (oldestKey !== undefined) sanitizedLatexCache.delete(oldestKey);
  }
  sanitizedLatexCache.set(text, sanitized);
  return sanitized;
}

interface InlineLatexProps {
  text: string;
  className?: string;
  style?: React.CSSProperties;
  fallback?: React.ReactNode;
}

const InlineLatexComponent: React.FC<InlineLatexProps> = ({ text, className, style, fallback }) => {
  const containerRef = useRef<HTMLSpanElement>(null);

  const html = useMemo(() => getSanitizedLatexHtml(text), [text]);
  const hasError = Boolean(html && html.includes('katex-error'));

  useEffect(() => {
    if (!html || katexStylesRequested) return;
    katexStylesRequested = true;
    ensureKatexStyles();
  }, [html]);

  // 仅当公式实际包含语法错误时补挂悬停提示（视觉样式由 mm-nodes-edges.css 静态提供）
  useEffect(() => {
    if (!hasError || !containerRef.current) return;
    const errorTitle = i18next.t('mindmap:latex.renderError', {
      defaultValue: '公式语法错误，已按原文显示',
    });
    const errors = containerRef.current.querySelectorAll<HTMLElement>('.katex-error');
    errors.forEach((el) => {
      el.title = errorTitle;
    });
  }, [hasError, html]);

  if (!html) {
    if (fallback !== undefined) return <>{fallback}</>;
    return <span className={className} style={style}>{text}</span>;
  }

  // 统一用 span 承载（含公式时也不例外），避免 div 破坏节点内的 inline 流式布局；
  // KaTeX display 公式（.katex-display）自身是块级样式，span 容器不影响其换行表现
  return (
    <span
      ref={containerRef}
      className={className}
      style={style}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
};

export const InlineLatex = React.memo(InlineLatexComponent);
InlineLatex.displayName = 'InlineLatex';
