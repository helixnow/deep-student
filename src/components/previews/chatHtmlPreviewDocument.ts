import DOMPurify from 'dompurify';

import { getHtmlSandboxCsp } from './htmlSandboxPolicy';

/**
 * 聊天代码块 HTML 预览（chat-safe）的纯函数部分。
 *
 * 安全模型（与 release CSP 对齐，dev/release 行为一致）：
 * - iframe `sandbox=""`：无脚本、无同源、无表单、无弹窗、无顶层导航；
 * - 文档内 CSP meta：default-src 'none'、script-src 'none'、connect-src 'none'；
 * - DOMPurify 剥离 script / on* / iframe / form / link / base；
 * - 链接全部去掉 href（页内 #锚点 保留）：沙箱帧里点击外链只会把预览帧
 *   自身导航走（dev）或撞上 release 的 frame-src 变成错误页，二者都不可用。
 *   帧内不能跑脚本、父页面也读不到跨源帧的 DOM，无法把点击转交给 openUrl。
 */

const RAW_TEXT_ELEMENTS = ['style', 'script', 'textarea', 'title'];
const TRAILING_PARTIAL_ENTITY_RE = /&[#a-zA-Z0-9]*$/;

export interface PartialHtmlRepair {
  html: string;
  /** 已完整前缀长度；未变化时无需重建预览文档 */
  stableLength: number;
}

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

/**
 * 截取流式 HTML 的最长安全前缀：丢弃末尾写到一半的标签/注释、未闭合的
 * `<style>`/`<script>` 等原始文本元素（半截 CSS 会让页面先以错误样式闪烁）
 * 与半截实体。其余未闭合元素交给 HTML 解析器自动闭合。
 */
export function repairPartialHtml(source: string): PartialHtmlRepair {
  let safeEnd = 0;
  let i = 0;
  while (i < source.length) {
    const lt = source.indexOf('<', i);
    if (lt === -1) {
      const tail = source.slice(i).replace(TRAILING_PARTIAL_ENTITY_RE, '');
      safeEnd = i + tail.length;
      break;
    }
    safeEnd = lt;
    const next = source[lt + 1];
    if (next === undefined) break;

    if (source.startsWith('<!--', lt)) {
      const end = source.indexOf('-->', lt + 4);
      if (end === -1) break;
      i = end + 3;
      safeEnd = i;
      continue;
    }
    if (!/[a-zA-Z/!?]/.test(next)) {
      // 文本中的裸 `<`
      i = lt + 1;
      safeEnd = i;
      continue;
    }
    // `<!do` 之类可能还没写完的前缀：等待 `>`
    const tagEnd = findTagEnd(source, lt + 1);
    if (tagEnd === -1) break;
    const tag = source.slice(lt, tagEnd + 1);
    const nameMatch = /^<\s*([a-zA-Z][^\s/>]*)/.exec(tag);
    const name = nameMatch?.[1].toLowerCase();
    if (name && RAW_TEXT_ELEMENTS.includes(name) && !/\/\s*>$/.test(tag)) {
      const closeRe = new RegExp(`</\\s*${name}\\s*>`, 'ig');
      closeRe.lastIndex = tagEnd + 1;
      const close = closeRe.exec(source);
      if (!close) break; // 停在未闭合原始文本元素之前
      i = close.index + close[0].length;
      safeEnd = i;
      continue;
    }
    i = tagEnd + 1;
    safeEnd = i;
  }
  return { html: source.slice(0, safeEnd), stableLength: safeEnd };
}

const FULL_DOCUMENT_RE = /^\s*(?:<!--[\s\S]*?-->\s*)*(?:<!doctype\s+html|<html[\s>])/i;

/** 是否为完整 HTML 文档（含流式中刚写出的 `<!DOCTYPE` 前缀） */
export function looksLikeHtmlDocument(source: string): boolean {
  if (FULL_DOCUMENT_RE.test(source)) return true;
  const head = source.trimStart().slice(0, 15).toLowerCase();
  if (head.length >= 2 && head.startsWith('<!') && '<!doctype html'.startsWith(head)) return true;
  return head.length >= 3 && '<html'.startsWith(head);
}

/**
 * 默认展示预览还是源码：完整文档、或自带 <style> 的片段（明显是"做出来看"的页面）
 * 默认预览；普通片段（教程里的 HTML 示例）默认源码，可从菜单切换。
 */
export function shouldAutoPreviewHtml(source: string): boolean {
  return looksLikeHtmlDocument(source) || /<style[\s>]/i.test(source);
}

/** 源码是否依赖脚本（预览里不会执行，需要提示用户） */
export function htmlUsesScripts(source: string): boolean {
  return /<script[\s>]/i.test(source) || /<[a-z][^>]*\son[a-z]+\s*=/i.test(source);
}

const CHAT_PREVIEW_BASE_CSS = `
  html { -webkit-text-size-adjust: 100%; text-size-adjust: 100%; overscroll-behavior: auto; }
  body { margin: 0; overflow-wrap: break-word; }
  body.ds-fragment {
    padding: 14px 16px;
    font: 14px/1.6 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }
  body.ds-fragment img, body.ds-fragment video, body.ds-fragment canvas { max-width: 100%; height: auto; }
  a:not([href]) { cursor: default; }
`;

function sanitizeChatHtml(html: string, isFullDoc: boolean): Document {
  const sanitized = DOMPurify.sanitize(html, {
    WHOLE_DOCUMENT: isFullDoc,
    ADD_TAGS: ['style'],
    FORBID_TAGS: ['script', 'iframe', 'frame', 'embed', 'object', 'form', 'base', 'link', 'meta', 'portal'],
    FORBID_ATTR: ['onerror', 'onload', 'onclick', 'onmouseover', 'onfocus', 'onblur', 'target', 'ping', 'formaction', 'srcdoc'],
    ALLOW_DATA_ATTR: false,
  });
  // DOMParser 生成的是惰性文档：不执行脚本、不加载资源
  const doc = new DOMParser().parseFromString(
    isFullDoc ? sanitized : `<!DOCTYPE html><html><head></head><body>${sanitized}</body></html>`,
    'text/html',
  );
  doc.querySelectorAll('a[href], area[href]').forEach((el) => {
    const href = el.getAttribute('href') ?? '';
    if (href.trim().startsWith('#')) return;
    el.removeAttribute('href');
    if (href && !el.getAttribute('title')) el.setAttribute('title', href);
  });
  return doc;
}

function serializeAttributes(el: Element): string {
  return Array.from(el.attributes)
    .map((attr) => ` ${attr.name}="${attr.value.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"`)
    .join('');
}

/**
 * 生成聊天 HTML 预览的完整 srcdoc 文档。完整文档保留其 <head> 里的样式与
 * <html>/<body> 属性；片段放进带基础排版的 body。
 */
export function buildChatHtmlPreviewDocument(html: string): string {
  const isFullDoc = looksLikeHtmlDocument(html);
  const doc = sanitizeChatHtml(html, isFullDoc);
  const headExtras = Array.from(doc.head.children)
    .filter((el) => el.tagName === 'STYLE' || el.tagName === 'TITLE')
    .map((el) => el.outerHTML)
    .join('\n');
  const htmlAttrs = isFullDoc ? serializeAttributes(doc.documentElement) : '';
  const bodyAttrs = isFullDoc ? serializeAttributes(doc.body) : ' class="ds-fragment"';
  const csp = getHtmlSandboxCsp('chat-safe');

  return `<!DOCTYPE html>
<html${htmlAttrs}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>${CHAT_PREVIEW_BASE_CSS}</style>
${headExtras}
</head>
<body${bodyAttrs}>
${doc.body.innerHTML}
</body>
</html>`;
}

// ============================================================================
// 双缓冲：新文档先在隐藏 iframe 里加载，load 后再与前台交换——预览永不闪白。
// 每个 iframe 只加载一次 srcdoc（WebKit 对同一 iframe 的快速连续 srcdoc 更新
// 会漏掉重载，见 HtmlSandboxPreview 注释），加载中到达的更新只保留最新一份。
// ============================================================================

export interface HtmlPreviewSlot {
  key: number;
  doc: string;
}

export interface HtmlPreviewBufferState {
  front: HtmlPreviewSlot | null;
  loading: HtmlPreviewSlot | null;
  pending: string | null;
  nextKey: number;
}

export type HtmlPreviewBufferAction =
  | { type: 'submit'; doc: string }
  | { type: 'loaded'; key: number };

export const INITIAL_HTML_PREVIEW_BUFFER: HtmlPreviewBufferState = {
  front: null,
  loading: null,
  pending: null,
  nextKey: 1,
};

export function htmlPreviewBufferReducer(
  state: HtmlPreviewBufferState,
  action: HtmlPreviewBufferAction,
): HtmlPreviewBufferState {
  if (action.type === 'submit') {
    const { doc } = action;
    if (!state.front) {
      return { ...state, front: { key: state.nextKey, doc }, nextKey: state.nextKey + 1 };
    }
    if (state.loading) {
      if (state.loading.doc === doc) return state.pending === null ? state : { ...state, pending: null };
      return state.pending === doc ? state : { ...state, pending: doc };
    }
    if (state.front.doc === doc) return state;
    return { ...state, loading: { key: state.nextKey, doc }, nextKey: state.nextKey + 1 };
  }

  if (!state.loading || state.loading.key !== action.key) return state;
  const front = state.loading;
  if (state.pending !== null && state.pending !== front.doc) {
    return {
      front,
      loading: { key: state.nextKey, doc: state.pending },
      pending: null,
      nextKey: state.nextKey + 1,
    };
  }
  return { ...state, front, loading: null, pending: null };
}
