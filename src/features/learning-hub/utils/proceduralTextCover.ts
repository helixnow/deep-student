/**
 * Markdown 笔记程序化文字封面生成器（480×270，16:9）。
 *
 * 核心能力：
 * 1. tokenizeCjkAndLatin(text)：CJK 与全角标点逐字切词 + 拉丁单词保空格切词，解决 Canvas measureText 排中文不换行被裁右半边的痛点；
 * 2. computeTitleCoverPalette(title)：FNV-1a 标题哈希 + 黄金角（137.507764°）色相派发，固定低明度深色底 + 白字；
 * 3. layoutTextCoverLines(title, previewText, measureWidthFn)：贪心折行、末行省略号收敛与垂直居中排版计算；
 * 4. Canvas / SVG 双后端输出：无 DOM Canvas 时可直出等价 480×270 16:9 SVG Data URL，100% 离线零失败。
 */

export const COVER_WIDTH = 480;
export const COVER_HEIGHT = 270;
export const COVER_PADDING = 26;
export const COVER_INNER_WIDTH = COVER_WIDTH - COVER_PADDING * 2;

export const GOLDEN_ANGLE_DEG = 137.507764;

export const COVER_FONT_STACK = `'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Noto Sans SC', system-ui, sans-serif`;
export const COVER_TITLE_FONT = `600 32px ${COVER_FONT_STACK}`;
export const COVER_PREVIEW_FONT = `400 15px ${COVER_FONT_STACK}`;

export const TITLE_FONT_SIZE = 32;
export const PREVIEW_FONT_SIZE = 15;
export const TITLE_LINE_HEIGHT = 41;
export const PREVIEW_LINE_HEIGHT = 24;
export const TITLE_MAX_LINES = 2;
export const PREVIEW_MAX_LINES = 3;
export const DIVIDER_GAP = 15;
export const DIVIDER_HEIGHT = 2;
export const DIVIDER_WIDTH = 36;

/** CJK 与全角标点：这些字符之间可以任意断行 */
const WIDE_CHAR_RE = /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/;

export type MeasureTextWidthFn = (text: string, kind?: 'title' | 'preview') => number;

export interface TitleCoverPalette {
  hue: number;
  secondaryHue: number;
  accentHue: number;
  lightnessStart: number;
  lightnessEnd: number;
  gradientStart: string;
  gradientEnd: string;
  haloColor: string;
  accentOrbColor: string;
  titleColor: string;
  dividerColor: string;
  previewColor: string;
}

export interface TextCoverLayout {
  width: number;
  height: number;
  padding: number;
  innerWidth: number;
  titleLines: string[];
  previewLines: string[];
  hasDivider: boolean;
  blockHeight: number;
  startY: number;
  dividerY: number | null;
  previewStartY: number;
}

/**
 * 切词器：CJK 与全角标点逐字成词，拉丁文/数字连成不可拆的单词，连续空白压为单个空格 token。
 */
export function tokenizeCjkAndLatin(text: string): string[] {
  const out: string[] = [];
  let word = '';
  let space = false;
  for (const ch of text) {
    if (/\s/.test(ch)) {
      if (word) {
        out.push(word);
        word = '';
      }
      space = true;
      continue;
    }
    if (space) {
      out.push(' ');
      space = false;
    }
    if (WIDE_CHAR_RE.test(ch)) {
      if (word) {
        out.push(word);
        word = '';
      }
      out.push(ch);
    } else {
      word += ch;
    }
  }
  if (word) out.push(word);
  return out;
}

/** FNV-1a 32 位哈希：同一标题永远对应同一哈希值 */
export function fnv1aHash32(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * 标题 → 色相（0 ~ 360），按黄金角（137.507764°）步进打散相邻哈希。
 */
export function hueOfTitle(title: string): number {
  const seed = title || 'md';
  return Math.round(((fnv1aHash32(seed) * GOLDEN_ANGLE_DEG) % 360) * 100) / 100;
}

/**
 * 计算标题对应的深色封面调色板（固定低明度深底 L=30%/22% + 纯白标题，确保高对比度）。
 */
export function computeTitleCoverPalette(title: string): TitleCoverPalette {
  const hue = hueOfTitle(title || 'md');
  const secondaryHue = Math.round(((hue + 22) % 360) * 100) / 100;
  const accentHue = Math.round(((hue + 40) % 360) * 100) / 100;
  const lightnessStart = 30;
  const lightnessEnd = 22;

  return {
    hue,
    secondaryHue,
    accentHue,
    lightnessStart,
    lightnessEnd,
    gradientStart: `hsl(${hue} 42% ${lightnessStart}%)`,
    gradientEnd: `hsl(${secondaryHue} 38% ${lightnessEnd}%)`,
    haloColor: 'rgb(255 255 255 / 0.10)',
    accentOrbColor: `hsl(${accentHue} 55% 62% / 0.10)`,
    titleColor: '#ffffff',
    dividerColor: 'rgb(255 255 255 / 0.45)',
    previewColor: 'rgb(255 255 255 / 0.74)',
  };
}

/**
 * 默认离线字符宽度估算器（无 DOM Canvas 时的纯算法回退）。
 */
export function defaultMeasureTextWidth(
  text: string,
  kind: 'title' | 'preview' = 'title',
): number {
  const fontSize = kind === 'title' ? TITLE_FONT_SIZE : PREVIEW_FONT_SIZE;
  let width = 0;
  for (const ch of text) {
    if (WIDE_CHAR_RE.test(ch)) {
      width += fontSize;
    } else if (/\s/.test(ch)) {
      width += fontSize * 0.32;
    } else {
      width += fontSize * 0.56;
    }
  }
  return width;
}

/**
 * 贪心折行：按 token 累加宽度，超出 maxLines 时在末行追加省略号「…」，并移除折行行首残留空格。
 */
export function wrapCoverTokens(
  text: string,
  maxWidth: number,
  maxLines: number,
  measureWidth: (s: string) => number,
): string[] {
  const tokens = tokenizeCjkAndLatin(text);
  const lines: string[] = [];
  let line = '';

  for (let i = 0; i < tokens.length; i++) {
    const next = line + tokens[i];
    if (line && measureWidth(next) > maxWidth) {
      lines.push(line);
      line = tokens[i];
      if (lines.length === maxLines) {
        if (i < tokens.length - 1 || tokens[i].trim().length > 0) {
          let last = lines[maxLines - 1];
          while (last && measureWidth(`${last}…`) > maxWidth) {
            last = tokenizeCjkAndLatin(last).slice(0, -1).join('');
          }
          lines[maxLines - 1] = `${last}…`;
        }
        return lines.map((l) => l.trimStart());
      }
    } else {
      line = next;
    }
  }
  if (line) {
    lines.push(line);
  }
  return lines.map((l) => l.trimStart());
}

/**
 * 排版布局计算器：计算标题与预览折行、分割线及垂直居中坐标。
 */
export function layoutTextCoverLines(
  title: string,
  previewText: string,
  measureWidthFn: MeasureTextWidthFn = defaultMeasureTextWidth,
  maxWidth: number = COVER_INNER_WIDTH,
): TextCoverLayout {
  const trimmedTitle = title.trim();
  const trimmedPreview = previewText.trim();

  const titleLines = trimmedTitle
    ? wrapCoverTokens(
        trimmedTitle,
        maxWidth,
        TITLE_MAX_LINES,
        (s) => measureWidthFn(s, 'title'),
      )
    : [];

  const previewLines = trimmedPreview
    ? wrapCoverTokens(
        trimmedPreview,
        maxWidth,
        PREVIEW_MAX_LINES,
        (s) => measureWidthFn(s, 'preview'),
      )
    : [];

  const hasDivider = titleLines.length > 0 && previewLines.length > 0;
  const blockHeight =
    titleLines.length * TITLE_LINE_HEIGHT +
    (hasDivider ? DIVIDER_GAP + DIVIDER_HEIGHT + DIVIDER_GAP : 0) +
    previewLines.length * PREVIEW_LINE_HEIGHT;

  const startY = Math.max(COVER_PADDING, (COVER_HEIGHT - blockHeight) / 2);
  const afterTitleY = startY + titleLines.length * TITLE_LINE_HEIGHT;
  const dividerY = hasDivider ? afterTitleY + DIVIDER_GAP : null;
  const previewStartY = hasDivider
    ? afterTitleY + DIVIDER_GAP + DIVIDER_HEIGHT + DIVIDER_GAP
    : afterTitleY;

  return {
    width: COVER_WIDTH,
    height: COVER_HEIGHT,
    padding: COVER_PADDING,
    innerWidth: maxWidth,
    titleLines,
    previewLines,
    hasDivider,
    blockHeight,
    startY,
    dividerY,
    previewStartY,
  };
}

/**
 * 在 Canvas 2D 上下文中绘制 480×270 封面。
 */
export function drawTextCover(
  ctx: CanvasRenderingContext2D,
  input: { title: string; preview: string },
): TextCoverLayout {
  const palette = computeTitleCoverPalette(input.title || 'md');

  const gradient = ctx.createLinearGradient(0, 0, COVER_WIDTH, COVER_HEIGHT);
  gradient.addColorStop(0, palette.gradientStart);
  gradient.addColorStop(1, palette.gradientEnd);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, COVER_WIDTH, COVER_HEIGHT);

  const halo = ctx.createRadialGradient(
    COVER_PADDING,
    0,
    0,
    COVER_PADDING,
    0,
    200,
  );
  halo.addColorStop(0, palette.haloColor);
  halo.addColorStop(1, 'rgb(255 255 255 / 0)');
  ctx.fillStyle = halo;
  ctx.fillRect(0, 0, COVER_WIDTH, COVER_HEIGHT);

  ctx.beginPath();
  ctx.arc(COVER_WIDTH - 30, COVER_HEIGHT - 24, 108, 0, Math.PI * 2);
  ctx.fillStyle = palette.accentOrbColor;
  ctx.fill();

  const layout = layoutTextCoverLines(
    input.title,
    input.preview,
    (text, kind) => {
      ctx.font = kind === 'preview' ? COVER_PREVIEW_FONT : COVER_TITLE_FONT;
      return ctx.measureText(text).width;
    },
    COVER_INNER_WIDTH,
  );

  let y = layout.startY;
  ctx.textBaseline = 'top';

  if (layout.titleLines.length > 0) {
    ctx.font = COVER_TITLE_FONT;
    ctx.fillStyle = palette.titleColor;
    for (const line of layout.titleLines) {
      ctx.fillText(line, COVER_PADDING, y);
      y += TITLE_LINE_HEIGHT;
    }
  }

  if (layout.hasDivider) {
    y += DIVIDER_GAP;
    ctx.fillStyle = palette.dividerColor;
    ctx.fillRect(COVER_PADDING, y, DIVIDER_WIDTH, DIVIDER_HEIGHT);
    y += DIVIDER_HEIGHT + DIVIDER_GAP;
  }

  if (layout.previewLines.length > 0) {
    ctx.font = COVER_PREVIEW_FONT;
    ctx.fillStyle = palette.previewColor;
    for (const line of layout.previewLines) {
      ctx.fillText(line, COVER_PADDING, y);
      y += PREVIEW_LINE_HEIGHT;
    }
  }

  return layout;
}

function escapeXml(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * 生成等价的 480×270 16:9 SVG 标记文本（无 DOM Canvas 时的零依赖离线后端）。
 */
export function renderTextCoverSvg(
  input: { title: string; preview: string },
  measureWidthFn: MeasureTextWidthFn = defaultMeasureTextWidth,
): string {
  const palette = computeTitleCoverPalette(input.title || 'md');
  const layout = layoutTextCoverLines(
    input.title,
    input.preview,
    measureWidthFn,
    COVER_INNER_WIDTH,
  );

  const titleNodes = layout.titleLines
    .map((line, index) => {
      const y = layout.startY + index * TITLE_LINE_HEIGHT + TITLE_FONT_SIZE;
      return `<text x="${COVER_PADDING}" y="${y}" fill="${palette.titleColor}" font-family="${escapeXml(COVER_FONT_STACK)}" font-size="${TITLE_FONT_SIZE}" font-weight="600">${escapeXml(line)}</text>`;
    })
    .join('');

  const dividerNode =
    layout.hasDivider && layout.dividerY !== null
      ? `<rect x="${COVER_PADDING}" y="${layout.dividerY}" width="${DIVIDER_WIDTH}" height="${DIVIDER_HEIGHT}" fill="rgb(255,255,255)" fill-opacity="0.45" />`
      : '';

  const previewNodes = layout.previewLines
    .map((line, index) => {
      const y =
        layout.previewStartY + index * PREVIEW_LINE_HEIGHT + PREVIEW_FONT_SIZE;
      return `<text x="${COVER_PADDING}" y="${y}" fill="rgb(255,255,255)" fill-opacity="0.74" font-family="${escapeXml(COVER_FONT_STACK)}" font-size="${PREVIEW_FONT_SIZE}" font-weight="400">${escapeXml(line)}</text>`;
    })
    .join('');

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${COVER_WIDTH} ${COVER_HEIGHT}" width="${COVER_WIDTH}" height="${COVER_HEIGHT}">`,
    '<defs>',
    '<linearGradient id="cover-bg" x1="0" y1="0" x2="1" y2="1">',
    `<stop offset="0%" stop-color="${palette.gradientStart}" />`,
    `<stop offset="100%" stop-color="${palette.gradientEnd}" />`,
    '</linearGradient>',
    `<radialGradient id="cover-halo" cx="${COVER_PADDING}" cy="0" r="200" gradientUnits="userSpaceOnUse">`,
    '<stop offset="0%" stop-color="rgb(255,255,255)" stop-opacity="0.10" />',
    '<stop offset="100%" stop-color="rgb(255,255,255)" stop-opacity="0" />',
    '</radialGradient>',
    '</defs>',
    `<rect width="${COVER_WIDTH}" height="${COVER_HEIGHT}" fill="url(#cover-bg)" />`,
    `<rect width="${COVER_WIDTH}" height="${COVER_HEIGHT}" fill="url(#cover-halo)" />`,
    `<circle cx="${COVER_WIDTH - 30}" cy="${COVER_HEIGHT - 24}" r="108" fill="hsl(${palette.accentHue} 55% 62%)" fill-opacity="0.10" />`,
    titleNodes,
    dividerNode,
    previewNodes,
    '</svg>',
  ].join('');
}

/**
 * 双后端输出：优先使用传入的 Canvas 2D 上下文导出 Data URL，无 Canvas 时自动回退为 480×270 SVG Data URL。
 */
export function renderProceduralTextCoverDataUrl(
  input: { title: string; preview: string },
  options?: {
    canvas?: {
      width: number;
      height: number;
      getContext: (contextId: '2d') => CanvasRenderingContext2D | null;
      toDataURL?: (type?: string, quality?: number) => string;
    } | null;
    measureWidthFn?: MeasureTextWidthFn;
  },
): string {
  const canvas = options?.canvas;
  if (canvas) {
    const ctx = canvas.getContext('2d');
    if (ctx && typeof canvas.toDataURL === 'function') {
      canvas.width = COVER_WIDTH;
      canvas.height = COVER_HEIGHT;
      drawTextCover(ctx, input);
      return canvas.toDataURL('image/webp', 0.86);
    }
  }
  const svg = renderTextCoverSvg(input, options?.measureWidthFn);
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
