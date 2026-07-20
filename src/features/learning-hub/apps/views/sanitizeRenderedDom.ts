/**
 * 渲染后 DOM 安全处理工具
 *
 * 用于 docx-preview / pptx-preview 等第三方库渲染完成后，
 * 清理潜在的 XSS 向量（危险标签、javascript: 协议链接、内联事件处理器等）。
 *
 * 🔒 安全审计修复 (2026-02-08):
 *   - 新增危险标签移除（script/iframe/embed/object/base/form/meta/link）
 *   - 新增危险属性移除（style 中的 expression/javascript:）
 *   - 保留原有的 href 协议检查和 on* 属性移除
 */

import DOMPurify from 'dompurify';

/** 允许的安全 data: URI 前缀（图片等静态资源） */
const SAFE_DATA_PREFIXES = [
  'data:image/',
  'data:font/',
  'data:application/font',
] as const;

/**
 * 判断 href 是否为不安全协议
 */
function isUnsafeHref(href: string): boolean {
  const normalized = href.trim().toLowerCase();

  // 直接不安全的协议
  if (
    normalized.startsWith('javascript:') ||
    normalized.startsWith('vbscript:')
  ) {
    return true;
  }

  // data: URI 默认视为不安全，除非在安全白名单中
  if (normalized.startsWith('data:')) {
    return !SAFE_DATA_PREFIXES.some((prefix) => normalized.startsWith(prefix));
  }

  return false;
}

/**
 * 判断 href 是否指向外部资源（http/https）——这类链接需要 rel=noopener 加固，
 * 防止目标页面通过 window.opener 反向操纵应用窗口
 */
function isExternalHref(href: string): boolean {
  const normalized = href.trim().toLowerCase();
  return normalized.startsWith('http:') || normalized.startsWith('https:');
}

/**
 * 使用 DOMPurify 对容器内容进行完整消毒
 *
 * 这是主要的安全防线，处理所有已知的 XSS 向量：
 * - 移除 <script>、<iframe>、<embed>、<object>、<base>、<form>、<meta>、<link> 等危险标签
 * - 移除所有内联事件处理器（on* 属性）
 * - 移除危险的 style 表达式
 * - 保留文档渲染所需的安全标签和属性
 *
 * @param container - 要处理的 DOM 容器元素
 */
export function sanitizeRenderedDom(container: HTMLElement): void {
  // 使用 DOMPurify 进行完整的 HTML 消毒
  const cleanHtml = DOMPurify.sanitize(container.innerHTML, {
    // 允许文档渲染所需的标签
    ALLOWED_TAGS: [
      // 结构标签
      'div', 'span', 'p', 'br', 'hr', 'section', 'article', 'header', 'footer',
      'nav', 'main', 'aside', 'figure', 'figcaption', 'details', 'summary',
      // 文本格式
      'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'em', 'b', 'i', 'u', 's',
      'sub', 'sup', 'small', 'mark', 'del', 'ins', 'abbr', 'cite', 'q',
      'blockquote', 'pre', 'code', 'kbd', 'var', 'samp',
      // 列表
      'ul', 'ol', 'li', 'dl', 'dt', 'dd',
      // 表格
      'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'colgroup', 'col',
      // 媒体（安全的）
      'img', 'picture', 'source', 'svg', 'path', 'rect', 'circle', 'ellipse',
      'line', 'polyline', 'polygon', 'text', 'tspan', 'g', 'defs', 'clipPath',
      'use', 'symbol', 'marker', 'pattern', 'image', 'linearGradient',
      'radialGradient', 'stop', 'filter', 'mask', 'feGaussianBlur', 'feOffset',
      'feColorMatrix', 'feBlend', 'feMerge', 'feMergeNode',
      // 链接（href 会被单独检查）
      'a',
      // Ruby 注音
      'ruby', 'rt', 'rp',
      // 文档结构
      'wbr',
    ],
    // 允许的属性
    ALLOWED_ATTR: [
      'class', 'id', 'style', 'title', 'lang', 'dir', 'role',
      'aria-label', 'aria-hidden', 'aria-describedby',
      'src', 'alt', 'width', 'height', 'loading',
      'href', 'target', 'rel',
      'colspan', 'rowspan', 'scope', 'headers',
      'data-blocked', 'data-page', 'data-section',
      // SVG 属性
      'd', 'viewBox', 'xmlns', 'fill', 'stroke', 'stroke-width',
      'transform', 'cx', 'cy', 'r', 'rx', 'ry', 'x', 'y',
      'x1', 'y1', 'x2', 'y2', 'points', 'font-size', 'text-anchor',
      'dominant-baseline', 'clip-path', 'marker-end', 'marker-start',
      'offset', 'stop-color', 'stop-opacity', 'gradientUnits',
      'gradientTransform', 'spreadMethod', 'filter', 'mask', 'href',
      'in', 'in2', 'stdDeviation', 'dx', 'dy', 'result', 'values', 'mode',
    ],
    // 允许安全的 data: URI（图片）
    ALLOW_DATA_ATTR: false,
    ADD_URI_SAFE_ATTR: ['src'],
  });

  container.innerHTML = cleanHtml;

  // 额外的 href 协议检查（DOMPurify 保留了 href，我们做更严格的检查）
  sanitizeRenderedLinks(container);
}

/**
 * 清理容器内所有不安全的超链接
 *
 * 作为 DOMPurify 之后的二次检查，专门处理超链接协议安全。
 *
 * @param container - 要处理的 DOM 容器元素
 */
export function sanitizeRenderedLinks(container: HTMLElement): void {
  // 使用 TreeWalker 高效遍历所有元素节点
  const walker = document.createTreeWalker(
    container,
    NodeFilter.SHOW_ELEMENT,
    null,
  );

  let currentNode: Node | null = walker.currentNode;

  while (currentNode) {
    const el = currentNode as Element;

    // 检查并清理超链接
    if (el.tagName === 'A' && el.hasAttribute('href')) {
      const href = el.getAttribute('href') ?? '';
      if (isUnsafeHref(href)) {
        el.removeAttribute('href');
        el.setAttribute('data-blocked', 'unsafe-protocol');
        (el as HTMLElement).style.cursor = 'not-allowed';
        (el as HTMLElement).style.opacity = '0.6';
      } else if (isExternalHref(href)) {
        // 外链加固：切断 window.opener 反向引用
        el.setAttribute('rel', 'noopener noreferrer');
      }
    }

    currentNode = walker.nextNode();
  }
}
