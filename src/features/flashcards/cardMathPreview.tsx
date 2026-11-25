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

const SAFE_ANKI_HTML_RE = /<\/?(?:b|strong|i|em|u|s|del|sub|sup|br|p|div|span|font|center|ul|ol|li|hr|h[1-6]|blockquote|img|audio|video)\b[^>]*>|\[sound:[^\]]+\]|&(?:nbsp|amp|lt|gt|quot|#39);/i;
const IMG_TAG_RE = /<img\b([^>]*?)\/?>/gi;
const AUDIO_TAG_RE = /<audio\b[^>]*>[\s\S]*?<\/audio>|<audio\b[^>]*\/?>/gi;
const VIDEO_TAG_RE = /<video\b[^>]*>[\s\S]*?<\/video>|<video\b[^>]*\/?>/gi;
const SOUND_TOKEN_RE = /\[sound:([^\]]+)\]/gi;
const SAFE_INLINE_TAG_RE = /<(\/?)(b|strong|i|em|u|s|del|sub|sup|br)\b[^>]*>/gi;
const STRIP_WRAPPER_TAG_RE = /<\/?(?:span|font|center)\b[^>]*>/gi;
const BLOCK_BREAK_TAG_RE = /<\/?(?:p|div|ul|ol|li|hr|h[1-6]|blockquote)\b[^>]*>/gi;
const MEDIA_FILENAME_EXT_RE = /\.(?:png|jpe?g|gif|webp|svg|bmp|avif|mp3|ogg|oga|opus|wav|m4a|aac|flac|webm|mp4)(?:$|[?#])/i;
const AUDIO_FILENAME_EXT_RE = /\.(?:mp3|ogg|oga|opus|wav|m4a|aac|flac|webm)(?:$|[?#])/i;

function isLikelyMediaFilename(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length > 0 && !/\s/.test(trimmed) && MEDIA_FILENAME_EXT_RE.test(trimmed);
}

function decodeBasicHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

function formatImgPlaceholder(attrs: string): string {
  const alt = /\balt\s*=\s*(?:"([^"]+)"|'([^']+)')/i.exec(attrs);
  const altText = (alt?.[1] ?? alt?.[2] ?? '').trim();
  // 只展示有意义的 alt 说明，绝不把裸文件名（如 qa_img_63.png）泄露进列表
  if (altText && !isLikelyMediaFilename(altText)) {
    return `[图片: ${altText}]`;
  }
  return '[图片]';
}

function escapePlainHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export interface CardMediaSummary {
  imageCount: number;
  audioCount: number;
}

function mediaSummaryKey(raw: string): string {
  const cleaned = raw.trim().replace(/^anki-media:\/\/\/?/i, '').split(/[?#]/)[0] ?? raw;
  const parts = cleaned.split(/[\\/]/);
  const base = parts[parts.length - 1] ?? cleaned;
  try {
    return decodeURIComponent(base).toLowerCase();
  } catch {
    return base.toLowerCase();
  }
}

/** 统计单张卡片的嵌入式图片与音频数量（汇总 card.images 与字段里的 <img>/[sound:]/<audio>）。 */
export function summarizeCardMedia(card: {
  front?: string | null;
  back?: string | null;
  text?: string | null;
  images?: readonly string[] | null;
  fields?: Record<string, string> | null;
  extra_fields?: Record<string, string> | null;
  extraFields?: Record<string, string> | null;
}): CardMediaSummary {
  const images = new Set<string>();
  const audios = new Set<string>();
  let anonymousImage = 0;
  let anonymousAudio = 0;

  for (const item of card.images ?? []) {
    const trimmed = item?.trim();
    if (!trimmed) continue;
    const key = mediaSummaryKey(trimmed);
    if (!key) continue;
    if (AUDIO_FILENAME_EXT_RE.test(trimmed)) {
      audios.add(key);
    } else if (!/\.mp4(?:$|[?#])/i.test(trimmed)) {
      images.add(key);
    }
  }

  const texts = [
    card.front ?? '',
    card.back ?? '',
    card.text ?? '',
    ...Object.values(card.fields ?? {}),
    ...Object.values(card.extra_fields ?? {}),
    ...Object.values(card.extraFields ?? {}),
  ];
  for (const text of texts) {
    if (!text) continue;
    for (const match of text.matchAll(IMG_TAG_RE)) {
      const attrs = match[1] ?? '';
      const srcMatch = /\bsrc\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s"'=<>`]+))/i.exec(attrs);
      const src = (srcMatch?.[1] ?? srcMatch?.[2] ?? srcMatch?.[3] ?? '').trim();
      if (src) images.add(mediaSummaryKey(src));
      else anonymousImage += 1;
    }
    for (const match of text.matchAll(SOUND_TOKEN_RE)) {
      const name = (match[1] ?? '').trim();
      if (name) audios.add(mediaSummaryKey(name));
      else anonymousAudio += 1;
    }
    for (const match of text.matchAll(AUDIO_TAG_RE)) {
      const srcMatch = /\bsrc\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s"'=<>`]+))/i.exec(match[0]);
      const src = (srcMatch?.[1] ?? srcMatch?.[2] ?? srcMatch?.[3] ?? '').trim();
      if (src) audios.add(mediaSummaryKey(src));
      else anonymousAudio += 1;
    }
  }

  return {
    imageCount: images.size + anonymousImage,
    audioCount: audios.size + anonymousAudio,
  };
}

/**
 * 清理 Anki 导入卡里的安全排版标签与媒体标记（`<img>` / `[sound:...]` / `<audio>`），
 * 避免在卡片库预览里露出裸 HTML 源码或裸文件名。
 * - `inline`（列表单行摘要）：正文中剔除媒体标记（由行内媒体徽标呈现）；若整段纯媒体则回退 `[图片]` / `[音频]`；
 * - 默认（块级预览）：仅还原白名单无属性排版标签（b/strong/i/em/u/s/del/sub/sup/br），媒体用干净占位 `[图片]` / `[音频]`，其余不安全标签仍按纯文本转义。
 */
export function renderAnkiCardPreviewHtml(text: string | null | undefined, options: { inline?: boolean } = {}): string | null {
  if (!text) return null;
  const hasMath = text.includes('$') || text.includes('\\(') || text.includes('\\[');
  const hasSafeHtml = SAFE_ANKI_HTML_RE.test(text);
  if (!hasMath && !hasSafeHtml) return null;

  const inline = options.inline === true;
  const key = `rich:${inline ? 'i' : 'b'}:${text}`;
  if (htmlCache.has(key)) return htmlCache.get(key) ?? null;

  const tokens: string[] = [];
  const placeholder = (htmlTag: string) => {
    const idx = tokens.length;
    tokens.push(htmlTag);
    return `\uE000ANKI_${idx}\uE001`;
  };

  let sawImg = false;
  let sawAudio = false;
  let prepared: string;
  if (inline) {
    prepared = text
      .replace(IMG_TAG_RE, () => {
        sawImg = true;
        return ' ';
      })
      .replace(AUDIO_TAG_RE, () => {
        sawAudio = true;
        return ' ';
      })
      .replace(VIDEO_TAG_RE, ' ')
      .replace(SOUND_TOKEN_RE, () => {
        sawAudio = true;
        return ' ';
      })
      .replace(STRIP_WRAPPER_TAG_RE, ' ')
      .replace(BLOCK_BREAK_TAG_RE, ' ')
      .replace(SAFE_INLINE_TAG_RE, ' ');
    prepared = decodeBasicHtmlEntities(prepared);
    if (!prepared.replace(/\s+/g, '').trim()) {
      if (sawImg && sawAudio) prepared = '[图片 · 音频]';
      else if (sawImg) prepared = '[图片]';
      else if (sawAudio) prepared = '[音频]';
    }
  } else {
    prepared = text
      .replace(IMG_TAG_RE, (_m, attrs: string) => formatImgPlaceholder(attrs))
      .replace(AUDIO_TAG_RE, '[音频]')
      .replace(VIDEO_TAG_RE, '[视频]')
      .replace(SOUND_TOKEN_RE, '[音频]')
      .replace(STRIP_WRAPPER_TAG_RE, '')
      .replace(BLOCK_BREAK_TAG_RE, '\n')
      .replace(SAFE_INLINE_TAG_RE, (_m, slash: string, tag: string) => {
        const lower = tag.toLowerCase();
        if (lower === 'br') return placeholder('<br />');
        return placeholder(`<${slash}${lower}>`);
      });
    prepared = decodeBasicHtmlEntities(prepared);
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
