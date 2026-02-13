/**
 * InlineLatex - 内联 LaTeX 渲染组件
 * 自动检测文本中的 $...$ / $$...$$ 并渲染为数学公式，
 * 无 LaTeX 时回退为纯文本显示。
 */
import React, { useEffect, useMemo } from 'react';
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

  const html = useMemo(() => renderLatexToHtml(text), [text]);

  if (!html) {
    // 无 LaTeX，返回 fallback 或纯文本
    if (fallback !== undefined) return <>{fallback}</>;
    return <span className={className} style={style}>{text}</span>;
  }

  // 使用 <div> 而非 <span>，因为 KaTeX display mode ($$...$$) 会生成 <div> 子元素，
  // HTML 规范不允许 <div> 嵌套在 <span> 内
  return (
    <div
      className={className}
      style={style}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
};
