/**
 * ★ LatexText 组件 - 支持 LaTeX 公式渲染
 * 自动检测文本中的 $...$ / $$...$$ 并用 KaTeX 渲染为数学公式
 */

import React, { useEffect, useMemo } from 'react';
import DOMPurify from 'dompurify';
import { cn } from '@/lib/utils';
import { ensureKatexStyles } from '@/utils/lazyStyles';
import { containsLatex, renderLatexToHtml } from '@/features/mindmap/utils/renderLatex';

interface LatexTextProps {
  content: string;  // 使用 content 以兼容现有调用
  text?: string;    // 可选别名
  className?: string;
}

export const LatexText: React.FC<LatexTextProps> = ({ content, text, className }) => {
  const src = content || text || '';

  useEffect(() => {
    if (containsLatex(src)) {
      ensureKatexStyles();
    }
  }, [src]);

  const html = useMemo(() => {
    const raw = renderLatexToHtml(src);
    if (!raw) return null;
    return DOMPurify.sanitize(raw, {
      ADD_TAGS: ['annotation', 'semantics', 'mrow', 'mi', 'mo', 'mn', 'msup', 'msub', 'mfrac', 'mover', 'munder', 'munderover', 'msqrt', 'mroot', 'mtable', 'mtr', 'mtd', 'mtext', 'mspace', 'math', 'mpadded', 'menclose', 'mglyph', 'mphantom', 'mstyle'],
      ADD_ATTR: ['xmlns', 'mathvariant', 'encoding', 'stretchy', 'fence', 'separator', 'accent', 'accentunder', 'columnalign', 'rowalign', 'columnspacing', 'rowspacing', 'columnlines', 'rowlines', 'frame', 'framespacing', 'equalrows', 'equalcolumns', 'displaystyle', 'side', 'minlabelspacing', 'scriptlevel', 'lspace', 'rspace', 'movablelimits', 'largeop', 'symmetric', 'maxsize', 'minsize', 'linethickness', 'depth', 'height', 'voffset', 'notation'],
      FORBID_TAGS: ['script', 'iframe', 'object', 'embed'],
    });
  }, [src]);

  if (!html) {
    return <span className={className}>{src}</span>;
  }

  // 含 display 公式时提供横向滚动，避免长公式在窄屏撑破布局
  // （只在组件内解决，不依赖全局样式；overflow-x:auto 同时兼容滑动面板手势的让位判断）
  const hasDisplayMath = html.includes('katex-display');

  return (
    <div
      className={cn(className, hasDisplayMath && 'max-w-full overflow-x-auto')}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
};

export default LatexText;
