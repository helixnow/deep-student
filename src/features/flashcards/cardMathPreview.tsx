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

const SAFE_ANKI_HTML_RE = /<\/?(?:b|strong|i|em|u|s|del|sub|sup|br|p|div|img)\b[^>]*>/i;
const IMG_TAG_RE = /<img\b([^>]*?)\/?>/gi;
const SAFE_INLINE_TAG_RE = /<(\/?)(b|strong|i|em|u|s|del|sub|sup|br)\b[^>]*>/gi;
const BLOCK_BREAK_TAG_RE = /<\/(?:p|div)\s*>|<div\b[^>]*>|<p\b[^>]*>/gi;

function formatImgPlaceholder(attrs: string): string {
  const alt = /\balt\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1]?.trim();
  const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1]?.trim();
  const label = alt || (src ? src.split(/[\\/]/).pop() : '') || '';
  return label ? `[图片: ${label}]` : '[图片]';
}

function escapePlainHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * 清理 Anki 导入卡里的安全排版标签与未解析 `<img>` 引用，避免在卡片库预览里露出裸源码。
 * 仅还原白名单无属性排版标签（b/strong/i/em/u/s/del/sub/sup/br），其余 HTML 仍按纯文本转义。
 */
export function renderAnkiCardPreviewHtml(text: string | null | undefined, options: { inline?: boolean } = {}): string | null {
  if (!text) return null;
  const hasMath = text.includes('$') || text.includes('\\(') || text.includes('\\[');
  const hasSafeHtml = SAFE_ANKI_HTML_RE.test(text);
  if (!hasMath && !hasSafeHtml) return null;

  const inline = options.inline === true;
  const key = `rich:${inline ? 'i' : 'b'}:${text}`;
  if (htmlCache.has(key)) return htmlCache.get(key) ?? null;

  // 先把 <img> 转为可读占位，再把安全排版标签暂存为无冲突哨兵 token，最后走 KaTeX + HTML 转义管线
  const tokens: string[] = [];
  const placeholder = (htmlTag: string) => {
    const idx = tokens.length;
    tokens.push(htmlTag);
    return `\uE000ANKI_${idx}\uE001`;
  };

  let prepared = text.replace(IMG_TAG_RE, (_m, attrs: string) => formatImgPlaceholder(attrs));
  if (inline) {
    prepared = prepared
      .replace(BLOCK_BREAK_TAG_RE, ' ')
      .replace(SAFE_INLINE_TAG_RE, ' ');
  } else {
    prepared = prepared
      .replace(BLOCK_BREAK_TAG_RE, '\n')
      .replace(SAFE_INLINE_TAG_RE, (_m, slash: string, tag: string) => {
        const lower = tag.toLowerCase();
        if (lower === 'br') return placeholder('<br />');
        return placeholder(`<${slash}${lower}>`);
      });
  }

  let source = normalizeDelimiters(prepared, inline);
  if (inline) source = collapseDisplayMath(source.replace(/\s+/g, ' ').trim());
  const escaped = renderLatexToHtml(source) ?? escapePlainHtml(source);
  const restored = escaped.replace(/\uE000ANKI_(\d+)\uE001/g, (_m, rawIdx: string) => tokens[Number(rawIdx)] ?? '');

  if (htmlCache.size >= CACHE_LIMIT) {
    const oldest = htmlCache.keys().next().value;
    if (oldest !== undefined) htmlCache.delete(oldest);
  }
  htmlCache.set(key, restored);
  return restored;
}

interface CardMathTextProps {
  text: string;
  /** 列表单行摘要：折叠空白 + display 公式降为行内 */
  inline?: boolean;
  /** 允许渲染 Anki 导入卡的基础安全 HTML（b/i/u/br/img 占位），默认 false 保持纯文本契约 */
  allowBasicHtml?: boolean;
  className?: string;
}

/** 卡面文本（含 `$…$` / `\(…\)` 公式）→ KaTeX；无公式时为零成本纯文本 */
export const CardMathText: React.FC<CardMathTextProps> = ({
  text,
  inline = false,
  allowBasicHtml = false,
  className,
}) => {
  const html = useMemo(
    () => (allowBasicHtml ? renderAnkiCardPreviewHtml(text, { inline }) : renderCardPreviewMathHtml(text, { inline })),
    [text, inline, allowBasicHtml],
  );

  useEffect(() => {
    if (html) ensureKatexStyles();
  }, [html]);

  if (!html) return className ? <span className={className}>{text}</span> : <>{text}</>;
  return (
    <span
      className={className}
      data-card-math=""
      // 安全：非公式文本已 HTML 转义，仅白名单无属性排版标签与 KaTeX（trust:false）输出
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
};
