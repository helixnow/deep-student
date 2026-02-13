/**
 * ★ LatexText 组件 - 支持 LaTeX 公式渲染
 * 自动检测文本中的 $...$ / $$...$$ 并用 KaTeX 渲染为数学公式
 */

import React, { useEffect, useMemo } from 'react';
import { ensureKatexStyles } from '@/utils/lazyStyles';
import { containsLatex, renderLatexToHtml } from '@/components/mindmap/utils/renderLatex';

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

  const html = useMemo(() => renderLatexToHtml(src), [src]);

  if (!html) {
    return <span className={className}>{src}</span>;
  }

  // 使用 <div> 因为 KaTeX display mode 会生成 <div> 子元素
  return <div className={className} dangerouslySetInnerHTML={{ __html: html }} />;
};

export default LatexText;
