import DOMPurify from 'dompurify';

/**
 * 流式 SVG 渐进渲染的纯函数部分。
 *
 * 流式输出中的 SVG 源码在任意字符处被截断（属性写到一半、`<path d="M0 0 L1`、
 * 未闭合的 `<g>`）。这里把"最长的已完整前缀"修复成一份良构 SVG：
 *   1. 丢弃末尾未写完的标签 / 注释 / CDATA / 未闭合的 <style>（半截 CSS 会让
 *      后续元素先以错误样式闪一下）；
 *   2. 丢弃末尾半截实体（`&am`）；
 *   3. 为仍打开的元素按栈逆序补闭合标签。
 * `stableLength` 是已完整前缀的长度——只有它变化（又有标签写完）才值得重渲染。
 */

export interface PartialSvgRepair {
  /** 可直接交给消毒器的良构 SVG 片段（根 <svg> 起始） */
  markup: string;
  /** 根 <svg> 是否已在源码中真正闭合 */
  complete: boolean;
  /** 已完整前缀在源码中的结束位置；未变化时无需重渲染 */
  stableLength: number;
}

const RAW_TEXT_ELEMENTS = new Set(['style', 'script']);

const SVG_ROOT_RE = /<svg(?=[\s/>])/i;
const TRAILING_PARTIAL_ENTITY_RE = /&[#a-zA-Z0-9]*$/;

/** 找到从 `from` 开始、尊重引号的标签结束 `>` 位置；不存在返回 -1 */
function findTagEnd(source: string, from: number): number {
  let quote: string | null = null;
  for (let i = from; i < source.length; i += 1) {
    const ch = source[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '>') {
      return i;
    }
  }
  return -1;
}

function tagName(tag: string, closing: boolean): string {
  const match = (closing ? /^<\/\s*([^\s/>]+)/ : /^<\s*([^\s/>]+)/).exec(tag);
  return match ? match[1] : '';
}

/**
 * 修复一段（可能被截断的）SVG 源码。根 `<svg …>` 起始标签尚未写完时返回 null。
 */
export function repairPartialSvg(source: string): PartialSvgRepair | null {
  const rootMatch = SVG_ROOT_RE.exec(source);
  if (!rootMatch) return null;
  const start = rootMatch.index;

  const stack: string[] = [];
  let safeEnd = start;
  let i = start;
  let complete = false;

  while (i < source.length) {
    const lt = source.indexOf('<', i);
    if (lt === -1) {
      // 末尾是一段文本（可能是 <text> 里正在输出的字）：保留，去掉半截实体
      const tail = source.slice(i).replace(TRAILING_PARTIAL_ENTITY_RE, '');
      safeEnd = i + tail.length;
      break;
    }
    // `<` 之前的文本已完整
    safeEnd = lt;

    if (source.startsWith('<!--', lt)) {
      const end = source.indexOf('-->', lt + 4);
      if (end === -1) break;
      i = end + 3;
      safeEnd = i;
      continue;
    }
    if (source.startsWith('<![CDATA[', lt)) {
      const end = source.indexOf(']]>', lt + 9);
      if (end === -1) break;
      i = end + 3;
      safeEnd = i;
      continue;
    }
    if (source.startsWith('<?', lt)) {
      const end = source.indexOf('?>', lt + 2);
      if (end === -1) break;
      i = end + 2;
      safeEnd = i;
      continue;
    }

    const tagEnd = findTagEnd(source, lt + 1);
    if (tagEnd === -1) break;
    const tag = source.slice(lt, tagEnd + 1);

    if (tag.startsWith('<!')) {
      // DOCTYPE 等声明：跳过
      i = tagEnd + 1;
      safeEnd = i;
      continue;
    }

    if (tag.startsWith('</')) {
      const name = tagName(tag, true).toLowerCase();
      const idx = stack.lastIndexOf(name);
      if (idx !== -1) stack.length = idx;
      i = tagEnd + 1;
      safeEnd = i;
      if (stack.length === 0) {
        complete = true;
        break;
      }
      continue;
    }

    const rawName = tagName(tag, false);
    const name = rawName.toLowerCase();
    const selfClosing = /\/\s*>$/.test(tag);
    if (!name) {
      // `< ` 这类非标签：当作文本继续
      i = lt + 1;
      continue;
    }

    if (!selfClosing && RAW_TEXT_ELEMENTS.has(name)) {
      // 原始文本元素：内容里的 `<` 不是标签，直接找对应的闭合标签
      const closeRe = new RegExp(`</\\s*${name}\\s*>`, 'ig');
      closeRe.lastIndex = tagEnd + 1;
      const close = closeRe.exec(source);
      if (!close) {
        // 未写完的 <style>：整段丢弃（停在它之前）
        safeEnd = lt;
        break;
      }
      i = close.index + close[0].length;
      safeEnd = i;
      continue;
    }

    i = tagEnd + 1;
    safeEnd = i;
    if (!selfClosing) {
      stack.push(name);
    } else if (lt === start) {
      // 自闭合的根 <svg … />
      complete = true;
      break;
    }
  }

  // 根起始标签都没写完：还没有可渲染的内容
  if (stack.length === 0 && !complete) {
    return null;
  }

  const prefix = source.slice(start, safeEnd);
  const closers = complete
    ? ''
    : stack.slice().reverse().map((name) => `</${name}>`).join('');
  return {
    markup: prefix + closers,
    complete,
    stableLength: safeEnd,
  };
}

/** 聊天内联 SVG 的统一消毒配置（与原 handleRunSvg 一致） */
export function sanitizeSvgMarkup(markup: string): string {
  return DOMPurify.sanitize(markup, {
    USE_PROFILES: { svg: true, svgFilters: true },
    ADD_TAGS: ['style'],
    FORBID_TAGS: ['script', 'foreignObject', 'iframe', 'embed', 'object'],
    FORBID_ATTR: ['xlink:href'],
  });
}

export interface SvgIntrinsicSize {
  width: number;
  height: number;
  /** 尺寸来源：viewBox 或 width/height 属性 */
  source: 'viewBox' | 'attributes';
}

function readAttr(tag: string, attr: string): string | null {
  const re = new RegExp(`\\s${attr}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
  const match = re.exec(tag);
  if (!match) return null;
  return (match[2] ?? match[3] ?? match[4] ?? '').trim();
}

function parseLength(value: string | null): number {
  if (!value) return 0;
  // 百分比等相对单位无法提供固有尺寸
  if (/%|em|ex|vw|vh/i.test(value)) return 0;
  const n = parseFloat(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * 从根 `<svg>` 起始标签读出固有尺寸（优先 viewBox）。流式时根标签最先写完，
 * 首帧就能预留稳定高度，后续帧不再跳动。
 */
export function readSvgIntrinsicSize(markup: string): SvgIntrinsicSize | null {
  const rootMatch = SVG_ROOT_RE.exec(markup);
  if (!rootMatch) return null;
  const end = findTagEnd(markup, rootMatch.index + 1);
  if (end === -1) return null;
  const tag = markup.slice(rootMatch.index, end + 1);

  const viewBox = readAttr(tag, 'viewBox');
  if (viewBox) {
    const parts = viewBox.split(/[\s,]+/).map(Number);
    if (parts.length === 4 && parts.every(Number.isFinite) && parts[2] > 0 && parts[3] > 0) {
      return { width: parts[2], height: parts[3], source: 'viewBox' };
    }
  }
  const width = parseLength(readAttr(tag, 'width'));
  const height = parseLength(readAttr(tag, 'height'));
  if (width > 0 && height > 0) {
    return { width, height, source: 'attributes' };
  }
  return null;
}

/** 下载/栅格化需要独立 SVG 文件：缺 xmlns 时补上（否则浏览器按 XML 打开会报错） */
export function ensureSvgNamespace(markup: string): string {
  const rootMatch = SVG_ROOT_RE.exec(markup);
  if (!rootMatch) return markup;
  const end = findTagEnd(markup, rootMatch.index + 1);
  if (end === -1) return markup;
  const tag = markup.slice(rootMatch.index, end + 1);
  if (/\sxmlns\s*=/.test(tag)) return markup;
  const insertAt = rootMatch.index + 4;
  return `${markup.slice(0, insertAt)} xmlns="http://www.w3.org/2000/svg"${markup.slice(insertAt)}`;
}

/**
 * 流式中一帧的渲染结果：修复 + 消毒。消毒后为空（异常输入）返回 null，
 * 调用方保留上一帧。
 */
export function buildSvgFrame(source: string): { markup: string; stableLength: number; complete: boolean } | null {
  const repaired = repairPartialSvg(source);
  if (!repaired) return null;
  const markup = sanitizeSvgMarkup(repaired.markup);
  if (!/<svg[\s>]/i.test(markup)) return null;
  return { markup, stableLength: repaired.stableLength, complete: repaired.complete };
}
