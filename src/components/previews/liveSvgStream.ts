/**
 * LiveSvg 流式增量绘制与白名单安全净化引擎
 *
 * 包含：
 * 1. 引号感知、注释/CDATA 感知的增量顶层图元扫描器 peekSvgProgress
 * 2. 孤立闭标签防负深度保护（防止 depth < 0 导致后续图元停画）
 * 3. 外包空 <svg xmlns="http://www.w3.org/2000/svg"> 的白名单净化与 LRU 缓存
 * 4. 新增图元落画动画分类（stroke-draw vs fade-in）与 DOM 打标器 markShapes
 */

import DOMPurify from 'dompurify';

export type SvgAnimationKind = 'stroke-draw' | 'fade-in' | 'none';

export interface SvgProgressItem {
  raw: string;
  svg: string;
  animation: SvgAnimationKind;
  order: number;
}

export interface SvgProgress {
  rootAttrs: string;
  elements: string[];
  animations: SvgAnimationKind[];
  items: SvgProgressItem[];
}

export interface SvgSanitizeCacheStats {
  size: number;
  maxSize: number;
  hits: number;
  misses: number;
}

const ALLOWED_TAGS = [
  // 结构
  'svg', 'g', 'defs', 'symbol', 'marker', 'pattern', 'clipPath', 'mask',
  // 图元
  'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon',
  // 文本
  'text', 'tspan', 'title', 'desc',
  // 渐变
  'linearGradient', 'radialGradient', 'stop',
];

const ALLOWED_ATTR = [
  // 画布与定位
  'xmlns', 'viewBox', 'preserveAspectRatio', 'width', 'height', 'x', 'y', 'transform',
  'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'dx', 'dy', 'rotate',
  'd', 'points', 'pathLength', 'textLength', 'lengthAdjust',
  // 渐变 / 图案 / 裁剪 / 标记
  'offset', 'gradientUnits', 'gradientTransform', 'spreadMethod',
  'patternUnits', 'patternContentUnits', 'clipPathUnits', 'maskUnits',
  'markerWidth', 'markerHeight', 'markerUnits', 'refX', 'refY', 'orient',
  'marker-start', 'marker-mid', 'marker-end', 'clip-path', 'clip-rule', 'mask',
  // 填充与描边
  'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-opacity',
  'stroke-linecap', 'stroke-linejoin', 'stroke-dasharray', 'stroke-dashoffset',
  'stroke-miterlimit', 'paint-order', 'vector-effect', 'stop-color', 'stop-opacity',
  // 文本排版
  'font-family', 'font-size', 'font-weight', 'font-style', 'font-variant',
  'letter-spacing', 'word-spacing', 'text-anchor', 'dominant-baseline',
  'alignment-baseline', 'baseline-shift', 'direction', 'writing-mode', 'unicode-bidi',
  // 可见性与渲染
  'opacity', 'color', 'display', 'visibility', 'overflow',
  'shape-rendering', 'text-rendering', 'image-rendering', 'mix-blend-mode', 'isolation',
  // 无脚本副作用的外壳属性
  'id', 'class', 'style', 'role', 'aria-label', 'aria-hidden', 'tabindex',
];

const DANGEROUS_RE =
  /<\s*(script|iframe|object|embed|form|foreignObject|image|use|a)\b|\son[a-z]+\s*=|\s[\w:-]+\s*=\s*["']?\s*(?:javascript:|data:text\/html)/i;

const URL_REF_RE = /url\(\s*['"]?\s*([^'")]*)/gi;

const PIECE_CACHE_MAX = 400;
const pieceCache = new Map<string, string>();
let cacheHits = 0;
let cacheMisses = 0;
let rootMemo = { raw: '', attrs: '' };

export function getSvgSanitizeCacheStats(): SvgSanitizeCacheStats {
  return {
    size: pieceCache.size,
    maxSize: PIECE_CACHE_MAX,
    hits: cacheHits,
    misses: cacheMisses,
  };
}

export function clearSvgSanitizeCache(): void {
  pieceCache.clear();
  cacheHits = 0;
  cacheMisses = 0;
  rootMemo = { raw: '', attrs: '' };
}

/**
 * 某些模型把整段 SVG 当成 HTML 文本转义；仅在根标签也被转义时解一层，再走完整净化。
 */
export function normalizeSvgSource(raw: string): string {
  if (/<svg[\s/>]/i.test(raw) || !/&lt;svg(?:\s|&gt;|\/)/i.test(raw)) return raw;
  return raw
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * 从已经净化的 SVG 读取模型给出的标题。
 */
export function svgTitleOf(svg: string): string | null {
  const root = new DOMParser().parseFromString(svg, 'image/svg+xml').documentElement;
  const title =
    Array.from(root.children).find((child) => child.localName === 'title')?.textContent ||
    root.getAttribute('aria-label');
  // eslint-disable-next-line no-control-regex -- intentionally strip ASCII control characters from SVG title
  const clean = title?.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return clean ? [...clean].slice(0, 40).join('') : null;
}

function purifySvgChunk(html: string): string {
  const sanitized = DOMPurify.sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    ALLOW_DATA_ATTR: false,
  });
  // 清理 style 属性中可能残留的 javascript: 或 data:text/html
  return sanitized.replace(/\sstyle="([^"]*)"/gi, (full, styleContent: string) => {
    const decoded = styleContent.replace(/\\[0-9a-fA-F]{1,6}\s?|\\./g, (escape) => {
      const hex = /^\\([0-9a-fA-F]{1,6})/.exec(escape);
      const code = hex ? parseInt(hex[1], 16) : 0;
      return hex ? String.fromCodePoint(code > 0 && code <= 0x10ffff ? code : 0xfffd) : escape.slice(1);
    }).replace(/\/\*[\s\S]*?\*\//g, '');
    if (/javascript:|data:\s*text\/html|expression\s*\(|url\s*\(|image-set\s*\(|image\s*\(|@import/i.test(decoded)) {
      return '';
    }
    return full;
  });
}

function assertSafe(clean: string): void {
  if (DANGEROUS_RE.test(clean)) {
    throw new Error('SVG 包含脚本或外部嵌入内容，已阻止渲染');
  }
  for (const m of clean.matchAll(URL_REF_RE)) {
    if (!m[1].trim().startsWith('#')) {
      throw new Error('SVG 引用了外部资源，已阻止渲染');
    }
  }
}

function sliceSvg(raw: string): string {
  const source = raw.trim();
  if (!source) throw new Error('SVG 源码为空');

  const start = source.search(/<svg[\s>]/i);
  if (start < 0) throw new Error('没有找到 <svg 标签：请用 ```svg 围栏包一段完整的 SVG');

  const end = source.toLowerCase().lastIndexOf('</svg>');
  if (end < 0) throw new Error('SVG 没有闭合（缺少 </svg>）');

  return source.slice(start, end + '</svg>'.length);
}

/**
 * 净化一段完整闭合的 SVG 源码。
 */
export function sanitizeSvg(raw: string): string {
  const sliced = sliceSvg(normalizeSvgSource(raw));
  const clean = purifySvgChunk(sliced);
  if (typeof clean !== 'string' || !/^<svg[\s>]/i.test(clean)) {
    throw new Error('净化后没有剩下可渲染的图形内容');
  }
  assertSafe(clean);
  return clean;
}

/**
 * 找标签的结束 '>'（引号感知，引号状态仅在标签内部生效）。
 */
export function findTagEnd(s: string, lt: number): number {
  let quote = '';
  for (let i = lt + 1; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === quote) quote = '';
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === '>') return i;
  }
  return -1;
}

/**
 * 扫出 body 里已经自身闭合的顶层子元素原文。
 * 包含注释/CDATA/声明跳过与孤立闭标签防负深度保护。
 */
export function closedTopLevel(body: string, from: number): string[] {
  const out: string[] = [];
  let i = from;
  let depth = 0;
  let start = -1;
  while (i < body.length) {
    const lt = body.indexOf('<', i);
    if (lt < 0) break;

    let skip = -1;
    if (body.startsWith('<!--', lt)) skip = body.indexOf('-->', lt + 4);
    else if (body.startsWith('<![CDATA[', lt)) skip = body.indexOf(']]>', lt + 9);
    else if (body[lt + 1] === '!' || body[lt + 1] === '?') skip = body.indexOf('>', lt + 2);
    if (skip >= 0) {
      i = skip + (body[skip] === '>' ? 1 : 3);
      continue;
    }
    if (body[lt + 1] === '!' || body[lt + 1] === '?') break;

    const gt = findTagEnd(body, lt);
    if (gt < 0) break;
    const tag = body.slice(lt, gt + 1);
    const closing = tag[1] === '/';
    const selfClosing = !closing && /\/\s*>$/.test(tag);

    if (closing) {
      // 孤立闭标签防负深度保护：防止 depth < 0 导致后续顶层图元被误判为嵌套而停画
      depth = Math.max(0, depth - 1);
      if (depth === 0 && start >= 0) {
        out.push(body.slice(start, gt + 1));
        start = -1;
      }
    } else {
      if (depth === 0 && start < 0) start = lt;
      if (selfClosing) {
        if (depth === 0) {
          out.push(body.slice(start, gt + 1));
          start = -1;
        }
      } else {
        depth++;
      }
    }
    i = gt + 1;
  }
  return out;
}

function sanitizeRoot(rawTag: string): string {
  if (rootMemo.raw === rawTag) return rootMemo.attrs;

  const clean = purifySvgChunk(rawTag);
  const gt = typeof clean === 'string' && clean.startsWith('<svg') ? clean.indexOf('>') : -1;
  if (gt < 0) throw new Error('根标签净化后不是可渲染的 <svg>');
  assertSafe(clean);

  const attrs = clean.slice(4, gt).trim();
  rootMemo = { raw: rawTag, attrs };
  return attrs;
}

/**
 * 单个 SVG 片段净化：外包一层 <svg xmlns="http://www.w3.org/2000/svg"> 进入 SVG 命名空间，
 * 保留 viewBox、gradientUnits、clipPathUnits 等驼峰属性，并通过 LRU 缓存避免每帧重复净化。
 */
export function sanitizeSvgFragment(piece: string): string {
  if (pieceCache.has(piece)) {
    const hit = pieceCache.get(piece)!;
    // 更新 LRU 顺序
    pieceCache.delete(piece);
    pieceCache.set(piece, hit);
    cacheHits++;
    return hit;
  }

  cacheMisses++;
  const clean = purifySvgChunk(`<svg xmlns="http://www.w3.org/2000/svg">${piece}</svg>`);
  const gt = typeof clean === 'string' && clean.startsWith('<svg') ? clean.indexOf('>') : -1;
  if (gt < 0) throw new Error('片段净化后不是可渲染的 SVG 片段');
  assertSafe(clean);

  const closeIdx = clean.lastIndexOf('</svg>');
  const inner = closeIdx >= gt + 1 ? clean.slice(gt + 1, closeIdx) : '';
  pieceCache.set(piece, inner);
  if (pieceCache.size > PIECE_CACHE_MAX) {
    const oldest = pieceCache.keys().next().value;
    if (oldest !== undefined) pieceCache.delete(oldest);
  }
  return inner;
}

// ============================================================================
// 落画动画分类与 DOM 标记
// ============================================================================

const STROKE_TAGS = new Set(['path', 'line', 'polyline', 'polygon', 'circle', 'ellipse', 'rect']);
const DEF_TAGS = new Set([
  'defs', 'symbol', 'marker', 'pattern', 'clipPath', 'mask', 'linearGradient', 'radialGradient', 'title', 'desc',
]);

function canTraceStroke(el: Element): boolean {
  const stroke = el.getAttribute('stroke');
  if (!stroke || stroke === 'none') return false;
  return !el.hasAttribute('stroke-dasharray') && !el.hasAttribute('pathLength');
}

function hasFill(tag: string, el: Element): boolean {
  if (tag === 'line' || tag === 'polyline') return false;
  const fill = el.getAttribute('fill');
  return fill === null || (fill !== 'none' && fill !== 'transparent');
}

function hasOwnOpacity(el: Element): boolean {
  return el.hasAttribute('opacity') || /opacity/.test(el.getAttribute('style') ?? '');
}

/**
 * 为单个已闭合 SVG 图元片段或 DOM 元素计算落画动画分类：
 * - 描边路径 / 线段：'stroke-draw'
 * - 填充图形 / 文本：'fade-in'
 * - 定义容器（defs / clipPath / linearGradient 等）：'none'
 */
export function classifySvgElementAnimation(elementOrFragment: string | Element): SvgAnimationKind {
  if (typeof elementOrFragment !== 'string') {
    return classifyDomElement(elementOrFragment);
  }
  const trimmed = elementOrFragment.trim();
  if (!trimmed) return 'none';
  if (typeof DOMParser !== 'undefined') {
    const doc = new DOMParser().parseFromString(
      `<svg xmlns="http://www.w3.org/2000/svg">${trimmed}</svg>`,
      'image/svg+xml',
    );
    const first = doc.documentElement?.firstElementChild;
    if (first && first.tagName.toLowerCase() !== 'parsererror') {
      return classifyDomElement(first);
    }
  }
  return classifyByRegex(trimmed);
}

function classifyDomElement(el: Element): SvgAnimationKind {
  const tag = el.localName || el.tagName;
  if (DEF_TAGS.has(tag)) return 'none';
  if (tag === 'text' || tag === 'tspan') {
    return hasOwnOpacity(el) ? 'none' : 'fade-in';
  }
  if (STROKE_TAGS.has(tag)) {
    if (canTraceStroke(el)) return 'stroke-draw';
    if ((tag === 'path' || tag === 'line' || tag === 'polyline') && !el.hasAttribute('stroke-dasharray') && !el.hasAttribute('pathLength')) {
      const fill = el.getAttribute('fill');
      if (!fill || fill === 'none' || fill === 'transparent') return 'stroke-draw';
    }
    if (hasFill(tag, el)) return 'fade-in';
    return 'stroke-draw';
  }
  if (tag === 'g' || tag === 'svg') {
    let sawFade = false;
    for (const child of Array.from(el.children)) {
      const c = classifyDomElement(child);
      if (c === 'stroke-draw') return 'stroke-draw';
      if (c === 'fade-in') sawFade = true;
    }
    return sawFade ? 'fade-in' : 'none';
  }
  return 'fade-in';
}

function classifyByRegex(fragment: string): SvgAnimationKind {
  const m = /^<\s*([A-Za-z]+)/.exec(fragment);
  const tag = m ? m[1] : '';
  if (!tag || DEF_TAGS.has(tag)) return 'none';
  if (tag === 'text' || tag === 'tspan') return 'fade-in';
  if (tag === 'path' || tag === 'line' || tag === 'polyline') {
    if (/\b(?:stroke-dasharray|pathLength)\s*=/.test(fragment)) return 'fade-in';
    return 'stroke-draw';
  }
  if (STROKE_TAGS.has(tag)) {
    if (/\bstroke\s*=\s*["'](?!none\b)[^"']+["']/.test(fragment) && !/\b(?:stroke-dasharray|pathLength)\s*=/.test(fragment)) {
      return 'stroke-draw';
    }
    return 'fade-in';
  }
  return 'fade-in';
}

/**
 * 给刚插入画布的真 DOM 节点打落画动画 class 与 pathLength="1"。
 */
export function markShapes(top: Element, order: number): void {
  if (typeof SVGElement !== 'undefined' && top instanceof SVGElement) {
    top.style.setProperty('--xmd-draw-order', String(order));
  }

  const walk = (el: Element) => {
    const tag = el.localName || el.tagName;
    if (DEF_TAGS.has(tag)) return;
    if (STROKE_TAGS.has(tag)) {
      if (canTraceStroke(el)) {
        el.setAttribute('pathLength', '1');
        el.classList.add('xmd-svg-stroke');
      }
      if (hasFill(tag, el)) el.classList.add('xmd-svg-fill');
    } else if (tag === 'text' || tag === 'tspan') {
      if (!hasOwnOpacity(el)) el.classList.add('xmd-svg-fade');
    }
    for (const child of Array.from(el.children)) walk(child);
  };
  walk(top);
}

/**
 * 从未闭合的 `<svg ...>` 源码流中切出已经自身闭合的顶层图元并完成白名单净化与动画分类。
 */
export function peekSvgProgress(rawSvgPrefix: string): SvgProgress | null {
  const source = normalizeSvgSource(rawSvgPrefix).trim();
  if (!source) return null;

  const start = source.search(/<svg[\s/>]/i);
  if (start < 0) return null;

  const rootEnd = findTagEnd(source, start);
  if (rootEnd < 0) return null;

  const rootAttrs = sanitizeRoot(source.slice(start, rootEnd + 1));
  if (!/(^|\s)viewBox\s*=/.test(rootAttrs) && !/(^|\s)width\s*=/.test(rootAttrs)) return null;

  const rawPieces = closedTopLevel(source, rootEnd + 1);
  const elements: string[] = [];
  const animations: SvgAnimationKind[] = [];
  const items: SvgProgressItem[] = [];

  for (const rawPiece of rawPieces) {
    const sanitized = sanitizeSvgFragment(rawPiece);
    if (!sanitized.trim()) continue;
    const animation = classifySvgElementAnimation(sanitized);
    const order = items.length;
    elements.push(sanitized);
    animations.push(animation);
    items.push({ raw: rawPiece, svg: sanitized, animation, order });
  }

  return { rootAttrs, elements, animations, items };
}
