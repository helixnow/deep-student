/**
 * InlineLatex - 内联 LaTeX 渲染组件
 * 自动检测文本中的 $...$ / $$...$$ 并渲染为数学公式，
 * 无 LaTeX 时回退为纯文本显示。
 */
import React, { useEffect, useMemo } from 'react';
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

  if (!html) {
    if (fallback !== undefined) return <>{fallback}</>;
    return <span className={className} style={style}>{text}</span>;
  }

  return (
    <div
      className={className}
      style={style}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
};
