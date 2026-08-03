/**
 * InlineLatex - 内联 LaTeX 渲染组件
 * 自动检测文本中的 $...$ / $$...$$ 并渲染为数学公式，
 * 无 LaTeX 时回退为纯文本显示。
 */
import React, { useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import DOMPurify from 'dompurify';
import { ensureKatexStyles } from '@/utils/lazyStyles';
import { renderLatexToHtml } from '../../utils/renderLatex';

interface InlineLatexProps {
  text: string;
  className?: string;
  style?: React.CSSProperties;
  fallback?: React.ReactNode;
}

export const InlineLatex: React.FC<InlineLatexProps> = ({ text, className, style, fallback }) => {
  const { t } = useTranslation('mindmap');
  const containerRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    ensureKatexStyles();
  }, []);

  const html = useMemo(() => {
    const raw = renderLatexToHtml(text);
    if (!raw) return null;
    return DOMPurify.sanitize(raw, {
      ADD_TAGS: ['annotation', 'semantics', 'mrow', 'mi', 'mo', 'mn', 'msup', 'msub', 'mfrac', 'mover', 'munder', 'munderover', 'msqrt', 'mroot', 'mtable', 'mtr', 'mtd', 'mtext', 'mspace', 'math', 'mpadded', 'menclose', 'mglyph', 'mphantom', 'mstyle'],
      ADD_ATTR: ['xmlns', 'mathvariant', 'encoding', 'stretchy', 'fence', 'separator', 'accent', 'accentunder', 'columnalign', 'rowalign', 'columnspacing', 'rowspacing', 'displaystyle', 'scriptlevel', 'lspace', 'rspace', 'movablelimits', 'largeop', 'symmetric', 'maxsize', 'minsize', 'linethickness', 'depth', 'height', 'voffset', 'notation'],
      FORBID_TAGS: ['script', 'iframe', 'object', 'embed'],
    });
  }, [text]);

  // 错误态展示：渲染失败的公式（.katex-error）标出警示色并附悬浮提示，
  // 让用户能一眼看出公式语法错误，而非当作普通文本忽略
  useEffect(() => {
    if (!html || !containerRef.current) return;
    const errors = containerRef.current.querySelectorAll<HTMLElement>('.katex-error');
    errors.forEach((el) => {
      el.style.color = 'var(--mm-warning, #b45309)';
      el.style.borderBottom = '1px dashed currentColor';
      el.style.cursor = 'help';
      el.title = t('latex.renderError', { defaultValue: '公式语法错误，已按原文显示' });
    });
  }, [html, t]);

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
