/**
 * 卡片列表（卡片库行、今日「接下来」）的公式预览。
 *
 * 列表摘要原先直接输出 front/back 纯文本，`$f'(\xi)$`、`\frac{\pi}{2}` 以 TeX 源码
 * 显示；复习视图则走 KaTeX。这里复用应用统一的 `renderLatexToHtml`（Pandoc 规则
 * 区分公式与货币，KaTeX trust:false，非公式文本已 HTML 转义），并补上 Anki 常见的
 * `\( \)` / `\[ \]` 定界符。
 *
 * - `inline`（列表单行摘要）：空白折叠为单空格、display 公式降为行内，配合
 *   `white-space: nowrap; text-overflow: ellipsis` 保持单行截断；
 * - 默认（展开详情）：保留换行与 display 公式。
 * 结果按 (模式, 文本) 缓存：分页列表反复重渲染时不重复跑 KaTeX。
 */
import React, { useEffect, useMemo } from 'react';
import { renderLatexToHtml } from '@/features/mindmap/utils/renderLatex';
import { ensureKatexStyles } from '@/utils/lazyStyles';

const CACHE_LIMIT = 400;
const htmlCache = new Map<string, string | null>();

function normalizeDelimiters(text: string, inline: boolean): string {
  const open = inline ? '$' : '$$';
  return text
    .replace(/\\\[([\s\S]+?)\\\]/g, (_match, body: string) => `${open}${body.trim()}${open}`)
    .replace(/\\\(([\s\S]+?)\\\)/g, (_match, body: string) => `$${body.trim()}$`);
}

function collapseDisplayMath(text: string): string {
  return text.replace(/\$\$([\s\S]+?)\$\$/g, (_match, body: string) => `$${body.trim()}$`);
}

/**
 * 把卡面文本渲染为含 KaTeX 的 HTML；不含公式时返回 null（调用方直接渲染纯文本）。
 */
export function renderCardPreviewMathHtml(text: string, options: { inline?: boolean } = {}): string | null {
  if (!text || (!text.includes('$') && !text.includes('\\(') && !text.includes('\\['))) return null;
  const inline = options.inline === true;
  const key = `${inline ? 'i' : 'b'}:${text}`;
  if (htmlCache.has(key)) return htmlCache.get(key) ?? null;

  let source = normalizeDelimiters(text, inline);
  if (inline) source = collapseDisplayMath(source.replace(/\s+/g, ' ').trim());
  const html = renderLatexToHtml(source);

  if (htmlCache.size >= CACHE_LIMIT) {
    const oldest = htmlCache.keys().next().value;
    if (oldest !== undefined) htmlCache.delete(oldest);
  }
  htmlCache.set(key, html);
  return html;
}

interface CardMathTextProps {
  text: string;
  /** 列表单行摘要：折叠空白 + display 公式降为行内 */
  inline?: boolean;
  className?: string;
}

/** 卡面文本（含 `$…$` / `\(…\)` 公式）→ KaTeX；无公式时为零成本纯文本 */
export const CardMathText: React.FC<CardMathTextProps> = ({ text, inline = false, className }) => {
  const html = useMemo(() => renderCardPreviewMathHtml(text, { inline }), [text, inline]);

  useEffect(() => {
    if (html) ensureKatexStyles();
  }, [html]);

  if (!html) return className ? <span className={className}>{text}</span> : <>{text}</>;
  return (
    <span
      className={className}
      data-card-math=""
      // 安全：非公式文本已 HTML 转义，公式为 KaTeX（trust:false）输出
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
};
