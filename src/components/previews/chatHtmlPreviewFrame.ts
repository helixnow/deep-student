/**
 * 父页面对聊天 HTML 预览帧的接管（帧为 sandbox="allow-same-origin"，无 allow-scripts）。
 *
 * 帧内任何脚本（含 on* 内联处理器）都被沙箱禁止执行；同源只是让父页面能读写帧 DOM：
 * - 自动高度：父页面测量内容高度；
 * - 链接：父页面在帧文档上挂捕获监听，阻止帧内导航，外链交给系统浏览器（openUrl），
 *   页内 #锚点 在帧内滚动。永远不会导航应用自身的 WebView（Android 只有一个 WebView）。
 */

export type PreviewLinkAction =
  | { kind: 'anchor'; id: string }
  | { kind: 'external'; url: string }
  | { kind: 'ignore' };

const EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

/** 判定预览内链接的去向：仅绝对 http(s)/mailto 外链与页内锚点生效，其余一律忽略 */
export function resolvePreviewLink(rawHref: string | null | undefined): PreviewLinkAction {
  const href = (rawHref ?? '').trim();
  if (!href) return { kind: 'ignore' };
  if (href.startsWith('#')) {
    let id = href.slice(1);
    try { id = decodeURIComponent(id); } catch { /* 保留原样 */ }
    return id ? { kind: 'anchor', id } : { kind: 'ignore' };
  }
  let url: URL;
  try {
    // 不提供 base：相对链接（无处可去）解析失败即忽略
    url = new URL(href);
  } catch {
    return { kind: 'ignore' };
  }
  return EXTERNAL_PROTOCOLS.has(url.protocol) ? { kind: 'external', url: url.href } : { kind: 'ignore' };
}

/**
 * 测量内容真实高度。基础样式/页面常把 html/body 钉在 100% 或 100vh，直接取
 * scrollHeight 会被视口高度托底（只涨不缩）；测量时临时解除钉高，并让根元素
 * 成为 BFC（flow-root）以计入子元素外边距，测完同步恢复（不会触发重绘）。
 */
export function measurePreviewContentHeight(doc: Document): number {
  const root = doc.documentElement;
  const body = doc.body;
  if (!root || !body) return 0;
  const saved = {
    rootHeight: root.style.height,
    rootDisplay: root.style.display,
    bodyHeight: body.style.height,
    bodyMinHeight: body.style.minHeight,
  };
  root.style.height = 'auto';
  root.style.display = 'flow-root';
  body.style.height = 'auto';
  body.style.minHeight = '0';
  const height = Math.max(root.getBoundingClientRect().height, body.scrollHeight);
  root.style.height = saved.rootHeight;
  root.style.display = saved.rootDisplay;
  body.style.height = saved.bodyHeight;
  body.style.minHeight = saved.bodyMinHeight;
  return Number.isFinite(height) ? Math.ceil(height) : 0;
}

export interface PreviewFrameHandlers {
  onExternalLink: (url: string) => void;
  /** 内容高度变化（加载、图片到达、宽度变化导致重排） */
  onContentHeight: (height: number) => void;
}

/** 把链接拦截与高度观察挂到已加载的帧文档上，返回清理函数 */
export function attachPreviewFrame(doc: Document, handlers: PreviewFrameHandlers): () => void {
  const view = doc.defaultView;
  let lastHeight = -1;
  const report = () => {
    const h = measurePreviewContentHeight(doc);
    if (h > 0 && h !== lastHeight) {
      lastHeight = h;
      handlers.onContentHeight(h);
    }
  };

  const onClick = (event: Event) => {
    const target = event.target as Element | null;
    const link = target && typeof target.closest === 'function'
      ? target.closest('a[href], area[href]')
      : null;
    if (!link) return;
    // 帧内绝不发生导航
    event.preventDefault();
    if (event.type !== 'click') return;
    const action = resolvePreviewLink(link.getAttribute('href'));
    if (action.kind === 'external') {
      handlers.onExternalLink(action.url);
    } else if (action.kind === 'anchor') {
      const el = doc.getElementById(action.id) ?? doc.getElementsByName(action.id)[0];
      el?.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
    }
  };
  // 图片等资源迟到会改变高度：load 不冒泡，用捕获
  const onResourceLoad = () => report();

  doc.addEventListener('click', onClick, true);
  doc.addEventListener('auxclick', onClick, true);
  doc.addEventListener('load', onResourceLoad, true);

  let ro: ResizeObserver | null = null;
  const RO = (view as (Window & typeof globalThis) | null)?.ResizeObserver ?? globalThis.ResizeObserver;
  if (typeof RO === 'function' && doc.body) {
    ro = new RO(() => report());
    ro.observe(doc.body);
    ro.observe(doc.documentElement);
  }
  report();

  return () => {
    doc.removeEventListener('click', onClick, true);
    doc.removeEventListener('auxclick', onClick, true);
    doc.removeEventListener('load', onResourceLoad, true);
    ro?.disconnect();
  };
}
