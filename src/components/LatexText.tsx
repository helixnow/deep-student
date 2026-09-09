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
    // 2026-09-09：纯文本换行在 HTML 里会被折叠（调用方容器通常没有 white-space: pre-wrap），
    // 统一转成 <br/> 保证题干/选项/解析里的换行可见。KaTeX 输出为单行 HTML，不会误伤公式。
    const withBreaks = raw.replace(/\r\n|\r|\n/g, '<br/>');
    return DOMPurify.sanitize(withBreaks, {
      ADD_TAGS: ['annotation', 'semantics', 'mrow', 'mi', 'mo', 'mn', 'msup', 'msub', 'mfrac', 'mover', 'munder', 'munderover', 'msqrt', 'mroot', 'mtable', 'mtr', 'mtd', 'mtext', 'mspace', 'math', 'mpadded', 'menclose', 'mglyph', 'mphantom', 'mstyle'],
      ADD_ATTR: ['xmlns', 'mathvariant', 'encoding', 'stretchy', 'fence', 'separator', 'accent', 'accentunder', 'columnalign', 'rowalign', 'columnspacing', 'rowspacing', 'columnlines', 'rowlines', 'frame', 'framespacing', 'equalrows', 'equalcolumns', 'displaystyle', 'side', 'minlabelspacing', 'scriptlevel', 'lspace', 'rspace', 'movablelimits', 'largeop', 'symmetric', 'maxsize', 'minsize', 'linethickness', 'depth', 'height', 'voffset', 'notation'],
      FORBID_TAGS: ['script', 'iframe', 'object', 'embed'],
    });
  }, [src]);

  if (!html) {
    // 纯文本路径：pre-line 保留换行、折叠多余空白，不依赖调用方容器样式
    return <span className={cn(className, 'whitespace-pre-line')}>{src}</span>;
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
